import type { ModelMessage } from "ai";
import type { ChangeRecord } from "./changes.js";

/** A WordPress site that has the Livecrafts plugin. DEV STORAGE: appPassword is kept in a local JSON file (encrypt before production). */
export interface Site {
  id: string;
  name: string;
  url: string;          // https://example.com (no trailing slash; may include a sub-directory)
  username: string;     // WordPress user that owns the Application Password
  appPassword: string;  // Users > Profile > Application Passwords
  createdAt: string;
  /** Where the site's files live on the hosting account (found automatically when Hostinger is connected). */
  hosting?: { provider: "hostinger"; username: string; domain: string; dir: string };
}

export type JobStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** filled when the user answers */
  approved?: boolean;
  reason?: string;
}

export interface JobEvent {
  seq: number;
  ts: string;
  type: "status" | "user" | "text_delta" | "tool_start" | "tool_end" | "text" | "approval_request" | "approval_response" | "error" | "done" | "change" | "change_update";
  data: Record<string, unknown>;
}

export interface Job {
  id: string;
  siteId: string;
  prompt: string;
  status: JobStatus;
  /** Full conversation, saved after every run. This is what lets a job pause for approval and resume later (even after a restart). */
  messages: ModelMessage[];
  pending: PendingApproval[];
  events: JobEvent[];
  /** Every successful write of this chat, with what is needed to revert it. */
  changes?: ChangeRecord[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
