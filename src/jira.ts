import { tool } from "ai";
import { z } from "zod";

/**
 * Jira Cloud, per person: each account connects its own Atlassian site with its own API token, so every ticket the
 * assistant reads, creates or comments on is done AS that person - Jira's own permissions and history apply.
 *
 * A project links to one Jira project key (projects.ts). In a session of that project the assistant gets the Jira
 * tools below, all held to that one key: it cannot read or touch any other Jira project of the person. Reading needs
 * no approval; creating, commenting and moving a ticket wait for the same approval as a change to the site.
 *
 * Only Jira Cloud (https://<name>.atlassian.net): the backend may run on a public server, and an address the person
 * types must never let it call something inside a private network.
 */
export interface JiraConnection { siteUrl: string; email: string; token: string; accountName?: string }

export class JiraError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "JiraError"; }
}

/** "acme" / "acme.atlassian.net" / "https://acme.atlassian.net/jira/..." -> "https://acme.atlassian.net", or null. */
export function jiraSite(input: string): string | null {
  // Tests only: a fake Jira on this machine (LC_JIRA_TEST_URL=http://127.0.0.1:port). Never set on a server.
  const testUrl = process.env.LC_JIRA_TEST_URL;
  if (testUrl && String(input ?? "").trim().replace(/\/+$/, "") === testUrl) return testUrl;
  const s = String(input ?? "").trim().replace(/^https?:\/\//i, "").split(/[/?#]/)[0].toLowerCase();
  const host = /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? `${s}.atlassian.net` : s;
  return /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host) ? `https://${host}` : null;
}

export const KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;
const ISSUE_RE = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;

/* ---------------------------------------------------------------- Atlassian Document Format <-> text */

/** Plain text (paragraphs split on blank lines, "- " lines as a bullet list) as an ADF document. */
export function toAdf(text: string) {
  const blocks: any[] = [];
  for (const para of String(text ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    const lines = para.split("\n");
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      blocks.push({ type: "bulletList", content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: l.replace(/^\s*[-*] /, "") }] }] })) });
    } else {
      const content: any[] = [];
      lines.forEach((l, i) => { if (i) content.push({ type: "hardBreak" }); if (l) content.push({ type: "text", text: l }); });
      blocks.push({ type: "paragraph", content });
    }
  }
  return { type: "doc", version: 1, content: blocks.length ? blocks : [{ type: "paragraph", content: [] }] };
}

/** An ADF document (or anything Jira returns for a rich-text field) as plain text. */
export function fromAdf(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(fromAdf).join("");
  if (node.type === "text") return String(node.text ?? "");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return String(node.attrs?.text ?? "@someone");
  const inner = fromAdf(node.content ?? []);
  if (node.type === "listItem") return "- " + inner.trim() + "\n";
  if (["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "table", "tableRow"].includes(node.type)) return inner.replace(/\n*$/, "") + "\n\n";
  return inner;
}

/* ---------------------------------------------------------------- the client */

export class JiraClient {
  constructor(private c: JiraConnection, private fetchImpl: typeof fetch = fetch) {}
  get site() { return this.c.siteUrl; }

  async call<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.c.siteUrl + path, {
        method,
        headers: { Authorization: "Basic " + Buffer.from(`${this.c.email}:${this.c.token}`).toString("base64"), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch (e) { throw new JiraError(0, `Jira did not answer (${(e as Error).message}).`); }
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const why = data?.errorMessages?.join(" ") || Object.values(data?.errors ?? {}).join(" ") || text.slice(0, 200);
      throw new JiraError(res.status, res.status === 401 ? "Jira refused the email or API token." : res.status === 403 ? `Jira says you may not do that: ${why}` : res.status === 404 ? `Jira does not know that (or you cannot see it): ${why}` : `Jira error ${res.status}: ${why}`);
    }
    return data as T;
  }

  myself() { return this.call<{ accountId: string; displayName: string; emailAddress?: string }>("GET", "/rest/api/3/myself"); }

  async project(key: string) {
    if (!KEY_RE.test(key)) throw new JiraError(400, `"${key}" is not a Jira project key (like ACME or WEB).`);
    const p = await this.call<any>("GET", `/rest/api/3/project/${key}`);
    return { key: p.key as string, name: p.name as string, issueTypes: (p.issueTypes ?? []).filter((t: any) => !t.subtask).map((t: any) => t.name as string) };
  }

  async projects(query = "") {
    const r = await this.call<any>("GET", `/rest/api/3/project/search?maxResults=50&orderBy=name${query ? `&query=${encodeURIComponent(query)}` : ""}`);
    return (r.values ?? []).map((p: any) => ({ key: p.key as string, name: p.name as string }));
  }

  async search(jql: string, max = 20) {
    const fields = "summary,status,assignee,priority,issuetype,updated,labels";
    const r = await this.call<any>("GET", `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(Math.max(1, max), 50)}&fields=${fields}`);
    return (r.issues ?? []).map(brief);
  }

  async issue(key: string) {
    const i = await this.call<any>("GET", `/rest/api/3/issue/${key}?fields=summary,status,assignee,reporter,priority,issuetype,labels,created,updated,description,comment`);
    const f = i.fields ?? {};
    return {
      ...brief(i),
      reporter: f.reporter?.displayName ?? null,
      created: f.created,
      description: fromAdf(f.description).trim().slice(0, 8000),
      comments: (f.comment?.comments ?? []).slice(-15).map((c: any) => ({ by: c.author?.displayName, at: c.created, text: fromAdf(c.body).trim().slice(0, 2000) })),
      url: `${this.c.siteUrl}/browse/${i.key}`,
    };
  }

  async create(projectKey: string, a: { summary: string; description?: string; issueType?: string; priority?: string; labels?: string[] }) {
    const fields: any = { project: { key: projectKey }, summary: a.summary.slice(0, 250), issuetype: { name: a.issueType || "Task" } };
    if (a.description) fields.description = toAdf(a.description);
    if (a.priority) fields.priority = { name: a.priority };
    if (a.labels?.length) fields.labels = a.labels.map((l) => l.replace(/\s+/g, "-").slice(0, 60));
    const r = await this.call<any>("POST", "/rest/api/3/issue", { fields });
    return { key: r.key as string, url: `${this.c.siteUrl}/browse/${r.key}` };
  }

  async comment(key: string, text: string) {
    const r = await this.call<any>("POST", `/rest/api/3/issue/${key}/comment`, { body: toAdf(text) });
    return { id: r.id as string, url: `${this.c.siteUrl}/browse/${key}?focusedCommentId=${r.id}` };
  }

  async transitions(key: string) {
    const r = await this.call<any>("GET", `/rest/api/3/issue/${key}/transitions`);
    return (r.transitions ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name), to: String(t.to?.name ?? t.name) }));
  }

  async move(key: string, to: string) {
    const all = await this.transitions(key);
    const want = to.trim().toLowerCase();
    const t = all.find((x: any) => x.name.toLowerCase() === want || x.to.toLowerCase() === want || x.id === to);
    if (!t) throw new JiraError(400, `"${to}" is not a step this ticket can take now. It can go to: ${all.map((x: any) => x.to).join(", ") || "nowhere"}.`);
    await this.call("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    return { to: t.to };
  }
}

const brief = (i: any) => ({
  key: i.key as string,
  summary: i.fields?.summary ?? "",
  status: i.fields?.status?.name ?? "",
  type: i.fields?.issuetype?.name ?? "",
  priority: i.fields?.priority?.name ?? null,
  assignee: i.fields?.assignee?.displayName ?? null,
  labels: i.fields?.labels ?? [],
  updated: i.fields?.updated,
});

/* ---------------------------------------------------------------- the assistant's Jira tools */

/** What a session lends the tools: whose Jira, and the one project key they are held to. */
export interface JiraContext { connection: JiraConnection; projectKey: string; fetchImpl?: typeof fetch }

export const JIRA_WRITE_TOOLS = ["jira_create_issue", "jira_comment", "jira_move_issue"] as const;

export function jiraTools(ctx: JiraContext) {
  const jira = new JiraClient(ctx.connection, ctx.fetchImpl);
  const key = ctx.projectKey;
  const inProject = (issue: string) => {
    const k = String(issue ?? "").trim().toUpperCase();
    if (!ISSUE_RE.test(k)) throw new JiraError(400, `"${issue}" is not a ticket key (like ${key}-12).`);
    if (!k.startsWith(key + "-")) throw new JiraError(403, `${k} is not in this project's Jira project (${key}). Only ${key} tickets can be used here.`);
    return k;
  };
  const safe = async (fn: () => Promise<unknown>) => {
    try { return { ok: true, ...(await fn() as object) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  };
  return {
    jira_search: tool({
      description: `Find tickets in Jira project ${key} by words, status, type, label, or the person's own. Newest first.`,
      // Filters, not free JQL: a JQL condition from the model could close the bracket and OR its way into another
      // project. Every value below is quoted, and a result outside ${key} is dropped all the same.
      inputSchema: z.object({
        text: z.string().optional().describe("words in the summary or description"),
        status: z.string().optional().describe('e.g. "To Do", "In Progress", "Done"'),
        type: z.string().optional().describe("e.g. Bug, Task, Story"),
        label: z.string().optional(),
        mine: z.boolean().optional().describe("only tickets assigned to the person"),
        open: z.boolean().optional().describe("only tickets that are not done"),
        max: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ text, status, type, label, mine, open, max }) => safe(async () => {
        const q = (s: string) => `"${s.replace(/["\\]/g, " ").slice(0, 120)}"`;
        const parts = [`project = ${q(key)}`];
        if (text) parts.push(`text ~ ${q(text)}`);
        if (status) parts.push(`status = ${q(status)}`);
        if (type) parts.push(`issuetype = ${q(type)}`);
        if (label) parts.push(`labels = ${q(label)}`);
        if (mine) parts.push("assignee = currentUser()");
        if (open) parts.push("statusCategory != Done");
        const issues = (await jira.search(parts.join(" AND ") + " ORDER BY updated DESC", max ?? 20)).filter((i: any) => i.key.startsWith(key + "-"));
        return { project: key, issues };
      }),
    }),
    jira_get_issue: tool({
      description: `Read one ticket of ${key}: summary, status, description and the latest comments.`,
      inputSchema: z.object({ issue: z.string().describe(`the ticket key, like ${key}-12`) }),
      execute: async ({ issue }) => safe(async () => ({ issue: await jira.issue(inProject(issue)) })),
    }),
    jira_list_moves: tool({
      description: "The statuses a ticket can be moved to right now.",
      inputSchema: z.object({ issue: z.string() }),
      execute: async ({ issue }) => safe(async () => ({ moves: await jira.transitions(inProject(issue)) })),
    }),
    jira_create_issue: tool({
      description: `Create a ticket in ${key}, as the person. Needs their approval. Write the description in plain text (blank line = new paragraph, "- " lines = a list).`,
      inputSchema: z.object({
        summary: z.string().min(3).max(250),
        description: z.string().max(20_000).optional(),
        issueType: z.string().optional().describe('default "Task"; e.g. Bug, Story'),
        priority: z.string().optional(),
        labels: z.array(z.string()).max(10).optional(),
        reason: z.string().optional().describe("one line for the person: why this ticket"),
      }),
      execute: async ({ summary, description, issueType, priority, labels }) => safe(async () => ({ created: await jira.create(key, { summary, description, issueType, priority, labels }) })),
    }),
    jira_comment: tool({
      description: `Add a comment to a ${key} ticket, as the person. Needs their approval.`,
      inputSchema: z.object({ issue: z.string(), text: z.string().min(1).max(20_000), reason: z.string().optional() }),
      execute: async ({ issue, text }) => safe(async () => ({ comment: await jira.comment(inProject(issue), text) })),
    }),
    jira_move_issue: tool({
      description: `Move a ${key} ticket to another status (e.g. "In Progress", "Done"), as the person. Needs their approval. jira_list_moves shows what is possible.`,
      inputSchema: z.object({ issue: z.string(), to: z.string(), reason: z.string().optional() }),
      execute: async ({ issue, to }) => safe(async () => { const k = inProject(issue); return { issue: k, ...(await jira.move(k, to)) }; }),
    }),
  };
}
