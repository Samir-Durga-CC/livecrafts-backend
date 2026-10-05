import type { ModelMessage } from "ai";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import type { AgentFactory, JobContext } from "./agent.js";
import { blockingChange, recordFor, revertChange, type ChangeRecord } from "./changes.js";
import { imageMarker } from "./vision.js";
import { assistantSettings } from "./persona.js";
import type { ApprovalMode, Job, JobEvent, JobStatus, PendingApproval, Site } from "./types.js";
import { APPROVAL_MODES } from "./types.js";

export interface RequestOptions { approvalMode?: ApprovalMode; model?: string }
const cleanMode = (m: unknown): ApprovalMode | undefined => (APPROVAL_MODES.includes(m as ApprovalMode) ? (m as ApprovalMode) : undefined);

type Listener = (e: JobEvent) => void;

/**
 * Runs agent jobs in the background and keeps them independent of any browser.
 *
 *   create -> queued -> running -> ( waiting_approval <-> running )* -> completed | failed
 *
 * The whole conversation is saved after every run, so a job that is waiting for approval costs nothing while it waits
 * and can continue after the browser closed, or the server restarted. The loop itself (tool calling, retries,
 * step limits, approval pauses) is the AI SDK's ToolLoopAgent - this class only persists, schedules and streams.
 */
export class JobRunner {
  private listeners = new Map<string, Set<Listener>>();
  private active = new Set<string>();
  private again = new Set<string>();
  /** The job object a run is working on (the store returns copies; everything during a run must use this one). */
  private live = new Map<string, Job>();
  private current(id: string): Job { return this.live.get(id) ?? this.mustGet(id); }

  constructor(private jobs: JsonStore<Job>, private sites: JsonStore<Site>, private factory: AgentFactory) {}

  /** Jobs that were running when the server stopped are marked interrupted (resume them explicitly). */
  recover() {
    for (const j of this.jobs.list()) {
      if (j.status === "running" || j.status === "queued") {
        j.status = "interrupted";
        this.emit(j, "status", { status: "interrupted", note: "Server restarted while this job was running. Resume it to continue." });
      }
    }
  }

  get(id: string) { return this.jobs.get(id); }
  list() { return this.jobs.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  create(siteId: string, prompt: string, context?: string, fileIds: string[] = [], opts: RequestOptions = {}): Job {
    if (!this.sites.get(siteId)) throw new Error("Unknown site.");
    const now = new Date().toISOString();
    const text = context ? `${context}\n\n${prompt}` : prompt;
    const job: Job = { id: newId("job"), siteId, prompt, status: "queued", messages: [userMessage(text, fileIds)], pending: [], events: [], changes: [], createdAt: now, updatedAt: now,
      approvalMode: cleanMode(opts.approvalMode) ?? "request", requestSeq: 1, model: opts.model || undefined };
    this.jobs.put(job);
    this.emit(job, "user", { text: prompt, fileIds, requestId: 1, approvalMode: job.approvalMode });
    this.emit(job, "status", { status: "queued" });
    this.kick(job.id);
    return job;
  }

  /** Follow-up message in the same conversation (the model keeps the earlier context). Only when the job is idle. */
  continue(jobId: string, prompt: string, context?: string, fileIds: string[] = [], opts: RequestOptions = {}): Job {
    const job = this.mustGet(jobId);
    if (job.status !== "completed" && job.status !== "failed") throw new Error(`Job is ${job.status}; wait for it to finish (or answer the approval) before sending another message.`);
    job.messages.push(userMessage(context ? context + "\n\n" + prompt : prompt, fileIds));
    job.error = undefined;
    job.requestSeq = (job.requestSeq ?? 1) + 1;
    if (cleanMode(opts.approvalMode)) job.approvalMode = cleanMode(opts.approvalMode);
    if (opts.model !== undefined) job.model = opts.model || undefined;
    this.emit(job, "user", { text: prompt, fileIds, requestId: job.requestSeq, approvalMode: job.approvalMode });
    this.setStatus(job, "queued");
    this.kick(job.id);
    return job;
  }

  /** The person answers an approval card. When every pending request is answered the job continues. */
  respond(jobId: string, approvalId: string, approved: boolean, reason?: string): Job {
    const job = this.mustGet(jobId);
    if (job.status !== "waiting_approval") throw new Error(`Job is ${job.status}, not waiting for approval.`);
    const p = job.pending.find((x) => x.approvalId === approvalId);
    if (!p) throw new Error("Unknown approval id.");
    if (p.approved !== undefined) throw new Error("This approval was already answered.");
    p.approved = approved;
    p.reason = reason;
    // "Once per request": one yes covers the rest of this request.
    if (approved && (job.approvalMode ?? "every") === "request") job.planApprovedFor = job.requestSeq ?? 1;
    this.emit(job, "approval_response", { approvalId, toolName: p.toolName, approved, reason });

    if (job.pending.every((x) => x.approved !== undefined)) {
      job.messages.push({
        role: "tool",
        content: job.pending.map((x) => ({ type: "tool-approval-response", approvalId: x.approvalId, approved: x.approved as boolean, reason: x.reason })),
      } as ModelMessage);
      job.pending = [];
      this.setStatus(job, "queued");
      this.kick(job.id);
    } else {
      this.jobs.put(job);
    }
    return job;
  }

  /** Continue an interrupted or failed job from its saved conversation. */
  resume(jobId: string): Job {
    const job = this.mustGet(jobId);
    if (job.status !== "interrupted" && job.status !== "failed") throw new Error(`Job is ${job.status}; only interrupted or failed jobs can be resumed.`);
    job.error = undefined;
    this.setStatus(job, "queued");
    this.kick(job.id);
    return job;
  }

  /**
   * Undo one recorded change (the Revert button, or revert_change from the chat). Refused when a newer change to the
   * same thing is still active - that one has to be reverted first, so nothing is silently overwritten.
   */
  async revertChange(jobId: string, changeId: string, by: "button" | "chat" = "button"): Promise<Record<string, unknown>> {
    const job = this.current(jobId);
    const c = (job.changes ?? []).find((x) => x.id === changeId);
    if (!c) throw new Error("Unknown change id.");
    if (c.revertedAt) throw new Error("This change was already reverted.");
    if (!c.revert) throw new Error(c.note ?? "This change cannot be reverted automatically.");
    const newer = blockingChange(job.changes ?? [], c);
    if (newer) throw new Error(`A newer change touches the same thing (“${newer.title}”). Revert that one first.`);
    if (by === "button" && (job.status === "running" || job.status === "queued")) throw new Error("The assistant is working right now. Wait until it finishes, then revert.");
    const site = this.sites.get(job.siteId);
    if (!site) throw new Error("Site was deleted.");
    const { bridge, siteFiles } = this.factory(site);
    const mark = (patch: Partial<ChangeRecord>, data: Record<string, unknown>) => {
      const fresh = this.current(jobId); // the job may have moved on while we were reverting
      const rec = (fresh.changes ?? []).find((x) => x.id === changeId)!;
      Object.assign(rec, patch);
      this.emit(fresh, "change_update", { change: rec, by, ...data });
      return rec;
    };
    try {
      const result = await revertChange(c, { bridge, siteFiles, healthUrls: [bridge.homeUrl, ...(c.link?.startsWith(site.url) ? [c.link] : [])], siteId: site.id });
      const rec = mark({ revertedAt: new Date().toISOString(), revertError: undefined }, { result });
      return { ok: true, reverted: rec.title, ...result };
    } catch (e) {
      mark({ revertError: (e as Error).message }, {});
      throw e;
    }
  }

  /** The site's file access (for diffs of file changes). */
  siteFilesFor(site: Site) { return this.factory(site).siteFiles ?? null; }

  /** Revert every still-active change of one request, newest first. Stops at the first one that cannot be undone. */
  async revertRequest(jobId: string, requestId: number): Promise<Record<string, unknown>> {
    const list = (this.current(jobId).changes ?? []).filter((c) => (c.requestId ?? 0) === requestId && !c.revertedAt && c.revert).reverse();
    if (!list.length) throw new Error("Nothing to revert in this request.");
    const done: string[] = [];
    for (const c of list) {
      try { await this.revertChange(jobId, c.id, "button"); done.push(c.title); }
      catch (e) { throw new Error(`Reverted ${done.length} of ${list.length}. Stopped at “${c.title}”: ${(e as Error).message}`); }
    }
    return { ok: true, reverted: done.length };
  }

  /**
   * Record a manual edit (made by the person in Quick actions, no AI) as its own request in a chat, so it shows in
   * Changes with a diff and Revert. Uses the given chat when it is idle, otherwise starts a "Manual edits" chat.
   * The assistant is told about it in the conversation, so it never works against a manual change.
   */
  recordManual(siteId: string, jobId: string | undefined, summary: string, rec: ChangeRecord): Job {
    let job = jobId ? this.jobs.get(jobId) : undefined;
    if (job && (job.siteId !== siteId || this.active.has(job.id) || job.status === "running" || job.status === "queued" || job.status === "waiting_approval")) job = undefined;
    const now = new Date().toISOString();
    if (!job) {
      job = { id: newId("job"), siteId, prompt: "Manual edits", status: "completed", messages: [], pending: [], events: [], changes: [], createdAt: now, updatedAt: now, approvalMode: "request", requestSeq: 0 };
    }
    job.requestSeq = (job.requestSeq ?? 0) + 1;
    rec.requestId = job.requestSeq;
    rec.request = `Manual: ${summary}`;
    job.changes = [...(job.changes ?? []), rec];
    // keep user/assistant turns alternating for the model
    job.messages.push({ role: "user", content: `[I made this change myself with the manual editor - keep it unless I ask otherwise] ${summary}` });
    job.messages.push({ role: "assistant", content: "Noted." });
    this.emit(job, "user", { text: `✋ ${summary}`, fileIds: [], requestId: job.requestSeq, manual: true });
    this.emit(job, "change", { change: rec });
    this.emit(job, "text", { text: "Saved. You can see the exact change in **Changes** and revert it there." });
    if (job.status !== "completed") this.setStatus(job, "completed");
    else this.emit(job, "status", { status: "completed" });
    return job;
  }

  /** Change how this chat asks for approval (takes effect on the next step). */
  setApprovalMode(jobId: string, mode: ApprovalMode): Job {
    const job = this.current(jobId);
    if (!cleanMode(mode)) throw new Error("Unknown approval mode.");
    job.approvalMode = mode;
    this.emit(job, "status", { status: job.status, approvalMode: mode });
    return job;
  }

  /** Delete a chat (not while it is working). Changes already made on the site stay. */
  delete(jobId: string) {
    const job = this.mustGet(jobId);
    if (this.active.has(jobId) || job.status === "running" || job.status === "queued") throw new Error("This chat is still working. Wait until it finishes.");
    this.jobs.delete(jobId);
    this.listeners.delete(jobId);
  }

  /** Follow a job: replays stored events after `afterSeq`, then streams new ones. Returns an unsubscribe function. */
  subscribe(jobId: string, listener: Listener, afterSeq = 0): () => void {
    const job = this.mustGet(jobId);
    for (const e of job.events) if (e.seq > afterSeq) listener(e);
    let set = this.listeners.get(jobId);
    if (!set) this.listeners.set(jobId, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Resolves when the job reaches completed / failed / waiting_approval (handy for tests and the CLI). */
  waitUntilSettled(jobId: string): Promise<Job> {
    return new Promise((resolve) => {
      const check = () => {
        const j = this.mustGet(jobId);
        if (["completed", "failed", "waiting_approval", "interrupted"].includes(j.status)) { off(); resolve(j); }
      };
      const off = this.subscribe(jobId, check, Number.MAX_SAFE_INTEGER);
      check();
    });
  }

  // ------------------------------------------------------------------ internals

  private mustGet(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error("Unknown job.");
    return j;
  }

  private emit(job: Job, type: JobEvent["type"], data: Record<string, unknown>) {
    const e: JobEvent = { seq: (job.events.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString(), type, data };
    job.events.push(e);
    if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    job.updatedAt = e.ts;
    this.jobs.put(job);
    for (const l of this.listeners.get(job.id) ?? []) { try { l(e); } catch { /* a bad listener must not break the job */ } }
  }

  /** Live-only event (streamed text): sent to whoever is watching right now, never written to disk. */
  private broadcast(job: Job, type: JobEvent["type"], data: Record<string, unknown>) {
    const e: JobEvent = { seq: job.events.at(-1)?.seq ?? 0, ts: new Date().toISOString(), type, data };
    for (const l of this.listeners.get(job.id) ?? []) { try { l(e); } catch { /* ignore */ } }
  }

  private setStatus(job: Job, status: JobStatus, extra: Record<string, unknown> = {}) {
    job.status = status;
    this.emit(job, "status", { status, ...extra });
  }

  /**
   * Start (or schedule) a run. If a run is still unwinding - e.g. an approval answered the instant a job paused - remember
   * that another run was requested and start it as soon as the current one ends, instead of dropping the request.
   */
  private kick(jobId: string) {
    if (this.active.has(jobId)) { this.again.add(jobId); return; }
    this.active.add(jobId);
    setImmediate(() => {
      this.run(jobId)
        .catch(() => { /* handled inside run */ })
        .finally(() => {
          this.active.delete(jobId);
          this.live.delete(jobId);
          if (this.again.delete(jobId)) this.kick(jobId);
        });
    });
  }

  private async run(jobId: string) {
    const job = this.mustGet(jobId);
    this.live.set(jobId, job);
    const site = this.sites.get(job.siteId);
    if (!site) { job.error = "Site was deleted."; this.setStatus(job, "failed", { error: job.error }); return; }

    this.setStatus(job, "running");
    try {
      const mode = job.approvalMode ?? "every";
      const persona = await assistantSettings(site);
      const ctx: JobContext = {
        persona,
        approval: { mode, planApproved: mode === "request" && job.planApprovedFor === (job.requestSeq ?? 1) },
        model: job.model,
        changes: {
          list: () => job.changes ?? [],
          revert: (id) => this.revertChange(jobId, id, "chat"),
        },
      };
      const { agent, bridge, siteFiles } = this.factory(site, ctx);
      const result = await agent.stream({
        messages: job.messages,
        abortSignal: AbortSignal.timeout(config.jobTimeoutMs),
        onToolExecutionStart: (e: any) => this.emit(job, "tool_start", { tool: e.toolCall?.toolName, input: e.toolCall?.input }),
        onToolExecutionEnd: (e: any) => {
          // toolOutput.type is "tool-result" or "tool-error". Our tools also return {ok:false,error} for expected failures.
          const out = e.toolOutput;
          const threw = out?.type === "tool-error";
          const value = out?.output;
          const toolName = e.toolCall?.toolName;
          const rec = threw ? null : recordFor(toolName, e.toolCall?.input, value);
          if (rec) {
            rec.requestId = job.requestSeq ?? 1;
            rec.request = lastRequestText(job);
            job.changes = [...(job.changes ?? []), rec];
          }
          this.emit(job, "tool_end", {
            tool: toolName,
            ok: !threw && value?.ok !== false,
            error: threw ? String(out.error?.message ?? out.error) : value?.error,
            ui: threw ? undefined : uiSummary(toolName, value),
            changeId: rec?.id,
          });
          if (rec) this.emit(job, "change", { change: rec });
        },
      });

      // Stream the answer: small text pieces go live to the browser (not saved); the full text is saved once per block.
      let block = "", pending = "";
      let timer: NodeJS.Timeout | null = null;
      const flush = () => { if (timer) { clearTimeout(timer); timer = null; } if (pending) { this.broadcast(job, "text_delta", { text: pending }); pending = ""; } };
      for await (const part of result.fullStream as AsyncIterable<any>) {
        if (part.type === "text-delta") {
          const t = String(part.text ?? part.delta ?? "");
          block += t; pending += t;
          if (!timer) timer = setTimeout(flush, 40); // ~25 updates per second is smooth without flooding the connection
        } else if (part.type === "text-end") {
          flush();
          if (block.trim()) this.emit(job, "text", { text: block });
          block = "";
        } else if (part.type === "error") {
          flush();
          throw part.error instanceof Error ? part.error : new Error(String(part.error?.message ?? part.error));
        }
      }
      flush();
      if (block.trim()) this.emit(job, "text", { text: block });

      // Save everything the model and the tools produced during this run. On a streamed run, `responseMessages` also holds
      // the result of a tool that was approved earlier - saving it is what stops that write from ever running twice.
      job.messages.push(...((await result.responseMessages) ?? []));

      const requests = ((await result.content) ?? []).filter((p: any) => p.type === "tool-approval-request" && !p.isAutomatic);
      if (requests.length) {
        const pending: PendingApproval[] = [];
        for (const r of requests) {
          const input: any = r.toolCall?.input ?? {};
          const entry: PendingApproval & { current?: unknown } = { approvalId: r.approvalId, toolCallId: r.toolCall?.toolCallId, toolName: r.toolCall?.toolName, input };
          // Show the person what is there NOW, so the card can be a before/after diff.
          if (entry.toolName === "set_content" && typeof input.target === "string") {
            entry.current = await bridge.readTarget(input.target).then((d: any) => d.stored_raw ?? null).catch(() => null);
          }
          if (entry.toolName === "restore_file" && siteFiles && typeof input.backupId === "string") {
            const b = siteFiles.getBackup(input.backupId);
            entry.current = b ? { path: b.path, editedAt: b.createdAt } : null;
          }
          if (entry.toolName === "revert_change" && typeof input.changeId === "string") {
            const c = (job.changes ?? []).find((x) => x.id === input.changeId);
            entry.current = c ? { title: c.title, tool: c.tool, at: c.at } : null;
          }
          pending.push(entry);
          this.emit(job, "approval_request", { approvalId: entry.approvalId, tool: entry.toolName, input, current: entry.current });
        }
        job.pending = pending;
        this.setStatus(job, "waiting_approval", { count: pending.length });
        return;
      }

      job.result = (await result.text) ?? "";
      this.emit(job, "done", { text: job.result });
      this.setStatus(job, "completed");
    } catch (e) {
      job.error = (e as Error).message;
      this.emit(job, "error", { error: job.error });
      this.setStatus(job, "failed", { error: job.error });
    }
  }
}

/** Small, safe bits of a tool result the chat UI needs (screenshot ids, which file changed) - never whole file contents. */
function uiSummary(tool: string | undefined, v: any): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || v.ok === false) return undefined;
  if (tool === "screenshot_page" && v.screenshotId) return { screenshotId: v.screenshotId, device: v.device, target: v.target };
  if (tool === "edit_file" || tool === "restore_file" || tool === "create_file") return { path: v.path, backupId: v.backupId, verifiedLive: v.verifiedLive, created: v.created };
  if (tool === "create_page" || tool === "create_post" || tool === "edit_post_content" || tool === "set_post_status") return { id: v.id, link: v.link, status: v.status };
  if (tool === "upload_media_from_chat" || tool === "upload_media_from_url") return { mediaId: v.id, url: v.url };
  if (tool === "view_image" && v.fileId) return { fileId: v.fileId };
  if (tool === "create_menu" || tool === "add_menu_item") return { menuId: v.menuId, itemId: v.itemId };
  if (tool === "inspect_element" && Array.isArray(v.elements)) {
    const c = v.elements[0]?.computed ?? {};
    return { count: v.count, computed: { color: c.color, "font-family": c["font-family"], "font-size": c["font-size"] } };
  }
  return undefined;
}

/** A user message; attached images travel as small markers and are turned into real pictures right before each model call. */
function userMessage(text: string, fileIds: string[]): ModelMessage {
  if (!fileIds.length) return { role: "user", content: text };
  return { role: "user", content: [{ type: "text", text }, ...fileIds.map((id) => ({ type: "text" as const, text: imageMarker(id) }))] };
}

/** The text of the person's latest message (for grouping changes per request). */
function lastRequestText(job: Job): string {
  for (let i = job.events.length - 1; i >= 0; i--) if (job.events[i].type === "user") return String(job.events[i].data.text ?? "").slice(0, 200);
  return job.prompt.slice(0, 200);
}
