/**
 * The bench: drive the real agent through a scripted conversation against a real site and report what happened.
 *
 *   npm run bench                      every scenario
 *   npm run bench -- elementor         one scenario
 *   npm run bench -- elementor --keep  do not revert the changes afterwards
 *   npm run bench -- --model anthropic:claude-opus-5
 *   npm run bench -- --voice            as the voice sends them: low reasoning effort, site context read once
 *
 * It is deliberately NOT the agent's own opinion of itself: after every turn the bench fetches the draft page and the
 * live page itself and checks the text, so a turn the agent reported as done but did not land is a FAIL here.
 * Everything lands in data/bench/<run>/ - trace.jsonl (every event) and report.md.
 */
import path from "node:path";
import fs from "node:fs";
import { config } from "../../src/config.js";
import { JsonStore } from "../../src/store.js";
import { FileStore } from "../../src/files.js";
import { buildAgent } from "../../src/agent.js";
import { JobRunner } from "../../src/jobs.js";
import { Bridge } from "../../src/bridge.js";
import type { Job, JobEvent, Site } from "../../src/types.js";
import { SCENARIOS, type Scenario, type Turn } from "./scenarios.js";

const argv = process.argv.slice(2);
const flagAt = (n: string) => argv.indexOf("--" + n);
const flag = (n: string) => { const i = flagAt(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes("--" + n);
const model = flag("model");
const keep = has("keep");
/** Drive the turns the way a voice session does (LC_VOICE_MODEL, low reasoning effort, context cached per session). */
const voice = has("voice");
const picked = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--model"));

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const jobs = new JsonStore<Job>(path.join(config.dataDir, "jobs"));
const runner = new JobRunner(jobs, sites, buildAgent(new FileStore()));

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(config.dataDir, "bench", runId);
fs.mkdirSync(outDir, { recursive: true });
const traceFile = path.join(outDir, "trace.jsonl");
const trace = (o: unknown) => fs.appendFileSync(traceFile, JSON.stringify(o) + "\n");

const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "s" : n + "ms");
const short = (v: unknown, n = 90) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return !s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const norm = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#0?39;|&rsquo;|[‘’]/g, "'").replace(/&(ldquo|rdquo);|[“”]/g, '"')
    .replace(/\s+/g, " ").toLowerCase();

/**
 * Infrastructure trouble, not the agent's doing: a TLS-intercepting VPN, a dropped socket, a slow host, the model
 * API unreachable. These turns are graded ENV and left OUT of the score - a suite that blames the agent for the
 * network tells you nothing, and the first instinct on a red run is to "fix" an agent that was never wrong.
 */
const ENV_TROUBLE = /self-signed certificate|certificate chain|Cannot connect to API|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|aborted due to timeout|Cannot reach|502 Bad Gateway|503|504 Gateway/i;
const isEnv = (s?: string) => !!s && ENV_TROUBLE.test(s);

interface ToolCall { tool: string; input: unknown; ok?: boolean; error?: string; ms: number }
interface Check { name: string; ok: boolean; detail: string }
interface TurnResult {
  n: number; say: string; status: string; ms: number; error?: string;
  tools: ToolCall[];
  changes: { title: string; key: string; verified?: boolean; summary?: string }[];
  reply: string;
  usage?: { input: number; output: number; calls: number };
  checks: Check[];
  grade: "PASS" | "FAIL" | "WARN" | "ENV";
}

/**
 * A page as text. The draft view uses a fresh preview token, so it needs no login. Retried: these sites answer in
 * 90ms or 2.7s depending on the hour, and a single slow response must not be reported as a missing change.
 */
async function pageText(bridge: Bridge, url: string, view: "draft" | "live"): Promise<string> {
  let last: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let target = url + (url.includes("?") ? "&" : "?") + "nc=" + Date.now();
      if (view === "draft") {
        const t = await bridge.previewToken();
        target += `&${t.param}=${t.token}`;
      }
      const r = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(45000) });
      const body = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} on the ${view} page`);
      if (/There has been a critical error|<b>Fatal error<\/b>|Uncaught (Error|TypeError)/i.test(body)) throw new Error(`PHP error on the ${view} page`);
      return norm(body);
    } catch (err) {
      last = err as Error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2500));
    }
  }
  throw last;
}

async function runTurn(
  scenario: Scenario, jobId: string | null, turn: Turn, n: number, bridge: Bridge, pageUrl: string,
): Promise<{ jobId: string; result: TurnResult }> {
  const tools: ToolCall[] = [];
  const changes: TurnResult["changes"] = [];
  const texts: string[] = [];
  const startedAt = new Map<string, number>();
  let failure: string | undefined;

  const onEvent = (e: JobEvent) => {
    trace({ runId, scenario: scenario.id, turn: n, ...e });
    const d = e.data as Record<string, any>;
    if (e.type === "tool_start") {
      startedAt.set(String(d.tool), Date.now());
      tools.push({ tool: String(d.tool), input: d.input, ms: 0 });
    }
    if (e.type === "tool_end") {
      const open = [...tools].reverse().find((t) => t.tool === d.tool && t.ok === undefined);
      if (open) {
        open.ok = !!d.ok;
        open.error = d.error ? String(d.error) : undefined;
        open.ms = Date.now() - (startedAt.get(String(d.tool)) ?? Date.now());
      }
    }
    if (e.type === "change") {
      const c = (d.change ?? {}) as Record<string, any>;
      changes.push({ title: String(c.title ?? ""), key: String(c.key ?? ""), verified: c.verification?.passed, summary: c.verification?.summary });
    }
    if (e.type === "text") texts.push(String(d.text ?? ""));
    if (e.type === "error") failure = String(d.error ?? "");
  };

  const began = Date.now();
  const before = (jobId && runner.get(jobId)?.usage) || { input: 0, output: 0, calls: 0 };
  const job = jobId
    ? runner.continue(jobId, turn.say, undefined, [], { approvalMode: "auto", model, pageUrl, voice })
    : runner.create(scenario.siteId, turn.say, undefined, [], { approvalMode: "auto", model, pageUrl, voice });
  // subscribe from before the events this turn already emitted (user + status), so nothing is missed
  const unsub = runner.subscribe(job.id, onEvent, Math.max(0, (runner.get(job.id)?.events.at(-1)?.seq ?? 1) - 2));

  let settled: Job;
  try { settled = await runner.waitUntilSettled(job.id); } finally { unsub(); }
  const took = Date.now() - began;

  // ---- the bench's own checks: look at the site, do not take the agent's word for it
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const err0 = failure ?? settled.error;
  add("job completed", settled.status === "completed", settled.status === "completed" ? "" : `status=${settled.status}${err0 ? " — " + err0 : ""}`);

  // The job never really ran (the model API was unreachable): checking the page would only restate that, as a
  // content failure the agent would be blamed for. Report the infrastructure and judge nothing else.
  const deadEnd = settled.status !== "completed" && isEnv(err0);

  const e = deadEnd ? {} : turn.expect ?? {};
  if (turn.readOnly && !deadEnd) add("no write", changes.length === 0, changes.length ? `wrote ${changes.length} change(s) on a read-only turn` : "nothing written, correct");
  if (e.tool) add(`used ${e.tool}`, tools.some((t) => t.tool === e.tool), tools.map((t) => t.tool).join(", ") || "no tools at all");
  if (e.changed) add("changed something", changes.length > 0, changes.length ? "" : "the turn asked for a change and nothing was written");

  if (e.draft?.length || e.notDraft?.length) {
    try {
      const txt = await pageText(bridge, pageUrl, "draft");
      for (const s of e.draft ?? []) add(`draft has "${short(s, 34)}"`, txt.includes(norm(s)), txt.includes(norm(s)) ? "" : "not on the draft page");
      for (const s of e.notDraft ?? []) add(`draft lost "${short(s, 34)}"`, !txt.includes(norm(s)), txt.includes(norm(s)) ? "the old text is still there" : "");
    } catch (err) { add("draft page", false, (err as Error).message); }
  }
  if (e.notLive?.length) {
    try {
      const txt = await pageText(bridge, pageUrl, "live");
      for (const s of e.notLive) add(`live clean of "${short(s, 30)}"`, !txt.includes(norm(s)), txt.includes(norm(s)) ? "VISITORS CAN SEE IT — the draft leaked live" : "");
    } catch (err) { add("live page", false, (err as Error).message); }
  }
  for (const c of changes) if (c.verified === false) add("agent self-check", false, c.summary || c.title);

  const err = err0;
  // Infrastructure failed: say so instead of blaming the agent. A check that could not run is not a check that failed.
  const envBroke = isEnv(err) || checks.some((c) => !c.ok && isEnv(c.detail));
  const broke = checks.some((c) => !c.ok && !isEnv(c.detail));
  const usage = settled.usage;
  return {
    jobId: job.id,
    result: {
      n, say: turn.say, status: settled.status, ms: took, error: err,
      tools, changes, reply: texts.join("\n").trim(),
      usage: usage ? { input: usage.input - before.input, output: usage.output - before.output, calls: usage.calls - before.calls } : undefined,
      checks,
      grade: envBroke && !broke ? "ENV" : broke ? "FAIL" : tools.some((t) => t.ok === false) ? "WARN" : "PASS",
    },
  };
}

// ------------------------------------------------------------------ run

const chosen = SCENARIOS.filter((s) => !picked.length || picked.includes(s.id));
if (!chosen.length) {
  console.error(`No scenario matched ${JSON.stringify(picked)}. Have: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

const report: string[] = [`# Livecrafts bench — ${runId}`, "", `model: \`${voice ? config.voiceModel || model || config.model : model ?? config.model}\`${voice ? "  ·  voice path (low reasoning effort, context cached per session)" : ""}  ·  trace: \`${path.relative(process.cwd(), traceFile)}\``, ""];
let passed = 0, total = 0, envSkipped = 0;

for (const scenario of chosen) {
  const site = sites.get(scenario.siteId);
  if (!site) { console.error(`! ${scenario.id}: unknown site ${scenario.siteId}`); continue; }
  const bridge = new Bridge(site);
  const pageUrl = scenario.page ?? site.url + "/";
  const bar = "=".repeat(96);
  console.log(`\n${bar}\n${scenario.id}  —  ${pageUrl}\n  ${scenario.builder}\n${bar}`);
  report.push(`## ${scenario.id} — ${scenario.builder}`, "", `page: ${pageUrl}`, "");

  let jobId: string | null = null;
  const results: TurnResult[] = [];

  for (const [i, turn] of scenario.turns.entries()) {
    console.log(`\n── turn ${i + 1}/${scenario.turns.length}  "${turn.say}"`);
    let r: TurnResult;
    // One retry when the infrastructure (not the agent) broke: a flapping VPN must not cost a whole run.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await runTurn(scenario, jobId, turn, i + 1, bridge, pageUrl);
        jobId = out.jobId;
        r = out.result;
      } catch (err) {
        const m = (err as Error).message;
        console.log(`  !! bench error: ${m}`);
        r = { n: i + 1, say: turn.say, status: "bench_error", ms: 0, error: m, tools: [], changes: [], reply: "", checks: [{ name: "bench", ok: false, detail: m }], grade: isEnv(m) ? "ENV" : "FAIL" };
      }
      if (r!.grade !== "ENV" || attempt === 2) break;
      console.log(`  ENV trouble (${short(r!.error, 90)}) — waiting 20s and retrying this turn once`);
      await new Promise((res) => setTimeout(res, 20000));
    }
    results.push(r!);
    if (r!.grade === "ENV") envSkipped++;
    else { total++; if (r!.grade === "PASS") passed++; }
    r = r!;

    for (const t of r.tools) {
      console.log(`     ${t.ok === false ? "✗" : t.ok ? "✓" : "·"} ${t.tool.padEnd(22)} ${ms(t.ms).padStart(7)}  ${short(t.input, 70)}`);
      if (t.error) console.log(`        ↳ ${short(t.error, 160)}`);
    }
    for (const c of r.changes) console.log(`     ▸ ${c.title}${c.verified === false ? `  [self-check FAILED: ${short(c.summary, 64)}]` : ""}`);
    console.log(`  ${r.grade}  ${ms(r.ms)}  ${r.tools.length} tools, ${r.changes.length} changes, ${r.usage?.calls ?? 0} model calls`);
    for (const c of r.checks.filter((x) => !x.ok)) console.log(`     ✗ ${c.name}: ${c.detail}`);
  }

  report.push("| # | request | grade | time | tools | changes | failed checks |", "|---|---|---|---|---|---|---|");
  for (const r of results) {
    report.push(`| ${r.n} | ${r.say.replace(/\|/g, "/")} | **${r.grade}** | ${ms(r.ms)} | ${r.tools.length} | ${r.changes.length} | ${r.checks.filter((c) => !c.ok).map((c) => c.name).join("; ") || "—"} |`);
  }
  report.push("");
  for (const r of results) {
    report.push(`### Turn ${r.n} — ${r.grade}`, "", `> ${r.say}`, "");
    report.push("```");
    for (const t of r.tools) {
      report.push(`${t.ok === false ? "✗" : "✓"} ${t.tool.padEnd(22)} ${ms(t.ms).padStart(7)}  ${short(t.input, 110)}`);
      if (t.error) report.push(`   ↳ ${short(t.error, 220)}`);
    }
    report.push("```");
    if (r.changes.length) report.push("", ...r.changes.map((c) => `- ${c.title}${c.verified === false ? ` — **self-check failed**: ${c.summary}` : ""}`));
    if (r.checks.some((c) => !c.ok)) report.push("", "**Failed checks**", ...r.checks.filter((c) => !c.ok).map((c) => `- \`${c.name}\` — ${c.detail}`));
    if (r.reply) report.push("", "<details><summary>reply</summary>", "", r.reply, "", "</details>");
    report.push("");
  }

  // ---- cleanup: revert this run's changes, newest first, so the next run starts from the same place
  if (!keep && jobId) {
    const made = (runner.get(jobId)?.changes ?? []).filter((c) => c.revert && !c.revertedAt);
    if (made.length) {
      console.log(`\n  reverting ${made.length} change(s)…`);
      let failures = 0;
      for (const c of [...made].reverse()) {
        try { await bridge.revert(c.pluginId, "bench"); }
        catch (err) { failures++; console.log(`   ✗ revert ${c.id}: ${(err as Error).message}`); }
      }
      console.log(`  reverted ${made.length - failures}/${made.length}`);
      report.push(`_cleanup: reverted ${made.length - failures}/${made.length} changes._`, "");
    }
  } else if (keep) {
    report.push("_cleanup: skipped (--keep)._", "");
  }
}

const score = `**${passed}/${total} turns passed**${envSkipped ? ` (${envSkipped} more could not be judged - infrastructure, see ENV)` : ""}.`;
report.splice(3, 0, score, "");
const reportFile = path.join(outDir, "report.md");
fs.writeFileSync(reportFile, report.join("\n"));
console.log(`\n${"=".repeat(96)}\n${passed}/${total} turns passed${envSkipped ? `  ·  ${envSkipped} ENV (not the agent's fault)` : ""}\nreport: ${reportFile}\ntrace:  ${traceFile}\n`);
process.exit(passed === total ? 0 : 1);
