export interface Hosting { provider: "hostinger"; username: string; domain: string; dir: string }
export interface Site { id: string; name: string; url: string; username: string; createdAt: string; hosting?: Hosting | null }

export interface HostingerHealth {
  configured: boolean; connected: boolean; tokenSource: "env" | "saved" | "none";
  websites?: number; accounts?: string[]; error?: string; checkedAt: string;
}

export type JobStatus = "queued" | "running" | "waiting_approval" | "paused" | "completed" | "failed" | "interrupted";

export interface Pending { approvalId: string; toolName: string; input: any; current?: unknown }

export type ApprovalMode = "every" | "request" | "auto";

/** One change a chat made (a pointer to the site history in the plugin). */
export interface ChangeRecord {
  id: string; pluginId?: number; tool: string; title: string; key: string; at: string; link?: string; status?: string;
  revert: { kind: string } | null; note?: string; revertedAt?: string; revertError?: string;
  requestId?: number; request?: string; diff?: { label: string; language?: string } | null;
  verification?: { passed: boolean; summary: string };
}

/** A change in the site history (from the plugin): any source - the assistant, the widget, WP admin, Elementor. */
export interface SiteChange {
  id: number; status: "draft" | "live" | "discarded"; source: string; user: { id: number; login: string; name: string } | null;
  object: { type: string; id: number; label: string; url?: string }; kind: string; target: string; summary: string;
  release: number | null; reverts: number | null; at: string; payload: Record<string, any>;
  diff?: { path: string; before: string; after: string }[];
}

/** One option the plugin offers for a clicked element (POST /resolve) - applied without AI. */
export interface ResolvedAction {
  id: string; group: "content" | "style" | "layout" | "visibility" | "motion"; label: string;
  input: "text" | "html" | "url" | "image" | "color" | "size" | "select" | "spacing" | "switch" | "confirm" | "ask";
  value: any; options?: Record<string, string>; units?: string[];
  change: Record<string, any>; requires?: Record<string, any>;
}
export interface Resolved {
  ok: boolean; device: string; notes: string[];
  source: { kind: "elementor" | "block" | "acf" | "menu" | "theme" | "ambiguous"; label: string; post?: number; where?: string; edit_link?: string; type?: string };
  actions: ResolvedAction[];
  parent?: { label: string; elementor?: { doc: number; id: string }; block?: string };
  css_scopes?: { page: string; site: string } | null;
}

export interface SiteStatus {
  ok: boolean; ms: number; error?: string; plugin?: string | null; wp?: string | null; php?: string | null;
  user?: { login: string; can_edit_pages: boolean; can_edit_themes?: boolean } | null; themeFiles?: boolean; theme?: string | null; acf?: boolean; elementor?: boolean; checkedAt: string;
}

export interface ProviderInfo {
  id: string; name: string; needsBaseUrl?: boolean; examples: string[]; keyHelp: string;
  configured: boolean; keySource: "env" | "saved" | "none"; baseUrl?: string;
}

export interface AssistantInfo { botName?: string; welcome?: string; instructions?: string; model?: string; approvalMode?: ApprovalMode; accent?: string }

export interface DiffData { label: string; language: string; before: string; after: string }

export interface JobSummary {
  id: string; siteId: string; prompt: string; status: JobStatus; pending: Pending[];
  result?: string; error?: string; createdAt: string; updatedAt: string; lastEventSeq: number; changes?: ChangeRecord[];
  approvalMode?: ApprovalMode; model?: string | null; requestSeq?: number;
}

export interface JobEvent { seq: number; ts: string; type: string; data: Record<string, any> }

export interface UploadedFile { id: string; filename: string; mime: string; bytes: number }

/** What the chat actually draws, built from the raw job events. */
export type TimelineItem =
  | { kind: "user"; seq: number; text: string; fileIds: string[]; requestId?: number }
  | { kind: "assistant"; seq: number; text: string; streaming?: boolean }
  | { kind: "tool"; seq: number; tool: string; input: any; state: "running" | "ok" | "failed"; error?: string; ui?: Record<string, any>; changeId?: string }
  | { kind: "approval"; seq: number; approvalId: string; tool: string; input: any; current?: unknown; answer?: { approved: boolean; reason?: string } }
  | { kind: "error"; seq: number; text: string };
