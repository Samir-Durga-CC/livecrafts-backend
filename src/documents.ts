import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { z } from "zod";
import { resolveModel } from "./agent.js";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import { log, recordUsage, tokensOf } from "./usage.js";

/**
 * Documents of a project - first of all the client's AMC (annual maintenance contract): upload it, and a background
 * job reads it and turns what the contract promises into a task list. Nothing happens to the site or in Jira from
 * reading alone: a person picks tasks and says what to do with them (a Jira ticket each, or a session on the site).
 *
 * The analysis is asked for as JSON and checked against a schema, with one retry - every provider can do that,
 * including the Claude CLI, which has no structured-output mode.
 */
export const DOC_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};
export const MAX_DOC_BYTES = 15 * 1024 * 1024;
/** What the model reads at most. An AMC is a few pages; a 300-page manual is cut, and the analysis says so. */
const MAX_CHARS = 120_000;

const Task = z.object({
  title: z.string().min(3).max(200),
  detail: z.string().max(2000).default(""),
  kind: z.enum(["site", "ticket"]),
  frequency: z.enum(["once", "weekly", "monthly", "quarterly", "yearly", "on request"]).default("once"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  source: z.string().max(400).default(""),
});
const Analysis = z.object({
  summary: z.string().max(3000),
  contract: z.object({
    client: z.string().max(200).optional(),
    provider: z.string().max(200).optional(),
    period: z.string().max(200).optional(),
    services: z.array(z.string().max(300)).max(40).default([]),
    responseTimes: z.array(z.string().max(300)).max(20).default([]),
    exclusions: z.array(z.string().max(300)).max(30).default([]),
    reporting: z.string().max(500).optional(),
  }).default({ services: [], responseTimes: [], exclusions: [] }),
  tasks: z.array(Task).max(80),
});
export type DocAnalysis = z.infer<typeof Analysis> & { truncated?: boolean; model: string; ms: number };
export interface DocTask extends z.infer<typeof Task> { id: string; jiraKey?: string; jiraUrl?: string; jobId?: string; dismissed?: boolean }

export interface ProjectDocument {
  id: string;
  projectId: string;
  siteId: string;
  filename: string;
  mime: string;
  bytes: number;
  uploadedBy: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  status: "reading" | "analysing" | "ready" | "failed";
  error?: string;
  chars?: number;
  analysis?: Omit<DocAnalysis, "tasks">;
  tasks?: DocTask[];
}

const dir = (...p: string[]) => { const d = path.join(config.dataDir, "documents", ...p); fs.mkdirSync(d, { recursive: true }); return d; };

/** Plain text out of a PDF, a Word file, or text. */
export async function extractText(buf: Buffer, ext: string): Promise<string> {
  if (ext === ".pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: true });
    return String(text ?? "");
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString("utf8");
}

const PROMPT = (text: string, truncated: boolean) => `You read a website maintenance contract (an AMC - annual maintenance contract - or a similar agreement) for the agency that keeps the client's WordPress site running.

Turn what the contract PROMISES into a task list the agency can work from. Rules:
- Only what the document actually says. Never invent a service, a frequency or a number. If something is unclear, keep the task and say so in its detail.
- One task per obligation. A recurring obligation is ONE task with its frequency (e.g. "monthly plugin updates" -> frequency "monthly"), not twelve.
- kind "site": work done on the WordPress site itself - content or page updates, plugin / theme / core updates, backups, speed or SEO checks, security checks, fixing something on a page.
- kind "ticket": anything else to track - reports to send, meetings, response-time promises, renewals, work outside the website.
- source: a short quote (max 30 words) from the document that the task comes from.
- priority: high for anything with a deadline or a response-time promise, low for nice-to-have, otherwise medium.
- summary: 3-6 sentences in plain words: who, for what period, what is covered, what is not.
${truncated ? "- The document was too long and is cut off: say so in the summary.\n" : ""}
Answer with ONE JSON object and nothing else, exactly this shape:
{"summary": "...", "contract": {"client": "...", "provider": "...", "period": "...", "services": ["..."], "responseTimes": ["..."], "exclusions": ["..."], "reporting": "..."},
 "tasks": [{"title": "...", "detail": "...", "kind": "site" | "ticket", "frequency": "once" | "weekly" | "monthly" | "quarterly" | "yearly" | "on request", "priority": "low" | "medium" | "high", "source": "..."}]}
Leave out a contract field you cannot find; use [] for an empty list.

THE DOCUMENT:
<<<
${text}
>>>`;

/** The JSON object in a reply, even with prose or a code fence around it. */
function jsonIn(reply: string): unknown {
  const s = reply.indexOf("{"), e = reply.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("the reply holds no JSON object");
  return JSON.parse(reply.slice(s, e + 1));
}

export class Documents {
  private store = new JsonStore<ProjectDocument>(dir("meta"));
  private running = new Set<string>();
  /** Tests replace the model call. */
  constructor(private generate: (spec: string, prompt: string) => Promise<{ text: string; usage?: unknown }> = defaultGenerate) {}

  get(id: string) { return this.store.get(id); }
  forProject(projectId: string) { return this.store.list().filter((d) => d.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  save(d: ProjectDocument) { d.updatedAt = new Date().toISOString(); return this.store.put(d); }
  textOf(id: string) { try { return fs.readFileSync(path.join(dir("text"), id + ".txt"), "utf8"); } catch { return ""; } }

  delete(id: string) {
    const d = this.store.get(id);
    if (!d) return;
    for (const f of [path.join(dir("files"), id + path.extname(d.filename).toLowerCase()), path.join(dir("text"), id + ".txt")]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    this.store.delete(id);
  }

  /** Keep the file, then read and analyse it in the background. Returns at once with status "reading". */
  add(p: { projectId: string; siteId: string; filename: string; bytes: Buffer; uploadedBy: string; accountId?: string; model: string }): ProjectDocument {
    const ext = path.extname(p.filename).toLowerCase();
    if (!DOC_TYPES[ext]) throw new Error("Upload a PDF, a Word file (.docx), or text (.txt, .md).");
    if (p.bytes.length > MAX_DOC_BYTES) throw new Error("That file is over 15 MB.");
    if (!p.bytes.length) throw new Error("That file is empty.");
    const now = new Date().toISOString();
    const d: ProjectDocument = {
      id: newId("doc"), projectId: p.projectId, siteId: p.siteId, filename: path.basename(p.filename).slice(0, 160), mime: DOC_TYPES[ext], bytes: p.bytes.length,
      uploadedBy: p.uploadedBy, accountId: p.accountId, createdAt: now, updatedAt: now, status: "reading",
    };
    fs.writeFileSync(path.join(dir("files"), d.id + ext), p.bytes);
    this.store.put(d);
    void this.analyse(d.id, p.model);
    return d;
  }

  /** Read (if not read yet) and analyse. Safe to call again: a document being analysed is left alone. */
  async analyse(id: string, model: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    const d = this.store.get(id);
    try {
      if (!d) return;
      let text = this.textOf(id);
      if (!text) {
        d.status = "reading"; this.save(d);
        const ext = path.extname(d.filename).toLowerCase();
        text = (await extractText(fs.readFileSync(path.join(dir("files"), id + ext)), ext)).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (text.length < 40) throw new Error("No text could be read from this file. Is it a scan (an image of pages)? Upload a PDF with real text, or the Word file.");
        fs.writeFileSync(path.join(dir("text"), id + ".txt"), text);
      }
      d.chars = text.length; d.status = "analysing"; d.error = undefined; this.save(d);
      const truncated = text.length > MAX_CHARS;
      const t0 = Date.now();
      let prompt = PROMPT(truncated ? text.slice(0, MAX_CHARS) : text, truncated), parsed: z.infer<typeof Analysis> | null = null, why = "";
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const r = await this.generate(model, prompt);
        recordUsage({ at: new Date().toISOString(), site: d.siteId, job: d.id, account: d.accountId, model, step: attempt + 1, ...tokensOf(r.usage), ms: Date.now() - t0, finish: "document" });
        try { parsed = Analysis.parse(jsonIn(r.text)); }
        catch (e) {
          why = (e as Error).message.slice(0, 400);
          prompt += `\n\nYour last answer could not be used (${why}). Answer again with ONLY the JSON object, in the exact shape asked for.`;
        }
      }
      if (!parsed) throw new Error(`The model's answer was not a usable task list (${why}).`);
      const { tasks, ...rest } = parsed;
      d.analysis = { ...rest, truncated: truncated || undefined, model, ms: Date.now() - t0 };
      // Keep what was already done with a task (its ticket, its session) when the same task comes back.
      const before = new Map((d.tasks ?? []).map((t) => [t.title.toLowerCase(), t]));
      d.tasks = tasks.map((t, i) => {
        const old = before.get(t.title.toLowerCase());
        return { ...t, id: `t${i + 1}`, ...(old ? { jiraKey: old.jiraKey, jiraUrl: old.jiraUrl, jobId: old.jobId, dismissed: old.dismissed } : {}) };
      });
      d.status = "ready";
      this.save(d);
      log("info", "document analysed", { doc: d.id, project: d.projectId, tasks: d.tasks.length, ms: Date.now() - t0 });
    } catch (e) {
      if (d) { d.status = "failed"; d.error = (e as Error).message.slice(0, 600); this.save(d); }
      log("warn", "document analysis failed", { doc: id, error: (e as Error).message.slice(0, 300) });
    } finally {
      this.running.delete(id);
    }
  }

  /** On start-up: a document left mid-analysis by a restart is analysed again. */
  recover(modelFor: (d: ProjectDocument) => string) {
    for (const d of this.store.list()) if (d.status === "reading" || d.status === "analysing") void this.analyse(d.id, modelFor(d));
  }
}

async function defaultGenerate(spec: string, prompt: string) {
  const r = await generateText({ model: resolveModel(spec), prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(6 * 60_000) } as any);
  return { text: r.text, usage: r.usage };
}

/** What a site task becomes when it is started as a session: the task, where it comes from, and the contract's limits. */
export function sessionPrompt(d: ProjectDocument, t: DocTask): string {
  const c = d.analysis?.contract;
  return [
    `Task from the maintenance contract "${d.filename}": ${t.title}`,
    t.detail ? `\n${t.detail}` : "",
    t.source ? `\nThe contract says: "${t.source}"` : "",
    t.frequency !== "once" ? `\n(This is a ${t.frequency} task - do this round of it.)` : "",
    c?.exclusions?.length ? `\nNot covered by the contract (do not do these): ${c.exclusions.join("; ")}` : "",
    t.jiraKey ? `\nIt is tracked as Jira ticket ${t.jiraKey}.` : "",
    "\nLook at the site first, then propose what you will do.",
  ].join("");
}

/** A Jira ticket's description for a task. */
export function ticketText(d: ProjectDocument, t: DocTask): string {
  return [t.detail, t.source ? `The contract says: "${t.source}"` : "", `Frequency: ${t.frequency}. Priority: ${t.priority}.`, `From: ${d.filename} (Livecrafts document ${d.id}).`].filter(Boolean).join("\n\n");
}

/** The one document store of this backend. */
export const documents = new Documents();
