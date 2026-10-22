import { friendlyAiError } from "./aiErrors.js";
import type { ModelMessage } from "ai";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import type { AgentFactory, JobContext } from "./agent.js";
import { quickCommand, undoReply } from "./quick.js";
import { blockingChange, reconcile, recordsFor, revertChange, type ChangeRecord } from "./changes.js";
import { imageMarker } from "./vision.js";
import { assistantSettings } from "./persona.js";
import { Bridge } from "./bridge.js";
import { log, recordUsage, tokensOf } from "./usage.js";
import type { ApprovalMode, Job, JobEvent, JobStatus, PendingApproval, Site } from "./types.js";
import { APPROVAL_MODES } from "./types.js";
import { WRITE_TOOLS, compactMap } from "./tools.js";
import { voiceSession, type SiteCache } from "./sessions.js";

export interface RequestOptions {
  approvalMode?: ApprovalMode; model?: string; /** "note" / "edit" = said while paused: same request continues */ kind?: "new" | "note" | "edit";
  /** The person in the chat (from their signed widget token): changes are credited to them. */
  actor?: { token: string; name: string; login: string };
  /** The page the person is on. */
  pageUrl?: string;
  /** The request came from voice (the realtime tool or the voice chat): faster model, context read once per session. */
  voice?: boolean;
}
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
  /** Per running job: Stop flag, abort switch, and how many tools are executing right now. */
  private control = new Map<string, { abort: AbortController; stop: boolean; toolsRunning: number }>();
  private stopRequested = new Set<string>();
  private current(id: string): Job { return this.live.get(id) ?? this.mustGet(id); }

  constructor(private jobs: JsonStore<Job>, private sites: JsonStore<Site>, private factory: AgentFactory) {}

  /** Jobs that were running when the server stopped are marked interrupted (resume them explicitly). */
  recover() {
    for (const j of this.jobs.list()) {
      if (j.status === "running" || j.status === "queued") {
        if (j.partial) { keepFinished(j, j.partial.steps, j.partial.tools, "The server restarted while you were working."); j.partial = undefined; }
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
      approvalMode: cleanMode(opts.approvalMode) ?? "request", requestSeq: 1, model: opts.model || undefined, pageUrl: opts.pageUrl || undefined, voice: opts.voice || undefined,
      actorToken: opts.actor?.token, actor: opts.actor ? { name: opts.actor.name, login: opts.actor.login } : undefined };
    this.jobs.put(job);
    this.emit(job, "user", { text: prompt, fileIds, requestId: 1, approvalMode: job.approvalMode });
    this.emit(job, "status", { status: "queued" });
    this.kick(job.id);
    return job;
  }

  /** Follow-up message in the same conversation (the model keeps the earlier context). Only when the job is idle. */
  continue(jobId: string, prompt: string, context?: string, fileIds: string[] = [], opts: RequestOptions = {}): Job {
    const job = this.mustGet(jobId);
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "paused" && job.status !== "interrupted") throw new Error(`Job is ${job.status}; wait for it to finish (or answer the approval) before sending another message.`);
    const paused = job.status === "paused";
    const quick = !paused && !fileIds.length ? quickCommand(prompt) : null;
    if (quick && job.pending.every((x) => x.approved !== undefined)) { this.quickUndo(job, prompt, quick.all); return job; }
    const unanswered = job.pending.filter((x) => x.approved === undefined);
    if (unanswered.length) {
      // the person changed course while a change waited for approval: that change is declined, nothing is written
      for (const p of unanswered) { p.approved = false; p.reason = "Paused - the person changed the request instead."; this.emit(job, "approval_response", { approvalId: p.approvalId, toolName: p.toolName, approved: false, reason: p.reason }); }
      job.messages.push({ role: "tool", content: job.pending.map((x) => ({ type: "tool-approval-response", approvalId: x.approvalId, approved: !!x.approved, reason: x.reason })) } as ModelMessage);
      job.pending = [];
    }
    const kind = paused ? (opts.kind === "edit" ? "edit" : opts.kind === "new" ? "new" : "note") : "new";
    const said = kind === "edit" ? `[I paused you and CORRECTED my request - follow this instead; keep changes already made unless they conflict, then revert those]\n${prompt}`
      : kind === "note" ? `[I paused you. Additional instruction for the same request - take it into account and continue]\n${prompt}` : prompt;
    job.messages.push(userMessage(context ? context + "\n\n" + said : said, fileIds));
    job.error = undefined;
    if (kind === "new") job.requestSeq = (job.requestSeq ?? 1) + 1;
    if (cleanMode(opts.approvalMode)) job.approvalMode = cleanMode(opts.approvalMode);
    if (opts.model !== undefined) job.model = opts.model || undefined;
    if (opts.pageUrl) job.pageUrl = opts.pageUrl;
    if (opts.voice !== undefined) job.voice = opts.voice || undefined;
    if (opts.actor) { job.actorToken = opts.actor.token; job.actor = { name: opts.actor.name, login: opts.actor.login }; }
    this.emit(job, "user", { text: prompt, fileIds, requestId: job.requestSeq, approvalMode: job.approvalMode, ...(kind !== "new" ? { kind } : {}) });
    this.setStatus(job, "queued");
    this.kick(job.id);
    return job;
  }

  /** The person answers an approval card. When every pending request is answered the job continues. */
  respond(jobId: string, approvalId: string, approved: boolean, reason?: string, actorToken?: string): Job {
    const job = this.mustGet(jobId);
    if (actorToken) job.actorToken = actorToken;
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
    if (job.status === "paused") {
      if (job.pending.some((x) => x.approved === undefined)) { this.setStatus(job, "waiting_approval", { count: job.pending.length }); return job; }
      job.messages.push({ role: "user", content: "[Continue where you stopped.]" });
      this.setStatus(job, "queued");
      this.kick(job.id);
      return job;
    }
    if (job.status !== "interrupted" && job.status !== "failed") throw new Error(`Job is ${job.status}; only interrupted, failed or paused jobs can be resumed.`);
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
    const bridge = new Bridge(site, job.actorToken);
    const mark = (patch: Partial<ChangeRecord>, data: Record<string, unknown>) => {
      const fresh = this.current(jobId); // the job may have moved on while we were reverting
      const rec = (fresh.changes ?? []).find((x) => x.id === changeId)!;
      Object.assign(rec, patch);
      this.emit(fresh, "change_update", { change: rec, by, ...data });
      return rec;
    };
    try {
      const result = await revertChange(c, { bridge, ref: `${job.id}#revert` });
      const rec = mark({ revertedAt: new Date().toISOString(), revertError: undefined }, { result });
      return { ok: true, reverted: rec.title, ...result };
    } catch (e) {
      mark({ revertError: (e as Error).message }, {});
      throw e;
    }
  }

  /**
   * The site's change ledger is the one record, and a change can be reverted from anywhere (page widget, wp-admin, another
   * chat). Before a chat shows its changes, bring them up to date with the ledger. Best effort: the site may be unreachable.
   */
  async syncChanges(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || this.active.has(jobId) || !(job.changes ?? []).some((c) => c.pluginId && !c.revertedAt)) return;
    const site = this.sites.get(job.siteId);
    if (!site) return;
    try {
      const ledger = (await new Bridge(site, job.actorToken).changes({ limit: 300 })).changes ?? [];
      const fresh = this.current(jobId);
      if (reconcile(fresh.changes ?? [], ledger)) { fresh.updatedAt = new Date().toISOString(); this.jobs.put(fresh); }
    } catch { /* offline: show what we know */ }
  }

  /** "undo" / "wapas kar do": revert from the ledger, answer in the person's language - no model call, no tokens. */
  private quickUndo(job: Job, prompt: string, all: boolean) {
    job.messages.push(userMessage(prompt, []));
    job.requestSeq = (job.requestSeq ?? 1) + 1;
    this.emit(job, "user", { text: prompt, fileIds: [], requestId: job.requestSeq, approvalMode: job.approvalMode, quick: "undo" });
    this.setStatus(job, "running");
    void (async () => {
      let reply: string;
      try {
        const active = (this.current(job.id).changes ?? []).filter((c) => !c.revertedAt && c.revert);
        const requests = [...new Set(active.map((c) => c.requestId ?? 0))].sort((a, b) => b - a);
        const chosen = all ? requests : requests.slice(0, 1);
        if (!chosen.length) reply = undoReply(prompt, "nothing");
        else {
          let n = 0;
          for (const id of chosen) {
            for (const c of (this.current(job.id).changes ?? []).filter((x) => (x.requestId ?? 0) === id && !x.revertedAt && x.revert).reverse()) { await this.revertChange(job.id, c.id, "chat"); n++; }
          }
          reply = undoReply(prompt, { reverted: n, requests: chosen.length });
        }
      } catch (e) { reply = undoReply(prompt, { error: (e as Error).message }); }
      const fresh = this.current(job.id);
      fresh.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] } as ModelMessage);
      fresh.result = reply;
      this.emit(fresh, "text", { text: reply });
      this.emit(fresh, "done", { text: reply });
      this.setStatus(fresh, "completed");
    })();
  }

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
   * The Stop button. Text being written stops at once; a site change that is already running always finishes first
   * (never half-done), then the loop ends. Everything finished is saved. Status becomes "paused".
   */
  stop(jobId: string): Job {
    const job = this.current(jobId);
    if (job.status === "waiting_approval") { this.setStatus(job, "paused", { note: "Stopped while waiting for approval." }); return job; }
    const c = this.control.get(jobId);
    if (!c) {
      if (job.status === "queued") { this.stopRequested.add(jobId); this.again.delete(jobId); if (!this.active.has(jobId)) this.setStatus(job, "paused"); return job; }
      throw new Error(`Job is ${job.status}; there is nothing to stop.`);
    }
    c.stop = true;
    this.again.delete(jobId);
    if (c.toolsRunning === 0) c.abort.abort(new Error("Stopped by the person"));
    this.emit(job, "status", { status: job.status, stopping: true, waitingFor: c.toolsRunning ? "the running change to finish" : undefined });
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
        if (["completed", "failed", "waiting_approval", "interrupted", "paused"].includes(j.status)) { off(); resolve(j); }
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
          this.control.delete(jobId);
          if (this.again.delete(jobId)) this.kick(jobId);
        });
    });
  }

  private async run(jobId: string) {
    const job = this.mustGet(jobId);
    this.live.set(jobId, job);
    const site = this.sites.get(job.siteId);
    if (!site) { job.error = "Site was deleted."; this.setStatus(job, "failed", { error: job.error }); return; }

    const ctl = { abort: new AbortController(), stop: this.stopRequested.delete(jobId), toolsRunning: 0 };
    this.control.set(jobId, ctl);
    if (ctl.stop) { this.setStatus(job, "paused"); return; }
    const stepMessages: ModelMessage[] = [];                                  // finished steps of this run
    const toolResults: { toolCallId: string; toolName: string; output: any; error?: string }[] = [];
    let block = "";
    this.setStatus(job, "running");
    try {
      const mode = job.approvalMode ?? "every";
      const persona = await assistantSettings(site);
      /**
       * A session reads the site once and keeps it: every turn after the first gets the status, the notes and the
       * page map from here instead of fetching them again.
       *
       * This was limited to voice, on the reasoning that voice is where the waiting is heard. But the three reads
       * cost a typed turn exactly what they cost a spoken one - two round trips to WordPress before anything
       * happens, on every single message - and someone watching a cursor blink is also waiting. The safety is the
       * same either way and does not depend on which one it is: entries live ten minutes, a session half an hour,
       * and every write through make_change empties the whole thing (tools.ts), so nothing is ever served from a
       * site that has been changed since it was read.
       */
      const cache: SiteCache | null = voiceSession(job.siteId, job.pageUrl);
      const ctx: JobContext = {
        persona,
        approval: { mode, planApproved: mode === "request" && job.planApprovedFor === (job.requestSeq ?? 1) },
        model: job.model,
        actorToken: job.actorToken,
        pageUrl: job.pageUrl,
        ref: `${job.id}#${job.requestSeq ?? 1}`,
        siteContext: await siteContext(new Bridge(site, job.actorToken), job.pageUrl, cache),
        voice: job.voice,
        cache,
        shouldStop: () => ctl.stop,
      };
      const { agent, model } = this.factory(site, ctx);
      const saveProgress = () => { job.partial = { steps: [...stepMessages], tools: [...toolResults] }; this.jobs.put(job); };
      let step = 0;
      let stepStart = Date.now();
      const result = await agent.stream({
        messages: job.messages,
        abortSignal: AbortSignal.any([AbortSignal.timeout(config.jobTimeoutMs), ctl.abort.signal]),
        onStepEnd: (s: any) => {
          stepMessages.push(...((s?.response?.messages ?? []) as ModelMessage[]));
          // every model call, with its tokens (the admin panel's LLM usage view)
          const t = tokensOf(s?.usage);
          recordUsage({ at: new Date().toISOString(), site: site.id, job: job.id, request: job.requestSeq ?? 1, user: job.actor?.login, model: String(s?.response?.modelId ?? model), step: ++step,
            ...t, ms: Date.now() - stepStart, finish: typeof s?.finishReason === "string" ? s.finishReason : s?.finishReason?.unified });
          job.usage = { input: (job.usage?.input ?? 0) + t.input, output: (job.usage?.output ?? 0) + t.output, calls: (job.usage?.calls ?? 0) + 1 };
          stepStart = Date.now();
          saveProgress();
        },
        onToolExecutionStart: (e: any) => { ctl.toolsRunning++; this.emit(job, "tool_start", { tool: e.toolCall?.toolName, input: e.toolCall?.input }); },
        onToolExecutionEnd: (e: any) => {
          ctl.toolsRunning = Math.max(0, ctl.toolsRunning - 1);
          // toolOutput.type is "tool-result" or "tool-error". Our tools also return {ok:false,error} for expected failures.
          const out = e.toolOutput;
          const threw = out?.type === "tool-error";
          const value = out?.output;
          toolResults.push({ toolCallId: e.toolCall?.toolCallId, toolName: e.toolCall?.toolName, output: value, error: threw ? String(out?.error?.message ?? out?.error) : undefined });
          const toolName = e.toolCall?.toolName;
          const recs = threw ? [] : recordsFor(toolName, e.toolCall?.input, value);
          const rec = recs.at(-1);
          for (const r of recs) {
            r.requestId = job.requestSeq ?? 1;
            r.request = lastRequestText(job);
            job.changes = [...(job.changes ?? []), r];
          }
          this.emit(job, "tool_end", {
            tool: toolName,
            ok: !threw && value?.ok !== false,
            error: threw ? String(out.error?.message ?? out.error) : value?.error,
            ui: threw ? undefined : uiSummary(toolName, value),
            changeId: rec?.id,
          });
          for (const r of recs) this.emit(job, "change", { change: r });
          saveProgress();
        },
      });

      // Stream the answer: small text pieces go live to the browser (not saved); the full text is saved once per block.
      let pending = "";
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
      job.partial = undefined;

      const requests = ((await result.content) ?? []).filter((p: any) => p.type === "tool-approval-request" && !p.isAutomatic);
      if (requests.length) {
        const pending: PendingApproval[] = [];
        for (const r of requests) {
          const input: any = r.toolCall?.input ?? {};
          const entry: PendingApproval & { current?: unknown } = { approvalId: r.approvalId, toolCallId: r.toolCall?.toolCallId, toolName: r.toolCall?.toolName, input };
          // Show the person what is there NOW, so the card can be a before/after diff.
          // Show the person what a revert would undo.
          if (entry.toolName === "revert_change" && typeof input.changeId === "number") {
            entry.current = await new Bridge(site, job.actorToken).change(input.changeId).then((r: any) => ({ title: r.change?.summary, status: r.change?.status, by: r.change?.user?.name, at: r.change?.at }), () => null);
          }
          pending.push(entry);
          this.emit(job, "approval_request", { approvalId: entry.approvalId, tool: entry.toolName, input, current: entry.current });
        }
        job.pending = pending;
        if (ctl.stop) { this.setStatus(job, "paused", { note: "Stopped. The next change is waiting for your approval when you continue." }); return; }
        this.setStatus(job, "waiting_approval", { count: pending.length });
        return;
      }

      let answer = (await result.text) ?? "";
      if (!answer.trim()) {
        // Some models end with a tool call and no words. Never leave the person without an answer.
        answer = fallbackAnswer(toolResults);
        if (answer) { this.emit(job, "text", { text: answer }); job.messages.push({ role: "assistant", content: [{ type: "text", text: answer }] } as ModelMessage); }
      }
      job.result = answer;
      if (ctl.stop) { this.setStatus(job, "paused"); return; }
      this.emit(job, "done", { text: job.result });
      this.setStatus(job, "completed");
    } catch (e) {
      if (ctl.stop) {
        // Stopped while the model was writing. Keep every finished step, plus results of changes that ran outside a
        // finished step (an approved change runs before the first step) - otherwise it could run again on Continue.
        keepFinished(job, stepMessages, toolResults, "The person pressed Stop.");
        job.partial = undefined;
        if (block.trim()) this.emit(job, "text", { text: block.trim() + " …" });
        this.setStatus(job, "paused", { note: "Stopped." });
        return;
      }
      job.error = friendlyAiError((e as Error).message);
      log("error", "job failed", { site: job.siteId, job: job.id, error: (e as Error).message });
      this.emit(job, "error", { error: job.error });
      this.setStatus(job, "failed", { error: job.error });
    }
  }
}

/**
 * Keep the finished part of a run that ended early (Stop, or a server restart): finished steps, plus results of tools
 * whose step did not finish. A result whose tool call is already in the conversation is saved as a tool result;
 * otherwise (its step was lost) the model gets a note naming it, so a write or a paid image is never done twice.
 */
function keepFinished(job: Job, steps: ModelMessage[], tools: { toolCallId: string; toolName: string; output: unknown; error?: string }[], why: string) {
  const ids = (msgs: ModelMessage[], type: string) => {
    const out = new Set<string>();
    for (const m of msgs) if (Array.isArray(m.content)) for (const p of m.content as any[]) if (p.type === type && p.toolCallId) out.add(p.toolCallId);
    return out;
  };
  // Keep finished steps up to the first one with a tool call that has no result (an invalid conversation otherwise).
  const allResults = ids(steps, "tool-result");
  let keep = steps.length;
  for (let i = 0; i < steps.length; i++) {
    const m = steps[i];
    if (m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((p) => p.type === "tool-call" && !allResults.has(p.toolCallId))) { keep = i; break; }
  }
  const kept = steps.slice(0, keep);
  const answered = ids(kept, "tool-result");
  const earlierCalls = ids(job.messages, "tool-call"); // e.g. a change approved before this run
  const orphans = tools.filter((t) => t.toolCallId && !answered.has(t.toolCallId));
  const known = orphans.filter((t) => earlierCalls.has(t.toolCallId));
  if (known.length) {
    job.messages.push({ role: "tool", content: known.map((t) => ({ type: "tool-result", toolCallId: t.toolCallId, toolName: t.toolName,
      output: t.error ? { type: "error-text", value: t.error } : { type: "json", value: t.output ?? null } })) } as ModelMessage);
  }
  job.messages.push(...kept);
  const lost = orphans.filter((t) => !earlierCalls.has(t.toolCallId));
  if (lost.length) {
    const lines = lost.map((t) => `- ${t.toolName}: ${t.error ? "failed: " + t.error : JSON.stringify(t.output ?? null).slice(0, 600)}`);
    job.messages.push({ role: "user", content: `[${why} These tools had ALREADY RUN - use their results, do not run them again:\n${lines.join("\n")}]` } as ModelMessage);
  }
}

/** A short answer built from what the run did, for when the model ended without one. */
function fallbackAnswer(tools: { toolName: string; output: any; error?: string }[]): string {
  const lines: string[] = [];
  for (const t of tools) {
    const v = t.output;
    if (t.error || !v || v.ok === false) continue;
    if (t.toolName === "create_blog_post") lines.push(`Created the blog post as a draft (${v.words ?? "?"} words)${v.preview ? `: ${v.preview}` : ""}.`);
    else if (t.toolName === "create_page") lines.push(`Created the page as a draft${v.preview ? `: ${v.preview}` : ""}.`);
    else if (t.toolName === "generate_image") lines.push("Generated the image and added it to the Media Library.");
    else if (WRITE_TOOLS.has(t.toolName) && v.change?.summary) lines.push(`${v.change.summary} (draft).`);
  }
  if (!lines.length) return "";
  return `Done.\n${lines.map((l) => "- " + l).join("\n")}\nEverything is a draft: preview it, and Deploy when it looks right.`;
}

/** Small, safe bits of a tool result the chat UI needs (screenshot ids, which file changed) - never whole file contents. */
function uiSummary(tool: string | undefined, v: any): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || v.ok === false) return undefined;
  if (tool === "screenshot_page" && v.screenshotId) return { screenshotId: v.screenshotId, device: v.device, target: v.target };
  if (tool === "create_blog_post") {
    return { changeId: v.changeId, summary: v.change?.summary, status: "draft", id: v.id, link: v.preview, preview: v.preview, edit: v.edit, words: v.words, image: v.featured_media?.url,
      categories: v.categories?.map((t: any) => t.name), tags: v.tags?.map((t: any) => t.name) };
  }
  if (tool === "make_change" || tool === "create_page" || tool === "revert_change" || tool === "place_component") {
    return { changeId: v.changeId, summary: v.change?.summary, status: v.change?.status, preview: v.preview, checks: v.verification ? { passed: v.verification.passed, summary: v.verification.summary } : undefined };
  }
  if (tool === "edit_file" || tool === "restore_file" || tool === "create_file") return { path: v.path, backupId: v.backupId, verifiedLive: v.verifiedLive, created: v.created };
  if (tool === "create_page" || tool === "create_post" || tool === "edit_post_content" || tool === "set_post_status") return { id: v.id, link: v.link, status: v.status };
  if (tool === "upload_media_from_chat" || tool === "upload_media_from_url" || tool === "generate_image") return { mediaId: v.id, url: v.url };
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

/**
 * What the assistant should know before it starts: drafts not deployed yet, conflicts, changes made outside
 * Livecrafts since the last release (who / what), the notes of the site and of the page the person is on, and the
 * MAP of that page - everything editable on it, with its current value.
 *
 * WHY THE MAP IS HERE NOW. Every turn used to open with the same three tool calls - site_status, read_notes,
 * get_page_map - three model round trips, about eighteen seconds, before any work began. Two of the three were
 * already being handed over in this very text and the model fetched them again anyway, because its instructions
 * told it to. So the third one joins them, the instructions now say they are given, and a turn starts at the work.
 *
 * It is read fresh for every run (once per voice session, see sessions.ts) and any write empties that cache, so
 * what is pasted here is never older than the request it belongs to.
 */
async function siteContext(bridge: Bridge, pageUrl?: string, cache?: SiteCache | null): Promise<string> {
  const lines: string[] = [];
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => (cache ? cache.get(key, read) : read());
  // The status and the page map do not depend on each other, so they are asked for together; the notes need the
  // post id that the map returns, so they follow. Two waits instead of three.
  const mapUrl = pageUrl || bridge.homeUrl;
  const statusP = once("status", () => bridge.status());
  const mapP = once(`map:${mapUrl}:draft`, () => bridge.map({ url: mapUrl, view: "draft" })).catch(() => null);
  try {
    const s: any = await statusP;
    const drafts = (s.drafts?.objects ?? []) as any[];
    lines.push(drafts.length ? `Drafts not deployed yet (${s.drafts.count}):` : "No drafts: the preview equals the live site.");
    for (const o of drafts.slice(0, 8)) lines.push(`- ${o.object.label}: ${o.changes.slice(0, 6).map((c: any) => `#${c.id} ${c.summary} (${c.user?.name ?? c.source})`).join("; ")}`);
    if (s.conflicts?.length) lines.push(`Conflicts (live changed under a draft): ${s.conflicts.map((c: any) => c.object).join(", ")}`);
    const outside = (s.outside_changes_since_release ?? []) as any[];
    if (outside.length) lines.push(`Changed outside Livecrafts since the last release: ${outside.slice(0, 6).map((c: any) => `#${c.id} ${c.object?.label}: ${c.summary} - ${c.user?.name ?? "?"}, ${c.at}`).join("; ")}`);
    if (s.last_release) lines.push(`Last release: #${s.last_release.id} ${s.last_release.kind} - ${s.last_release.summary} (${s.last_release.at})`);
    if (s.legacy_overlay) lines.push("This site still has an old Livecrafts 0.9 overlay (see site_status).");
  } catch (e) { lines.push(`(Could not read the site status: ${(e as Error).message})`); }
  const map: any = await mapP;
  try {
    const post = Number(map?.post?.id) || undefined;
    const n: any = await once(`notes:${post ?? ""}`, () => bridge.notes(post));
    if (n.site?.text) lines.push(`\nYOUR SITE NOTES:\n${String(n.site.text).slice(0, 4000)}`);
    if (n.page?.text) lines.push(`\nYOUR NOTES FOR THIS PAGE:\n${String(n.page.text).slice(0, 4000)}`);
    if (!n.site?.text && !n.page?.text) lines.push("No notes yet - write them as you learn the site (write_notes).");
  } catch { /* notes are optional */ }
  if (map) lines.push(`\nTHIS PAGE, MAPPED (get_page_map for ${mapUrl}, draft view - do not call it again for this page unless you change it):\n${mapText(map)}`);
  return lines.join("\n");
}

/**
 * The page map as the model gets it from the tool, trimmed to what fits in front of every request.
 *
 * The tool's own view allows 200 values and two 250-line outlines, which on a built page is thousands of tokens
 * re-sent on every step of the turn. Sixty values and sixty outline lines keep what makes the map worth having -
 * the target ids and what is currently in them - and the tool is still there for the rest.
 */
function mapText(map: any, limit = 6000): string {
  const c: any = compactMap(map);
  const short = {
    post: c.post, builders: c.builders, drafts: c.drafts,
    values: (c.values ?? []).slice(0, 60).map((v: any) => ({ ...v, value: String(v.value ?? "").slice(0, 120) })),
    acfRows: c.acfRows,
    elementorOutline: c.elementorOutline?.slice(0, 60),
    diviOutline: c.diviOutline?.slice(0, 60),
    howToChange: c.howToChange,
  };
  const text = JSON.stringify(short);
  if (text.length <= limit) return text;
  // Still too big (a page with very long field values): keep the shape, drop the tail, and say so rather than
  // letting the model believe it has seen everything.
  return text.slice(0, limit) + " …TRUNCATED - call get_page_map for the full map of this page.";
}
