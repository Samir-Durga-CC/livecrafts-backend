/**
 * PageSpeed reports: Google PageSpeed Insights (Lighthouse on Google's servers + Chrome UX Report data of real
 * visitors) for public sites, or Lighthouse in this machine's Chrome / Edge for a site Google cannot reach (localhost,
 * a private network address). Both give the same Lighthouse result, normalised here into one small report:
 * the four category scores, Core Web Vitals (real visitors when Google has them, plus the lab test), and the fixes
 * that matter most, each with a ready chat message for the assistant.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import { secrets } from "./secrets.js";

export type SpeedDevice = "mobile" | "desktop";
export type Rating = "good" | "needs-improvement" | "poor";

export interface SpeedMetric { id: string; name: string; hint: string; display: string; value: number | null; rating: Rating | null }
export interface SpeedFixItem { url?: string; label?: string; snippet?: string; selector?: string }
export interface SpeedFix {
  id: string; category: "performance" | "accessibility" | "best-practices" | "seo";
  title: string; detail: string;
  /** Estimated time saved (ms) or layout-shift saved, for sorting and the badge. */
  savingsMs: number; savingsBytes: number; savingsCls: number;
  items: SpeedFixItem[];
  /** The assistant can work on this through the site (blocks, Elementor, media, CSS); otherwise it explains what to change where. */
  assistant: boolean;
  /** The chat message "Fix with assistant" sends. */
  prompt: string;
}
export interface SpeedReport {
  device: SpeedDevice; url: string; finalUrl: string; fetchedAt: string;
  source: "google" | "local"; lighthouseVersion: string;
  scores: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
  /** Real visitors (Chrome UX Report, last 28 days) - only from Google, only when the page / site has enough traffic. */
  field: { scope: "page" | "site" | null; metrics: SpeedMetric[] };
  lab: SpeedMetric[];
  fixes: SpeedFix[];
  warnings: string[];
}
export interface SpeedRun {
  id: string; siteId: string; url: string; devices: SpeedDevice[];
  status: "running" | "done" | "failed"; error?: string;
  source: "google" | "local"; startedAt: string; finishedAt?: string;
  reports: SpeedReport[];
  /** Where the person is with each fix, keyed "<device>:<fix id>" (kept with the report, so it survives reloads). */
  fixState?: Record<string, FixMark>;
}
export type FixStatus = "progress" | "fixed" | "done" | "skipped";
export interface FixMark { status: FixStatus; jobId?: string; requestId?: number; at: string }

// ------------------------------------------------------------------------------------------------ where to run it

/** Google's servers cannot open these: localhost, *.local / *.test, private and link-local addresses. */
export function needsLocalRun(url: string): boolean {
  let h: string;
  try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return true; }
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".test") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------ Google PSI

export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

export class SpeedError extends Error { constructor(message: string, public code = "speed_failed") { super(message); } }

export async function runGoogle(url: string, device: SpeedDevice, apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 120_000): Promise<SpeedReport> {
  const q = new URL(PSI_ENDPOINT);
  q.searchParams.set("url", url);
  q.searchParams.set("strategy", device);
  for (const c of CATEGORIES) q.searchParams.append("category", c);
  if (apiKey) q.searchParams.set("key", apiKey);
  let res: Response;
  try { res = await fetchImpl(q, { signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) {
    const m = (e as Error).name === "TimeoutError" ? "Google did not answer within two minutes. Try again." : `Could not reach Google PageSpeed: ${(e as Error).message}`;
    throw new SpeedError(m, "unreachable");
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw googleError(res.status, body, !!apiKey);
  if (!body.lighthouseResult) throw new SpeedError("Google returned no Lighthouse result for this page.");
  return normalize(body.lighthouseResult, { device, url, source: "google", loading: body.loadingExperience, origin: body.originLoadingExperience });
}

function googleError(status: number, body: any, hasKey: boolean): SpeedError {
  const msg = String(body?.error?.message ?? `HTTP ${status}`);
  if (status === 429 || /quota|rate/i.test(msg)) {
    return new SpeedError(hasKey ? "Google's daily PageSpeed limit for this API key is used up. Try again tomorrow." : "Google limits PageSpeed tests without an API key. Add a free Google API key in Integrations → PageSpeed, then run it again.", "quota");
  }
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) return new SpeedError("The Google API key is not valid. Check it in Integrations → PageSpeed.", "bad_key");
  if (status === 403) return new SpeedError("Google refused the request: enable the \"PageSpeed Insights API\" for this key in Google Cloud Console.", "forbidden");
  if (/FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|DNS_FAILURE|NOT_HTML/i.test(msg)) {
    return new SpeedError("Google could not load the page (it may be offline, password-protected, or blocking bots). " + clip(msg, 160), "page_failed");
  }
  return new SpeedError("Google PageSpeed failed: " + clip(msg, 200));
}

// ------------------------------------------------------------------------------------------------ local Lighthouse

/** Chrome or Edge on this machine (LC_BROWSER_PATH first). */
export function findChrome(): string | null {
  const env = process.env.LC_BROWSER_PATH || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files", pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", local = process.env.LOCALAPPDATA ?? "";
  const candidates = process.platform === "win32" ? [
    path.join(pf, "Google\\Chrome\\Application\\chrome.exe"), path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    local && path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return (candidates.filter(Boolean) as string[]).find((p) => fs.existsSync(p)) ?? null;
}

let localQueue: Promise<unknown> = Promise.resolve();

/** Lighthouse in a headless Chrome / Edge on this machine. One at a time (it measures timing). */
export function runLocal(url: string, device: SpeedDevice): Promise<SpeedReport> {
  const job = localQueue.then(() => runLocalNow(url, device));
  localQueue = job.catch(() => {});
  return job;
}

async function runLocalNow(url: string, device: SpeedDevice): Promise<SpeedReport> {
  const chromePath = findChrome();
  if (!chromePath) throw new SpeedError("No Chrome or Edge found on this computer for a local speed test. Install one, or set LC_BROWSER_PATH in .env.", "no_browser");
  let lighthouse: any, launcher: any;
  try {
    lighthouse = (await import("lighthouse")).default;
    launcher = await import("chrome-launcher");
  } catch {
    throw new SpeedError("Lighthouse is not installed in the backend. Run `npm install` in the backend folder, then restart it.", "no_lighthouse");
  }
  const chrome = await launcher.launch({ chromePath, chromeFlags: ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"], logLevel: "silent" });
  try {
    const desktop = device === "desktop" ? (await import("lighthouse/core/config/desktop-config.js")).default : undefined;
    const r = await lighthouse(url, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: CATEGORIES }, desktop);
    if (!r?.lhr) throw new SpeedError("Lighthouse returned no result.");
    if (r.lhr.runtimeError?.code && r.lhr.runtimeError.code !== "NO_ERROR") throw new SpeedError(`Lighthouse could not test the page: ${r.lhr.runtimeError.message ?? r.lhr.runtimeError.code}`, "page_failed");
    const rep = normalize(r.lhr, { device, url, source: "local" });
    rep.warnings.unshift("Local test: Google cannot reach this address, so Lighthouse ran in this computer's browser. There is no real-visitor data, and scores depend on this computer's speed.");
    return rep;
  } finally {
    await Promise.resolve(chrome.kill()).catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------ normalise

const LAB: Array<[string, string, string]> = [
  ["largest-contentful-paint", "Largest Contentful Paint (LCP)", "when the biggest text or image appears"],
  ["cumulative-layout-shift", "Cumulative Layout Shift (CLS)", "how much things jump while loading"],
  ["total-blocking-time", "Total Blocking Time (TBT)", "how long scripts block clicks (lab stand-in for INP)"],
  ["first-contentful-paint", "First Contentful Paint (FCP)", "when the first text or image appears"],
  ["speed-index", "Speed Index", "how quickly the page fills in"],
];
const FIELD: Array<[string, string, string, (p: number) => string]> = [
  ["LARGEST_CONTENTFUL_PAINT_MS", "Largest Contentful Paint (LCP)", "real visitors", (p) => secs(p)],
  ["INTERACTION_TO_NEXT_PAINT", "Interaction to Next Paint (INP)", "how fast the page reacts to clicks", (p) => `${Math.round(p)} ms`],
  ["CUMULATIVE_LAYOUT_SHIFT_SCORE", "Cumulative Layout Shift (CLS)", "real visitors", (p) => (p / 100).toFixed(2)],
  ["FIRST_CONTENTFUL_PAINT_MS", "First Contentful Paint (FCP)", "real visitors", (p) => secs(p)],
  ["EXPERIMENTAL_TIME_TO_FIRST_BYTE", "Time to First Byte (TTFB)", "server response time", (p) => secs(p)],
];
const FIELD_RATING: Record<string, Rating> = { FAST: "good", AVERAGE: "needs-improvement", SLOW: "poor" };

/**
 * What the assistant can change through the site. Image formats / sizes: replace or re-upload the image in the Media
 * Library and point the block / widget at it; dimensions / lazy loading / LCP priority: block or widget settings;
 * accessibility and SEO basics: text, alt text, headings, links, SEO description. Server, cache, minify, unused
 * code and third-party scripts need hosting or plugin settings: the assistant explains instead.
 */
export const ASSISTANT_FIXES = new Set([
  "modern-image-formats", "uses-optimized-images", "uses-responsive-images", "efficient-animated-content", "offscreen-images",
  "unsized-images", "lcp-lazy-loaded", "prioritize-lcp-image", "largest-contentful-paint-element", "layout-shifts", "layout-shift-elements",
  "image-alt", "color-contrast", "link-name", "button-name", "heading-order", "document-title", "meta-description",
  "link-text", "image-aspect-ratio", "image-size-responsive", "label", "html-has-lang", "tap-targets", "target-size", "font-size",
]);

const CATEGORY_KEY: Record<string, SpeedFix["category"]> = { performance: "performance", accessibility: "accessibility", "best-practices": "best-practices", seo: "seo" };

export function normalize(lhr: any, o: { device: SpeedDevice; url: string; source: "google" | "local"; loading?: any; origin?: any }): SpeedReport {
  const audits = lhr?.audits ?? {}, cats = lhr?.categories ?? {};
  const score = (c: string) => (typeof cats[c]?.score === "number" ? Math.round(cats[c].score * 100) : null);
  const lab: SpeedMetric[] = LAB.filter(([id]) => audits[id]).map(([id, name, hint]) => {
    const a = audits[id];
    return { id, name, hint, display: String(a.displayValue ?? "").replace(/\u00a0/g, " ") || "-", value: typeof a.numericValue === "number" ? a.numericValue : null, rating: rateScore(a.score) };
  });
  const fieldSrc = o.loading?.metrics && !o.loading.origin_fallback ? { scope: "page" as const, m: o.loading.metrics }
    : o.origin?.metrics ? { scope: "site" as const, m: o.origin.metrics }
    : o.loading?.metrics ? { scope: "site" as const, m: o.loading.metrics } : null;
  const field = fieldSrc ? {
    scope: fieldSrc.scope,
    metrics: FIELD.filter(([k]) => fieldSrc.m[k]).map(([k, name, hint, fmt]) => ({ id: k, name, hint, display: fmt(Number(fieldSrc.m[k].percentile)), value: Number(fieldSrc.m[k].percentile), rating: FIELD_RATING[fieldSrc.m[k].category] ?? null })),
  } : { scope: null, metrics: [] };

  const fixes: SpeedFix[] = [];
  const seen = new Set<string>();
  for (const [cat, c] of Object.entries<any>(cats)) {
    const key = CATEGORY_KEY[cat];
    if (!key) continue;
    for (const ref of c.auditRefs ?? []) {
      const a = audits[ref.id];
      if (!a || seen.has(ref.id) || ref.group === "metrics" || ref.group === "hidden") continue;
      if (a.score === null || a.score === undefined || a.score >= 0.9 || ["notApplicable", "manual", "informative", "error"].includes(a.scoreDisplayMode)) continue;
      if (key !== "performance" && !(ref.weight > 0)) continue;
      seen.add(ref.id);
      const d = a.details ?? {};
      const ms = Number(d.overallSavingsMs ?? 0) || sumSavings(a.metricSavings, ["LCP", "FCP", "TBT", "INP"]);
      const cls = Number(a.metricSavings?.CLS ?? 0);
      if (key === "performance" && ms < 50 && cls < 0.01 && Number(d.overallSavingsBytes ?? 0) < 20_000 && (a.score ?? 1) > 0.5) continue;
      const items = itemsOf(d);
      const fix: SpeedFix = {
        id: ref.id, category: key, title: plain(a.title), detail: detailOf(a, items, ms),
        savingsMs: Math.round(ms), savingsBytes: Math.round(Number(d.overallSavingsBytes ?? 0)), savingsCls: Math.round(cls * 1000) / 1000,
        items, assistant: ASSISTANT_FIXES.has(ref.id), prompt: "",
      };
      fix.prompt = fixPrompt(fix, o.url, o.device);
      fixes.push(fix);
    }
  }
  const order = { performance: 0, accessibility: 1, seo: 2, "best-practices": 3 };
  fixes.sort((a, b) => order[a.category] - order[b.category] || (b.savingsMs + b.savingsCls * 4000) - (a.savingsMs + a.savingsCls * 4000));

  const warnings = (lhr?.runWarnings ?? []).map((w: string) => clip(plain(w), 240));
  return {
    device: o.device, url: o.url, finalUrl: String(lhr?.finalDisplayedUrl ?? lhr?.finalUrl ?? o.url), fetchedAt: String(lhr?.fetchTime ?? new Date().toISOString()),
    source: o.source, lighthouseVersion: String(lhr?.lighthouseVersion ?? ""),
    scores: { performance: score("performance"), accessibility: score("accessibility"), bestPractices: score("best-practices"), seo: score("seo") },
    field, lab, fixes: fixes.slice(0, 12), warnings,
  };
}

function itemsOf(d: any): SpeedFixItem[] {
  const out: SpeedFixItem[] = [];
  const walk = (list: any[]) => {
    for (const it of list ?? []) {
      if (out.length >= 6) return;
      if ((it?.type === "table" || it?.type === "opportunity") && Array.isArray(it.items)) { walk(it.items); continue; } // "list" details: tables inside
      const node = it.node ?? (it.element?.type === "node" ? it.element : undefined);
      const url = typeof it.url === "string" && /^https?:/.test(it.url) ? it.url : typeof it.source?.url === "string" ? it.source.url : undefined;
      if (node || url) out.push({ ...(url ? { url } : {}), ...(node?.nodeLabel ? { label: clip(String(node.nodeLabel), 90) } : {}), ...(node?.snippet ? { snippet: clip(String(node.snippet), 160) } : {}), ...(node?.selector ? { selector: clip(String(node.selector), 160) } : {}) });
      if (it.subItems?.items) walk(it.subItems.items);
    }
  };
  walk(d.items);
  return out;
}

function detailOf(a: any, items: SpeedFixItem[], ms: number): string {
  const n = Array.isArray(a.details?.items) ? a.details.items.length : 0;
  const what = a.displayValue ? String(a.displayValue).replace(/\u00a0/g, " ") : "";
  const first = plain(a.description).split(/(?<=\.)\s/)[0];
  const parts = [first];
  if (what) parts.push(what + ".");
  else if (n) parts.push(`${n} item${n === 1 ? "" : "s"} on this page.`);
  if (!what && ms >= 100) parts.push(`About ${secs(ms)} faster.`);
  return clip(parts.filter(Boolean).join(" "), 260);
}

/** The chat message that asks the assistant to fix one finding (it decides what it can change and asks first). */
export function fixPrompt(f: Pick<SpeedFix, "id" | "title" | "detail" | "items" | "assistant" | "category">, url: string, device: SpeedDevice): string {
  const where = f.items.slice(0, 6).map((i) => "- " + [i.label, i.url, i.selector && `(${i.selector})`].filter(Boolean).join(" ")).join("\n");
  return [
    `PageSpeed (${device}) found on ${url}: "${f.title}" (Lighthouse audit ${f.id}, ${f.category}).`,
    f.detail,
    where ? `Affected:\n${where}` : "",
    f.assistant
      ? "Fix it as draft changes on this site (block / Elementor / media settings, never !important), check the page, and tell me what changed. If something here cannot be changed from WordPress content, say what needs a plugin or hosting setting instead."
      : "This usually needs a plugin, theme or hosting setting rather than a content change. Explain in short steps what to change and where for this site (look at its theme, builder and plugins first). Do not change anything without asking.",
  ].filter(Boolean).join("\n");
}

/** One message for "Fix all with assistant": the fixes it can work on, most valuable first. */
export function fixAllPrompt(r: SpeedReport): string {
  const list = r.fixes.filter((f) => f.assistant).slice(0, 6);
  if (!list.length) return "";
  return [
    `PageSpeed (${r.device}) for ${r.url}: performance ${r.scores.performance ?? "?"}, accessibility ${r.scores.accessibility ?? "?"}, SEO ${r.scores.seo ?? "?"}.`,
    "Fix these as draft changes, most valuable first, and check the page after each. Propose a short plan first.",
    ...list.map((f, i) => `${i + 1}. ${f.title} (${f.id}) - ${f.detail}${f.items.length ? " Affected: " + f.items.slice(0, 3).map((x) => x.label || x.url || x.selector).join("; ") : ""}`),
  ].join("\n");
}

/** A short text version for the assistant's tool result. */
export function summarize(r: SpeedReport) {
  return {
    device: r.device, source: r.source, scores: r.scores,
    field: r.field.scope ? { scope: r.field.scope, metrics: r.field.metrics.map((m) => `${m.name}: ${m.display} (${m.rating ?? "?"})`) } : "no real-visitor data",
    lab: r.lab.map((m) => `${m.name}: ${m.display} (${m.rating ?? "?"})`),
    fixes: r.fixes.map((f) => ({ id: f.id, category: f.category, title: f.title, detail: f.detail, assistantCanFix: f.assistant, affected: f.items.slice(0, 4).map((i) => i.label || i.url || i.selector) })),
    warnings: r.warnings,
  };
}

// ------------------------------------------------------------------------------------------------ runs + history

export interface SpeedDeps { apiKey: () => string; google?: typeof runGoogle; local?: typeof runLocal; fetchImpl?: typeof fetch }

export class SpeedRuns {
  private store: JsonStore<SpeedRun>;
  private live = new Map<string, Promise<SpeedRun>>();
  constructor(private deps: SpeedDeps, dir = path.join(config.dataDir, "pagespeed")) { this.store = new JsonStore<SpeedRun>(dir); }

  /** Start a run (both devices in parallel for Google, one after the other locally). Returns at once; poll get(). */
  start(siteId: string, url: string, devices: SpeedDevice[]): SpeedRun {
    const local = needsLocalRun(url);
    const run: SpeedRun = { id: newId("speed"), siteId, url, devices, status: "running", source: local ? "local" : "google", startedAt: new Date().toISOString(), reports: [] };
    this.store.put(run);
    const google = this.deps.google ?? runGoogle, localRun = this.deps.local ?? runLocal;
    const one = (d: SpeedDevice) => (local ? localRun(url, d) : google(url, d, this.deps.apiKey(), this.deps.fetchImpl ?? fetch));
    const p = (async () => {
      try {
        run.reports = local ? await sequential(devices, one) : await Promise.all(devices.map(one));
        run.status = "done";
      } catch (e) {
        run.status = "failed"; run.error = (e as Error).message;
      }
      run.finishedAt = new Date().toISOString();
      this.store.put(run);
      this.live.delete(run.id);
      this.prune(siteId);
      return run;
    })();
    this.live.set(run.id, p);
    return run;
  }

  /** Wait for a run (the assistant's tool). */
  wait(id: string): Promise<SpeedRun | undefined> { return this.live.get(id) ?? Promise.resolve(this.store.get(id)); }
  get(id: string): SpeedRun | undefined { return this.store.get(id); }

  /** Set (or clear, with null) the status of one fix of a finished report. */
  markFix(id: string, key: string, mark: { status: FixStatus; jobId?: string; requestId?: number } | null): SpeedRun | undefined {
    const run = this.store.get(id);
    if (!run || run.status !== "done") return undefined;
    const [device, fixId] = key.split(":");
    if (!run.reports.some((r) => r.device === device && r.fixes.some((f) => f.id === fixId))) return undefined;
    const state = { ...(run.fixState ?? {}) };
    if (mark) state[key] = { status: mark.status, ...(mark.jobId ? { jobId: mark.jobId } : {}), ...(mark.requestId ? { requestId: mark.requestId } : {}), at: new Date().toISOString() };
    else delete state[key];
    run.fixState = state;
    this.store.put(run);
    return run;
  }

  /** Newest first; optionally only one page. A run left "running" by a restart is reported as failed. */
  history(siteId: string, url?: string, limit = 20): SpeedRun[] {
    const key = url ? pageKey(url) : "";
    return this.store.list().filter((r) => r.siteId === siteId && (!key || pageKey(r.url) === key))
      .map((r) => (r.status === "running" && !this.live.has(r.id) ? { ...r, status: "failed" as const, error: "Interrupted (the backend restarted). Run it again." } : r))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  /** Keep the 30 newest runs per site. */
  private prune(siteId: string) {
    const all = this.store.list().filter((r) => r.siteId === siteId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const r of all.slice(30)) this.store.delete(r.id);
  }
}

let shared: SpeedRuns | null = null;
/** The backend's run manager (Google key from Integrations / .env). */
export function defaultSpeedRuns(): SpeedRuns { return (shared ??= new SpeedRuns({ apiKey: () => secrets.pagespeedKey() })); }

/** Only pages of the connected site may be tested (the backend is not an open proxy for Google or Lighthouse). */
export function sameHost(siteUrl: string, url: string): boolean {
  try {
    const a = new URL(siteUrl), b = new URL(url);
    return /^https?:$/.test(b.protocol) && a.hostname.replace(/^www\./, "").toLowerCase() === b.hostname.replace(/^www\./, "").toLowerCase();
  } catch { return false; }
}

/** What the app shows in a history list: no fixes, just the scores per device. */
export function runSummary(r: SpeedRun) {
  return { id: r.id, url: r.url, status: r.status, error: r.error, source: r.source, devices: r.devices, startedAt: r.startedAt, finishedAt: r.finishedAt,
    scores: r.reports.map((x) => ({ device: x.device, ...x.scores })) };
}

/** The full run for the app, with the "Fix all" message per report. */
export function runView(r: SpeedRun) {
  return { ...r, reports: r.reports.map((x) => ({ ...x, fixAllPrompt: fixAllPrompt(x) })) };
}

async function sequential<T, R>(xs: T[], f: (x: T) => Promise<R>): Promise<R[]> { const out: R[] = []; for (const x of xs) out.push(await f(x)); return out; }

/** One page, whatever the trailing slash, hash or tracking parameters. */
export function pageKey(url: string): string {
  try { const u = new URL(url); u.hash = ""; for (const k of [...u.searchParams.keys()]) if (/^(utm_|lc_|lcv$|fbclid$|gclid$)/.test(k)) u.searchParams.delete(k); return (u.host + u.pathname.replace(/\/+$/, "") + (u.search || "")).toLowerCase(); }
  catch { return url.toLowerCase(); }
}

// ------------------------------------------------------------------------------------------------ helpers

function rateScore(s: unknown): Rating | null { return typeof s !== "number" ? null : s >= 0.9 ? "good" : s >= 0.5 ? "needs-improvement" : "poor"; }
function sumSavings(m: any, keys: string[]): number { return m ? keys.reduce((t, k) => t + (k === "CLS" ? 0 : Number(m[k] ?? 0)), 0) : 0; }
function secs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`; }
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
/** Lighthouse text is markdown: drop links "[Learn more](…)" and code ticks. */
export function plain(s: unknown): string {
  return String(s ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\bLearn (more|how)[^.]*\.?/gi, "").replace(/\s+/g, " ").trim();
}
