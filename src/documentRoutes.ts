import { overLimit } from "./accounts.js";
import { jiraOwner, type RouteContext } from "./adminRoutes.js";
import { callerName, canUseSite, isStaff } from "./auth.js";
import { config } from "./config.js";
import { documents, MAX_DOC_BYTES, sessionPrompt, ticketText, type ProjectDocument } from "./documents.js";
import { JiraClient } from "./jira.js";
import { projects, type Project } from "./projects.js";
import { secrets } from "./secrets.js";
import { log } from "./usage.js";

/**
 * A project's documents (documents.ts), for owners and developers:
 *
 *   GET    /projects/:id/documents            the list
 *   POST   /projects/:id/documents            upload (raw body, X-Filename header) - read and analysed in the background
 *   GET    /documents/:id                     one document with its summary and tasks
 *   POST   /documents/:id/analyze             read it again (e.g. with another model)
 *   DELETE /documents/:id
 *   POST   /documents/:id/tickets             {taskIds} - one Jira ticket per task, as the person, in the project's key
 *   POST   /documents/:id/tasks/:t/session    start a session on the site for one task
 *   PATCH  /documents/:id/tasks/:t            {dismissed}
 *
 * Reading a document does nothing to the site or to Jira. Every ticket and every session starts from a person's click.
 */
export async function handleDocumentRoutes(c: RouteContext): Promise<boolean> {
  const { req, res, url, caller, send, readJson } = c;
  const pm = url.pathname.match(/^\/projects\/(prj_\w+)\/documents$/);
  const dm = url.pathname.match(/^\/documents\/(doc_\w+)(?:\/(analyze|tickets|tasks\/(t\d+)(?:\/(session))?))?$/);
  if (!pm && !dm) return false;
  if (!isStaff(caller)) return send(res, 403, { error: "Documents are for owners and developers." }), true;

  const projectOk = (p?: Project) => !!p && canUseSite(caller, p.siteId);
  const modelFor = (p?: Project) => p?.model || config.model;

  if (pm) {
    const p = projects.get(pm[1]);
    if (!projectOk(p)) return send(res, 404, { error: "Unknown project." }), true;
    if (req.method === "GET") return send(res, 200, { documents: documents.forProject(p!.id).map(brief) }), true;
    if (req.method === "POST") {
      const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "")).trim();
      if (!filename) return send(res, 400, { error: "Name the file (X-Filename header)." }), true;
      let bytes: Buffer;
      try { bytes = await c.readBody(req, MAX_DOC_BYTES); } catch { return send(res, 413, { error: "That file is over 15 MB." }), true; }
      try {
        const d = documents.add({ projectId: p!.id, siteId: p!.siteId, filename, bytes, uploadedBy: callerName(caller), accountId: caller.via === "account" ? caller.account.id : undefined, model: modelFor(p) });
        log("info", "document uploaded", { doc: d.id, project: p!.id, bytes: d.bytes, by: callerName(caller) });
        return send(res, 202, brief(d)), true;
      } catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
    }
    return send(res, 405, { error: "Method not allowed" }), true;
  }

  const d = documents.get(dm![1]);
  const p = d ? projects.get(d.projectId) : undefined;
  if (!d || !projectOk(p)) return send(res, 404, { error: "Unknown document." }), true;
  const [, , action, taskId, sub] = dm!;

  if (!action && req.method === "GET") return send(res, 200, { ...d, text: documents.textOf(d.id).slice(0, 4000) }), true;
  if (!action && req.method === "DELETE") { documents.delete(d.id); log("info", "document deleted", { doc: d.id, by: callerName(caller) }); return send(res, 200, { ok: true }), true; }
  if (action === "analyze" && req.method === "POST") {
    if (d.status === "reading" || d.status === "analysing") return send(res, 409, { error: "It is being read right now." }), true;
    void documents.analyse(d.id, String((await readJson(req)).model || modelFor(p)));
    return send(res, 202, brief({ ...d, status: "analysing" })), true;
  }

  if (action === "tickets" && req.method === "POST") {
    if (!p!.jira?.projectKey) return send(res, 400, { error: "Link this project to a Jira project first (project settings → Jira)." }), true;
    const conn = secrets.jira(jiraOwner(caller));
    if (!conn) return send(res, 400, { error: "Connect your Jira first (account menu → Jira). Tickets are filed as you." }), true;
    const ids = new Set<string>((await readJson(req)).taskIds ?? []);
    const jira = new JiraClient(conn);
    const created: { taskId: string; key: string; url: string }[] = [], failed: { taskId: string; error: string }[] = [];
    // One at a time, in order: a Jira site rate-limits bursts, and a half-done batch must say exactly what was filed.
    for (const t of d.tasks ?? []) {
      if (!ids.has(t.id) || t.jiraKey || t.dismissed) continue;
      try {
        const r = await jira.create(p!.jira.projectKey, { summary: t.title, description: ticketText(d, t), issueType: "Task", labels: ["livecrafts", "maintenance", t.frequency.replace(/\s+/g, "-")] });
        t.jiraKey = r.key; t.jiraUrl = r.url;
        created.push({ taskId: t.id, key: r.key, url: r.url });
        documents.save(d);
      } catch (e) { failed.push({ taskId: t.id, error: (e as Error).message }); }
    }
    log("info", "document tickets filed", { doc: d.id, created: created.length, failed: failed.length, by: callerName(caller) });
    return send(res, created.length || !failed.length ? 200 : 502, { created, failed, document: d }), true;
  }

  const t = taskId ? d.tasks?.find((x) => x.id === taskId) : undefined;
  if (taskId && !t) return send(res, 404, { error: "Unknown task." }), true;
  if (t && sub === "session" && req.method === "POST") {
    if (t.jobId && c.runner.get(t.jobId)) return send(res, 409, { error: "This task already has a session.", jobId: t.jobId }), true;
    const limit = caller.via === "account" ? overLimit(caller.account) : null;
    if (limit) return send(res, 429, { error: limit }), true;
    const job = c.runner.create(p!.siteId, sessionPrompt(d, t), undefined, [], {
      projectId: p!.id, approvalMode: p!.approvalMode,
      account: caller.via === "account" ? { id: caller.account.id, name: caller.account.name } : undefined,
    });
    t.jobId = job.id;
    documents.save(d);
    return send(res, 201, { jobId: job.id, document: d }), true;
  }
  if (t && !sub && req.method === "PATCH") {
    t.dismissed = !!(await readJson(req)).dismissed || undefined;
    documents.save(d);
    return send(res, 200, d), true;
  }
  return send(res, 405, { error: "Method not allowed" }), true;
}

/** A document in a list: no text, no task details. */
function brief(d: ProjectDocument) {
  const tasks = d.tasks ?? [];
  return { id: d.id, projectId: d.projectId, filename: d.filename, bytes: d.bytes, status: d.status, error: d.error, uploadedBy: d.uploadedBy, createdAt: d.createdAt, updatedAt: d.updatedAt,
    tasks: tasks.length, ticketed: tasks.filter((t) => t.jiraKey).length, sessions: tasks.filter((t) => t.jobId).length, summary: d.analysis?.summary?.slice(0, 300) };
}
