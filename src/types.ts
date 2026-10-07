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

/**
 * How changes get approved:
 *  every   - each write waits for a yes (most careful)
 *  request - the assistant shows its plan once per request; after one yes it carries out all steps
 *  auto    - no approval; every change is still verified and can be reverted
 */
export type ApprovalMode = "every" | "request" | "auto";
export const APPROVAL_MODES: ApprovalMode[] = ["every", "request", "auto"];

export type JobStatus = "queued" | "running" | "waiting_approval" | "paused" | "completed" | "failed" | "interrupted";

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
  approvalMode?: ApprovalMode;
  /** Number of the current person request (each new message is a new request). */
  requestSeq?: number;
  /** In "request" mode: the request whose plan the person approved (its writes no longer ask). */
  planApprovedFor?: number;
  /** Model for this chat ("provider:model"); empty = the site's / server's default. */
  model?: string;
  /** The page the person is on (default page for the assistant's reads and checks). */
  pageUrl?: string;
  /** The person in the chat (widget): every change is credited to them in the site history. */
  actor?: { name: string; login: string };
  /** Their signed widget token (short-lived; refreshed with every message / approval). */
  actorToken?: string;
  /** Tokens used by this chat so far. */
  usage?: { input: number; output: number; calls: number };
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
