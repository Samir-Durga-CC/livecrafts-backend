import type { ApprovalMode, AssistantInfo, ChangeRecord, DiffData, HostingerHealth, ProviderInfo, SiteStatus, JobEvent, JobSummary, Site, TimelineItem, UploadedFile } from "./types";

const TOKEN_KEY = "lc_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Inside the WordPress widget: the person's signed token from the plugin (per person, per site, short-lived). */
let widgetToken = "";
export const setWidgetToken = (t: string) => { widgetToken = t; };

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const t = getToken();
  return { ...(widgetToken ? { "X-Livecrafts-Widget": widgetToken } : t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined ? { "Content-Type": "application/json" } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface SendArgs { prompt: string; fileIds: string[]; pageUrl?: string; selectedTarget?: string; approvalMode?: ApprovalMode; model?: string; extraContext?: string; kind?: "new" | "note" | "edit" }

export const api = {
  health: () => request<{ ok: boolean; model: string; authRequired: boolean }>("GET", "/health"),
  sites: () => request<Site[]>("GET", "/sites"),
  previewToken: (siteId: string) => request<{ token: string; param: string }>("POST", `/sites/${siteId}/preview-token`, {}),
  addSite: (b: { name: string; url: string; username: string; appPassword: string }) => request<Site & { plugin?: any; reconnected?: boolean; hostingNote?: string | null }>("POST", "/sites", b),
  deleteSite: (id: string) => request("DELETE", `/sites/${id}`),
  updateSite: (id: string, b: { name?: string; username?: string; appPassword?: string }) => request<Site>("PUT", `/sites/${id}`, b),
  siteStatus: (id: string) => request<SiteStatus>("GET", `/sites/${id}/status`),
  assistant: (id: string, fresh = false) => request<AssistantInfo>("GET", `/sites/${id}/assistant${fresh ? "?fresh=1" : ""}`),
  deleteJob: (id: string) => request("DELETE", `/jobs/${id}`),
  setApprovalMode: (jobId: string, mode: ApprovalMode) => request<JobSummary>("PUT", `/jobs/${jobId}/approval-mode`, { mode }),
  revertRequest: (jobId: string, requestId: number) => request<{ ok: boolean; reverted: number }>("POST", `/jobs/${jobId}/requests/${requestId}/revert`),
  changeDiff: (jobId: string, changeId: string) => request<DiffData>("GET", `/jobs/${jobId}/changes/${changeId}/diff`),
  saveProvider: (id: string, b: { apiKey?: string; baseUrl?: string; testModel?: string }) => request<{ ok: boolean; models: ProviderInfo[]; test?: { ok: boolean; reply?: string; ms: number } }>("PUT", `/integrations/models/${id}`, b),
  removeProvider: (id: string) => request<{ ok: boolean; models: ProviderInfo[] }>("DELETE", `/integrations/models/${id}`),
  testModel: (model: string) => request<{ ok: boolean; reply?: string; error?: string; ms: number }>("POST", "/integrations/models/test", { model }),
  jobs: () => request<JobSummary[]>("GET", "/jobs"),
  job: (id: string) => request<JobSummary>("GET", `/jobs/${id}`),
  createJob: (siteId: string, a: SendArgs) => request<JobSummary>("POST", "/jobs", { siteId, ...a }),
  message: (jobId: string, a: SendArgs) => request<JobSummary>("POST", `/jobs/${jobId}/messages`, a),
  approve: (jobId: string, approvalId: string, approved: boolean, reason?: string) => request<JobSummary>("POST", `/jobs/${jobId}/approvals`, { approvalId, approved, reason }),
  stop: (jobId: string) => request<JobSummary>("POST", `/jobs/${jobId}/stop`),
  resume: (jobId: string) => request<JobSummary>("POST", `/jobs/${jobId}/resume`),
  revertChange: (jobId: string, changeId: string) => request<Record<string, unknown>>("POST", `/jobs/${jobId}/changes/${changeId}/revert`),
  linkHosting: (siteId: string) => request<Site>("POST", `/sites/${siteId}/link-hosting`),

  integrations: () => request<{ hostinger: HostingerHealth; models: ProviderInfo[]; defaultModel: string }>("GET", "/integrations"),
  testHostinger: () => request<HostingerHealth>("POST", "/integrations/hostinger/test"),
  saveHostinger: (token: string) => request<HostingerHealth>("PUT", "/integrations/hostinger", { token }),
  removeHostinger: () => request<HostingerHealth>("DELETE", "/integrations/hostinger"),

  voiceInfo: () => request<{ available: boolean; voice: string; voices: string[] }>("GET", "/voice"),
  /** Recorded speech -> text ("" when nothing was said). */
  async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    const res = await fetch("/voice/transcribe", { method: "POST", headers: authHeaders({ "Content-Type": audio.type || "audio/webm" }), body: audio, signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `Transcription failed (HTTP ${res.status})`);
    return String((data as any).text ?? "");
  },
  /** Text -> speech (mp3). */
  async speech(text: string, voice: string, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch("/voice/speak", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ text, voice }), signal });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new ApiError(res.status, (data as any).error ?? `Speech failed (HTTP ${res.status})`); }
    return res.blob();
  },

  async uploadFile(file: File): Promise<UploadedFile> {
    const res = await fetch("/files", { method: "POST", headers: authHeaders({ "Content-Type": file.type, "x-filename": file.name }), body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `Upload failed (HTTP ${res.status})`);
    return data as UploadedFile;
  },
};

// Attached images need the auth header too, so fetch them as blobs (and remember them).
const blobCache = new Map<string, string>();
export async function fileUrl(id: string): Promise<string> {
  const hit = blobCache.get(id);
  if (hit) return hit;
  const res = await fetch(id.startsWith("shot_") ? `/screens/${id}` : `/files/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("image unavailable");
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(id, url);
  return url;
}

/**
 * Follow a job's progress (Server-Sent Events over fetch, so the auth header works).
 * Reconnects by itself and resumes after the last event it saw, so closing the laptop or losing wifi loses nothing.
 */
export function followJob(jobId: string, onEvent: (e: JobEvent) => void, onState: (live: boolean) => void): () => void {
  const abort = new AbortController();
  let last = 0;
  (async () => {
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`/jobs/${jobId}/events?after=${last}`, { headers: authHeaders(), signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const e = JSON.parse(line.slice(6)) as JobEvent;
            if (e.type === "text_delta") onEvent(e); // live-only pieces carry the last saved seq
            else if (e.seq > last) { last = e.seq; onEvent(e); }
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
      }
      onState(false);
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => abort.abort();
}

/**
 * The widget lends this browser to the assistant: keep a live line open, receive "look at the page" requests,
 * answer them. Reconnects by itself. Returns a function that closes it.
 */
export function followEyes(siteId: string, pageUrl: string, viewport: number, onRequest: (r: { id: string; action: string; args: Record<string, unknown> }) => void): () => void {
  const abort = new AbortController();
  (async () => {
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`/sites/${siteId}/eyes?pageUrl=${encodeURIComponent(pageUrl)}&viewport=${viewport}`, { headers: authHeaders(), signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!/^event: request/m.test(block)) continue;
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) onRequest(JSON.parse(line.slice(6)));
          }
        }
      } catch { if (abort.signal.aborted) return; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => abort.abort();
}

export async function answerEyes(siteId: string, id: string, body: { ok: boolean; result?: unknown; error?: string }) {
  await fetch(`/sites/${siteId}/eyes/${id}`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }).catch(() => {});
}

/** Raw events -> the list of things the chat draws. */
export function buildTimeline(events: JobEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case "user": items.push({ kind: "user", seq: e.seq, text: (d.kind === "edit" ? "✏️ Correction: " : d.kind === "note" ? "📝 Note: " : "") + String(d.text ?? ""), fileIds: Array.isArray(d.fileIds) ? d.fileIds : [], requestId: typeof d.requestId === "number" ? d.requestId : undefined }); break;
      case "text_delta": {
        const lastItem = items[items.length - 1];
        if (lastItem && lastItem.kind === "assistant" && lastItem.streaming) lastItem.text += String(d.text ?? "");
        else items.push({ kind: "assistant", seq: e.seq, text: String(d.text ?? ""), streaming: true });
        break;
      }
      case "text": {
        // The finished text replaces the streamed pieces (or arrives on its own after a reload).
        const open = [...items].reverse().find((i) => i.kind === "assistant" && i.streaming);
        if (open && open.kind === "assistant") { open.text = String(d.text ?? ""); open.streaming = false; }
        else if (d.text) items.push({ kind: "assistant", seq: e.seq, text: String(d.text) });
        break;
      }
      case "tool_start": items.push({ kind: "tool", seq: e.seq, tool: String(d.tool), input: d.input, state: "running" }); break;
      case "tool_end": {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.tool === d.tool && it.state === "running") { it.state = d.ok ? "ok" : "failed"; it.error = d.error; it.ui = d.ui; it.changeId = d.changeId; break; }
        }
        break;
      }
      case "approval_request": items.push({ kind: "approval", seq: e.seq, approvalId: String(d.approvalId), tool: String(d.tool), input: d.input, current: d.current }); break;
      case "approval_response": {
        const card = items.find((i) => i.kind === "approval" && i.approvalId === d.approvalId);
        if (card && card.kind === "approval") card.answer = { approved: !!d.approved, reason: d.reason };
        break;
      }
      case "error": items.push({ kind: "error", seq: e.seq, text: String(d.error ?? "Something went wrong.") }); break;
      // "status" and "done" only drive the status pill; the final text already arrived as an assistant message.
    }
  }
  return items;
}

/** The change ledger as the events tell it ("change" adds, "change_update" replaces), on top of what the job had. */
export function ledgerFrom(initial: ChangeRecord[], events: JobEvent[]): Map<string, ChangeRecord> {
  const m = new Map<string, ChangeRecord>(initial.map((c) => [c.id, c]));
  for (const e of events) if ((e.type === "change" || e.type === "change_update") && e.data.change) m.set(e.data.change.id, e.data.change);
  return m;
}

export function lastStatus(events: JobEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "status") return String(events[i].data.status);
  return "queued";
}
