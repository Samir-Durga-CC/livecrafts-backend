export interface Hosting { provider: "hostinger"; username: string; domain: string; dir: string }
export interface Site { id: string; name: string; url: string; username: string; createdAt: string; hosting?: Hosting | null }

export interface HostingerHealth {
  configured: boolean; connected: boolean; tokenSource: "env" | "saved" | "none";
  websites?: number; accounts?: string[]; error?: string; checkedAt: string;
}

export type JobStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

export interface Pending { approvalId: string; toolName: string; input: any; current?: unknown }

/** One applied change of a chat, with what is needed to revert it (from the backend ledger). */
export interface ChangeRecord {
  id: string; tool: string; title: string; key: string; at: string; link?: string;
  revert: { kind: string } | null; note?: string; revertedAt?: string; revertError?: string;
}

export interface JobSummary {
  id: string; siteId: string; prompt: string; status: JobStatus; pending: Pending[];
  result?: string; error?: string; createdAt: string; updatedAt: string; lastEventSeq: number; changes?: ChangeRecord[];
}

export interface JobEvent { seq: number; ts: string; type: string; data: Record<string, any> }

export interface UploadedFile { id: string; filename: string; mime: string; bytes: number }

/** What the chat actually draws, built from the raw job events. */
export type TimelineItem =
  | { kind: "user"; seq: number; text: string; fileIds: string[] }
  | { kind: "assistant"; seq: number; text: string; streaming?: boolean }
  | { kind: "tool"; seq: number; tool: string; input: any; state: "running" | "ok" | "failed"; error?: string; ui?: Record<string, any>; changeId?: string }
  | { kind: "approval"; seq: number; approvalId: string; tool: string; input: any; current?: unknown; answer?: { approved: boolean; reason?: string } }
  | { kind: "error"; seq: number; text: string };
