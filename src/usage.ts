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

/**
 * Token counts from an AI SDK usage object (shapes differ a little between versions and providers).
 *
 * The cached count is read from `inputTokenDetails.cacheReadTokens`, which is where this SDK puts it. It used to be
 * read from two field names that do not exist, so every row said "0 cached" and the cost view was simply wrong:
 * the provider was in fact serving about three quarters of each prompt from cache. A cost number nobody can trust
 * is worse than no cost number, because it gets planned around. The older spellings are still tried, in case a
 * provider or a version uses them.
 */
export function tokensOf(u: any): Pick<UsageRow, "input" | "output" | "cachedInput" | "reasoning" | "total"> {
  const num = (v: any) => (typeof v === "number" ? v : typeof v?.total === "number" ? v.total : 0);
  const input = num(u?.inputTokens), output = num(u?.outputTokens);
  const cached = u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens ?? u?.inputTokens?.cacheRead;
  const reasoning = u?.outputTokenDetails?.reasoningTokens ?? u?.reasoningTokens ?? u?.outputTokens?.reasoning;
  return {
    input, output,
    cachedInput: typeof cached === "number" ? cached : undefined,
    reasoning: typeof reasoning === "number" ? reasoning : undefined,
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

/** The months there is usage for, newest first. */
export function usageMonths(): string[] {
  try {
    return fs.readdirSync(dir("usage")).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 7)).sort().reverse();
  } catch { return []; }
}

/**
 * Which company's meter is running. The model name is all we store, so it is all we can go on: a name we do not
 * recognise is reported as itself rather than guessed at, so a new provider shows up as unknown instead of wrong.
 */
export function providerOf(model: string): string {
  const m = model.toLowerCase();
  if (/^(claudecli:)?(opus|sonnet|haiku)|^claude[-.]/.test(m)) return "Anthropic";
  if (/^(gpt|o[134])[-.\d]|^chatgpt|^text-embedding/.test(m)) return "OpenAI";
  if (/^gemini|^google\//.test(m)) return "Google";
  if (/^(llama|mixtral|mistral|qwen|deepseek|kimi)/.test(m)) return "Open models";
  const slash = m.indexOf("/");
  return slash > 0 ? m.slice(0, slash) : "Other";
}

export interface UsageBucket { key: string; label?: string; calls: number; input: number; cachedInput: number; output: number; reasoning: number; total: number; ms: number }
export interface UsageReport {
  month: string; months: string[]; rows: number;
  totals: UsageBucket;
  byProvider: UsageBucket[];
  byModel: (UsageBucket & { provider: string })[];
  byDay: { day: string; total: number; input: number; output: number; calls: number }[];
  bySite: UsageBucket[];
  busiest: { job: string; site: string; model: string; total: number; steps: number; at: string }[];
}

const empty = (key: string, label?: string): UsageBucket => ({ key, label, calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, ms: 0 });
const add = (b: UsageBucket, r: UsageRow) => {
  b.calls++; b.input += r.input || 0; b.cachedInput += r.cachedInput || 0; b.output += r.output || 0;
  b.reasoning += r.reasoning || 0; b.total += r.total || 0; b.ms += r.ms || 0;
  return b;
};
const into = (map: Map<string, UsageBucket>, key: string, r: UsageRow, label?: string) => {
  if (!map.has(key)) map.set(key, empty(key, label));
  add(map.get(key)!, r);
};
const biggestFirst = (m: Map<string, UsageBucket>) => [...m.values()].sort((a, b) => b.total - a.total);

/**
 * One month of model calls, added up the ways worth looking at: who is being paid, which model, which day, which
 * website, and the jobs that cost the most. Read from the same append-only file the agent writes as it works.
 */
export function usageReport(month: string, opts: { site?: string; siteName?: (id: string) => string | undefined } = {}): UsageReport {
  const rows = readUsage(month, (r) => !opts.site || r.site === opts.site);
  const totals = empty("all");
  const providers = new Map<string, UsageBucket>(), models = new Map<string, UsageBucket>(), sites = new Map<string, UsageBucket>();
  const days = new Map<string, { day: string; total: number; input: number; output: number; calls: number }>();
  const jobs = new Map<string, { job: string; site: string; model: string; total: number; steps: number; at: string }>();

  for (const r of rows) {
    add(totals, r);
    into(providers, providerOf(r.model), r);
    into(models, r.model, r, providerOf(r.model));
    if (r.site) into(sites, r.site, r, opts.siteName?.(r.site));
    const day = String(r.at ?? "").slice(0, 10);
    if (day) {
      const d = days.get(day) ?? { day, total: 0, input: 0, output: 0, calls: 0 };
      d.total += r.total || 0; d.input += r.input || 0; d.output += r.output || 0; d.calls++;
      days.set(day, d);
    }
    if (r.job) {
      const j = jobs.get(r.job) ?? { job: r.job, site: r.site, model: r.model, total: 0, steps: 0, at: r.at };
      j.total += r.total || 0; j.steps++; if (r.at < j.at) j.at = r.at;
      jobs.set(r.job, j);
    }
  }

  return {
    month, months: usageMonths(), rows: rows.length, totals,
    byProvider: biggestFirst(providers),
    byModel: biggestFirst(models).map((b) => ({ ...b, provider: b.label ?? providerOf(b.key) })),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    bySite: biggestFirst(sites),
    busiest: [...jobs.values()].sort((a, b) => b.total - a.total).slice(0, 10),
  };
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
