import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Every model call (one agent step) with its token usage, and the backend's log lines - append-only JSON lines,
 * one file per month (usage) / per day (log), so they are cheap to write and easy to read back for the admin panel.
 *
 *   data/usage/2026-10.jsonl   {at, site, job, request, user, model, step, input, output, cachedInput, reasoning, total, ms, finish}
 *   data/logs/2026-10-07.jsonl {at, level, msg, site?, job?, ...}
 */
export interface UsageRow {
  at: string; site: string; job: string; request?: number; user?: string; model: string; step: number;
  input: number; output: number; cachedInput?: number; reasoning?: number; total: number; ms?: number; finish?: string;
}

const dir = (name: string) => { const d = path.join(config.dataDir, name); fs.mkdirSync(d, { recursive: true }); return d; };
const append = (file: string, row: unknown) => { try { fs.appendFileSync(file, JSON.stringify(row) + "\n"); } catch { /* never break a job over a log line */ } };

/** Token counts from an AI SDK usage object (shapes differ a little between versions and providers). */
export function tokensOf(u: any): Pick<UsageRow, "input" | "output" | "cachedInput" | "reasoning" | "total"> {
  const num = (v: any) => (typeof v === "number" ? v : typeof v?.total === "number" ? v.total : 0);
  const input = num(u?.inputTokens), output = num(u?.outputTokens);
  return {
    input, output,
    cachedInput: u?.cachedInputTokens ?? u?.inputTokens?.cacheRead ?? undefined,
    reasoning: u?.reasoningTokens ?? u?.outputTokens?.reasoning ?? undefined,
    total: typeof u?.totalTokens === "number" ? u.totalTokens : input + output,
  };
}

export function recordUsage(row: UsageRow) {
  append(path.join(dir("usage"), row.at.slice(0, 7) + ".jsonl"), row);
}

/** Usage rows of one month ("2026-10"), optionally filtered. */
export function readUsage(month: string, filter: (r: UsageRow) => boolean = () => true): UsageRow[] {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  try {
    return fs.readFileSync(path.join(dir("usage"), month + ".jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as UsageRow; } catch { return null; } }).filter((r): r is UsageRow => !!r && filter(r));
  } catch { return []; }
}

export type Level = "info" | "warn" | "error";
type Tail = (row: Record<string, unknown>) => void;
const tails = new Set<Tail>();

/** One log line: printed, appended to today's file, and sent to anyone following the live log. */
export function log(level: Level, msg: string, ctx: Record<string, unknown> = {}) {
  const row = { at: new Date().toISOString(), level, msg, ...ctx };
  append(path.join(dir("logs"), row.at.slice(0, 10) + ".jsonl"), row);
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${level}] ${msg}`, Object.keys(ctx).length ? JSON.stringify(ctx) : "");
  for (const t of tails) { try { t(row); } catch { /* a closed connection */ } }
}

/** Follow the log live (the admin panel's terminal view). Returns the function that stops it. */
export function followLog(t: Tail) { tails.add(t); return () => tails.delete(t); }

/** The last lines of one day's log ("2026-10-07"). */
export function readLog(day: string, limit = 500): Record<string, unknown>[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  try {
    return fs.readFileSync(path.join(dir("logs"), day + ".jsonl"), "utf8").split("\n").filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[];
  } catch { return []; }
}
