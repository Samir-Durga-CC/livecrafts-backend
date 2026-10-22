/** PageSpeed report types and helpers shared by the Speed tab and the tests (no React here). */
export type SpeedDevice = "mobile" | "desktop";
export type Rating = "good" | "needs-improvement" | "poor";
export interface SpeedMetric { id: string; name: string; hint: string; display: string; value: number | null; rating: Rating | null }
export interface SpeedFixItem { url?: string; label?: string; snippet?: string; selector?: string }
export interface SpeedFix {
  id: string; category: "performance" | "accessibility" | "best-practices" | "seo"; title: string; detail: string;
  savingsMs: number; savingsBytes: number; savingsCls: number; items: SpeedFixItem[]; assistant: boolean; prompt: string;
}
export interface SpeedScores { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null }
export interface SpeedReport {
  device: SpeedDevice; url: string; finalUrl: string; fetchedAt: string; source: "google" | "local"; lighthouseVersion: string;
  scores: SpeedScores; field: { scope: "page" | "site" | null; metrics: SpeedMetric[] }; lab: SpeedMetric[]; fixes: SpeedFix[]; warnings: string[];
  fixAllPrompt?: string;
}
export interface SpeedRunSummary {
  id: string; url: string; status: "running" | "done" | "failed"; error?: string; source: "google" | "local"; devices: SpeedDevice[];
  startedAt: string; finishedAt?: string; scores: Array<SpeedScores & { device: SpeedDevice }>;
}
export type FixStatus = "progress" | "fixed" | "done" | "skipped";
export interface FixMark { status: FixStatus; jobId?: string; requestId?: number; at: string }
export interface SpeedRun extends Omit<SpeedRunSummary, "scores"> { siteId: string; reports: SpeedReport[]; fixState?: Record<string, FixMark> }
/** The key a fix's status is saved under. */
export const fixKey = (device: SpeedDevice, fixId: string) => `${device}:${fixId}`;
export const FIX_STATUS_LABEL: Record<FixStatus | "open", string> = { open: "Open", progress: "In progress", fixed: "Fixed", done: "Done", skipped: "Skipped" };

export const SCORE_LABELS: Array<[keyof SpeedScores, string]> = [["performance", "Performance"], ["accessibility", "Accessibility"], ["bestPractices", "Best practices"], ["seo", "SEO"]];

/** Google's colour bands: 90-100 good, 50-89 needs work, 0-49 poor. */
export function scoreTone(n: number | null): "good" | "ok" | "bad" | "none" {
  return n === null ? "none" : n >= 90 ? "good" : n >= 50 ? "ok" : "bad";
}
export const RATING_LABEL: Record<Rating, string> = { good: "Good", "needs-improvement": "Needs work", poor: "Poor" };

/** The badge on a fix: time saved, layout shift saved, size saved, or nothing. */
export function savingsLabel(f: Pick<SpeedFix, "savingsMs" | "savingsCls" | "savingsBytes">): string {
  if (f.savingsMs >= 100) return `−${f.savingsMs >= 1000 ? (f.savingsMs / 1000).toFixed(1) + " s" : Math.round(f.savingsMs / 10) * 10 + " ms"}`;
  if (f.savingsCls >= 0.01) return "less jumping";
  if (f.savingsBytes >= 20_000) return `−${Math.round(f.savingsBytes / 1024)} KB`;
  return "";
}

/** "Today 12:41" / "Yesterday 17:05" / "12 Oct 09:30". */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  return diff === 0 ? `Today ${t}` : diff === 1 ? `Yesterday ${t}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${t}`;
}

/** Score change against the previous report of the same page and device: "+12", "−4", or "". */
export function delta(now: number | null, before: number | null | undefined): string {
  if (now === null || before === null || before === undefined || now === before) return "";
  return now > before ? `+${now - before}` : `−${before - now}`;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Good / poor limits per metric (Google's Core Web Vitals bands), in the unit the report stores. */
const BANDS: Record<string, { good: number; poor: number; max: number }> = {
  "largest-contentful-paint": { good: 2500, poor: 4000, max: 8000 }, LARGEST_CONTENTFUL_PAINT_MS: { good: 2500, poor: 4000, max: 8000 },
  "first-contentful-paint": { good: 1800, poor: 3000, max: 6000 }, FIRST_CONTENTFUL_PAINT_MS: { good: 1800, poor: 3000, max: 6000 },
  "total-blocking-time": { good: 200, poor: 600, max: 1200 }, INTERACTION_TO_NEXT_PAINT: { good: 200, poor: 500, max: 1000 },
  "cumulative-layout-shift": { good: 0.1, poor: 0.25, max: 0.5 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { good: 10, poor: 25, max: 50 },
  "speed-index": { good: 3400, poor: 5800, max: 10000 }, EXPERIMENTAL_TIME_TO_FIRST_BYTE: { good: 800, poor: 1800, max: 3600 },
};

/** A self-contained, printable HTML report of a run (the person prints it or saves it as PDF from the browser). */
export function reportHtml(run: Pick<SpeedRun, "url" | "startedAt" | "source" | "reports">, siteName = ""): string {
  const C = { good: "#0a7d48", ok: "#b45309", bad: "#c62828", none: "#6b7080" };
  const BG = { good: "#e8f6ef", ok: "#fff4e3", bad: "#fdecec", none: "#f1f2f5" };
  const word = { good: "Good", ok: "Needs work", bad: "Poor", none: "Not measured" };
  const ring = (v: number | null, size = 92) => {
    const t = scoreTone(v), r = 40, c = 2 * Math.PI * r;
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${r}" fill="${BG[t]}" stroke="#e7e8ee" stroke-width="8"/>` +
      `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${C[t]}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${((v ?? 0) / 100) * c} ${c}" transform="rotate(-90 50 50)"/>` +
      `<text x="50" y="58" text-anchor="middle" font-size="26" font-weight="700" fill="${C[t]}" font-family="inherit">${v ?? "–"}</text></svg>`;
  };
  const toneOf = (m: SpeedMetric) => (m.rating === "good" ? "good" : m.rating === "poor" ? "bad" : m.rating ? "ok" : "none") as keyof typeof C;
  const bar = (m: SpeedMetric) => {
    const b = BANDS[m.id];
    if (!b || m.value === null) return "";
    const pct = (x: number) => Math.max(0, Math.min(100, (x / b.max) * 100));
    return `<div class="band"><span class="g" style="width:${pct(b.good)}%"></span><span class="o" style="width:${pct(b.poor) - pct(b.good)}%"></span><span class="p" style="width:${100 - pct(b.poor)}%"></span>` +
      `<i style="left:${pct(m.value)}%;border-color:${C[toneOf(m)]}"></i></div>`;
  };
  const metricCard = (m: SpeedMetric) => `<div class="metric"><div class="mtop"><span class="mname">${esc(m.name)}</span><span class="pill" style="color:${C[toneOf(m)]};background:${BG[toneOf(m)]}">${m.rating ? RATING_LABEL[m.rating] : "–"}</span></div>` +
    `<div class="mval" style="color:${C[toneOf(m)]}">${esc(m.display)}</div>${bar(m)}<div class="mhint">${esc(m.hint)}</div></div>`;
  const maxSave = (r: SpeedReport) => Math.max(1, ...r.fixes.map((f) => f.savingsMs));
  const fixRow = (f: SpeedFix, r: SpeedReport, i: number) => {
    const save = savingsLabel(f);
    const w = f.savingsMs ? Math.max(4, Math.round((f.savingsMs / maxSave(r)) * 100)) : 0;
    return `<div class="fix"><div class="fnum">${i + 1}</div><div class="fbody"><div class="ftop"><b>${esc(f.title)}</b>${save ? `<span class="save">${esc(save)}</span>` : ""}</div>` +
      `<p>${esc(f.detail)}</p>${w ? `<div class="sbar"><span style="width:${w}%"></span></div>` : ""}` +
      `<div class="fmeta"><span class="tag">${esc(CATEGORY_LABEL[f.category])}</span><span class="tag ${f.assistant ? "who-a" : "who-h"}">${f.assistant ? "Livecrafts assistant can fix" : "Hosting / plugin setting"}</span></div>` +
      (f.items.length ? `<ul>${f.items.slice(0, 5).map((it) => `<li>${esc(it.label || it.url || it.selector)}</li>`).join("")}${f.items.length > 5 ? `<li class="more">and ${f.items.length - 5} more</li>` : ""}</ul>` : "") + `</div></div>`;
  };
  const summary = (r: SpeedReport) => {
    const p = r.scores.performance, metrics = r.field.metrics.length ? r.field.metrics : r.lab;
    const worst = metrics.filter((m) => m.rating === "poor").map((m) => m.name.replace(/\s*\(.*\)/, ""));
    const top = r.fixes.filter((f) => f.savingsMs >= 100).slice(0, 2).map((f) => f.title.toLowerCase());
    const head = p === null ? "Performance could not be measured." : p >= 90 ? `Fast: performance ${p}/100.` : p >= 50 ? `Performance ${p}/100 needs work.` : `Slow: performance ${p}/100.`;
    return `${head}${worst.length ? ` Poor: ${esc(worst.join(", "))}.` : ""}${top.length ? ` Biggest gains: ${esc(top.join(" and "))}.` : ""}`;
  };
  const section = (r: SpeedReport) => {
    const field = r.field.metrics.length > 0;
    const can = r.fixes.filter((f) => f.assistant), host = r.fixes.filter((f) => !f.assistant);
    return `<section class="dev">
      <div class="devhead"><h2>${r.device === "mobile" ? "Mobile" : "Desktop"}</h2><span class="sub">${esc(r.finalUrl || run.url)}</span></div>
      <div class="scores">${SCORE_LABELS.map(([k, label]) => `<div class="score">${ring(r.scores[k])}<b>${label}</b><span style="color:${C[scoreTone(r.scores[k])]}">${word[scoreTone(r.scores[k])]}</span></div>`).join("")}</div>
      <p class="verdict">${summary(r)}</p>
      <h3>Core Web Vitals <span class="sub">${field ? `real visitors, last 28 days${r.field.scope === "site" ? " (whole site)" : ""}` : r.source === "local" ? "lab test on this computer" : "lab test (not enough real visitors yet)"}</span></h3>
      <div class="metrics">${(field ? r.field.metrics : r.lab).map(metricCard).join("")}</div>
      ${field ? `<h3>Lab test <span class="sub">one simulated visit</span></h3><div class="metrics">${r.lab.map(metricCard).join("")}</div>` : ""}
      <div class="legend"><span><i class="g"></i>Good</span><span><i class="o"></i>Needs work</span><span><i class="p"></i>Poor</span><span class="sub">The marker shows this page.</span></div>
      <h3>What to fix <span class="sub">${r.fixes.length ? `${r.fixes.length} item${r.fixes.length === 1 ? "" : "s"}, biggest impact first` : ""}</span></h3>
      ${r.fixes.length === 0 ? `<p class="ok">Nothing important to fix. Nice work.</p>` : ""}
      ${can.length ? `<h4>On the page (${can.length})</h4><div class="fixes">${can.map((f, i) => fixRow(f, r, i)).join("")}</div>` : ""}
      ${host.length ? `<h4>Hosting, caching and plugins (${host.length}) <span class="sub">optional, set up once for the whole site</span></h4><div class="fixes">${host.map((f, i) => fixRow(f, r, can.length + i)).join("")}</div>` : ""}
      ${r.warnings.length ? `<div class="note"><b>Notes</b>${r.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : ""}
    </section>`;
  };
  const when = new Date(run.startedAt);
  const src = run.source === "google" ? "Google PageSpeed Insights" : "Lighthouse on this computer";
  const lh = run.reports[0]?.lighthouseVersion ? ` · Lighthouse ${esc(run.reports[0].lighthouseVersion)}` : "";
  const overview = run.reports.length > 1 ? `<div class="overview">${run.reports.map((r) => `<div><span class="sub">${r.device === "mobile" ? "Mobile" : "Desktop"} performance</span><b style="color:${C[scoreTone(r.scores.performance)]}">${r.scores.performance ?? "–"}</b></div>`).join("")}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PageSpeed report – ${esc(siteName || run.url)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f8;color:#16181d;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:880px;margin:0 auto;padding:28px 20px 48px}.tool{display:flex;justify-content:flex-end;gap:8px;margin-bottom:14px}
.tool button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 16px;background:#16181d;color:#fff;cursor:pointer}
header.cover{background:#16181d;color:#fff;border-radius:18px;padding:26px 28px;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
.cover h1{margin:0 0 4px;font-size:24px;letter-spacing:-.01em}.cover .url{color:#c9ccd6;word-break:break-all}.cover .meta{color:#9aa0ae;font-size:12.5px;margin-top:10px}
.brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9aa0ae;margin-bottom:10px}
.overview{display:flex;gap:12px;align-items:center}.overview>div{background:#232631;border-radius:14px;padding:10px 16px;display:flex;flex-direction:column}.overview b{font-size:30px;line-height:1.1}.overview .sub{color:#9aa0ae}
section.dev{background:#fff;border:1px solid #e4e6ec;border-radius:18px;padding:24px 26px;margin-top:18px}
.devhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;border-bottom:1px solid #eceef3;padding-bottom:12px;margin-bottom:18px}
h2{margin:0;font-size:20px}h3{font-size:15px;margin:26px 0 10px}h4{font-size:13.5px;margin:16px 0 8px;color:#3d404b}.sub{font-weight:400;color:#6b7080;font-size:12.5px}
.scores{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.score{display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;padding:12px 6px;border:1px solid #eceef3;border-radius:14px}.score b{font-size:13px}.score span{font-size:12px;font-weight:600}
.verdict{margin:16px 0 0;padding:12px 14px;background:#f6f7fa;border-radius:12px;font-size:14px}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}.metric{border:1px solid #eceef3;border-radius:14px;padding:12px 14px}
.mtop{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.mname{font-size:12.5px;color:#3d404b;font-weight:600}.mval{font-size:24px;font-weight:700;margin:4px 0 6px}.mhint{font-size:12px;color:#6b7080;margin-top:6px}
.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;white-space:nowrap}
.band{position:relative;display:flex;height:6px;border-radius:99px;overflow:visible}.band span{height:6px}.band .g{background:#7fd1a8;border-radius:99px 0 0 99px}.band .o{background:#f6c76f}.band .p{background:#f19a9a;border-radius:0 99px 99px 0}
.band i{position:absolute;top:-4px;width:6px;height:14px;margin-left:-3px;background:#fff;border:2.5px solid;border-radius:3px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#3d404b;margin-top:10px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}.legend .g{background:#7fd1a8}.legend .o{background:#f6c76f}.legend .p{background:#f19a9a}
.fixes{display:flex;flex-direction:column;gap:8px}.fix{display:flex;gap:12px;border:1px solid #eceef3;border-radius:14px;padding:12px 14px}
.fnum{flex:none;width:24px;height:24px;border-radius:50%;background:#eef0ff;color:#3f3fb0;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center}
.fbody{flex:1;min-width:0}.ftop{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.ftop b{font-size:13.5px}.fix p{margin:4px 0 6px;color:#4a4e5a;font-size:12.5px}
.save{flex:none;font-size:12px;font-weight:700;color:#b45309;background:#fff4e3;border-radius:6px;padding:2px 7px}.sbar{height:4px;background:#f1f2f5;border-radius:99px;margin:4px 0 8px}.sbar span{display:block;height:4px;background:#f0a33a;border-radius:99px}
.fmeta{display:flex;gap:6px;flex-wrap:wrap}.tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;background:#f1f2f5;color:#4a4e5a}.who-a{background:#eef0ff;color:#3f3fb0}.who-h{background:#f6f7fa;color:#6b7080}
.fix ul{margin:8px 0 0;padding-left:18px;color:#6b7080;font-size:12px;word-break:break-all}.fix li.more{list-style:none;margin-left:-18px}
.note{margin-top:16px;background:#f6f7fa;border-radius:12px;padding:10px 14px;font-size:12.5px;color:#4a4e5a}.note p{margin:4px 0 0}.ok{color:#0a7d48;font-weight:600}
footer{margin-top:18px;color:#6b7080;font-size:12px;text-align:center}
@media (max-width:640px){.scores{grid-template-columns:repeat(2,1fr)}section.dev{padding:18px}}
@media print{body{background:#fff}.page{padding:0;max-width:none}.tool{display:none}section.dev{border:0;padding:0;margin-top:22px;break-before:page}section.dev:first-of-type{break-before:auto}.fix,.metric,.score{break-inside:avoid}h3,h4{break-after:avoid}@page{size:A4;margin:14mm}}
</style></head><body><div class="page">
<div class="tool"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<header class="cover"><div><div class="brand">PageSpeed report</div><h1>${esc(siteName || hostOf(run.url))}</h1><div class="url">${esc(run.url)}</div>
<div class="meta">${when.toLocaleString([], { dateStyle: "long", timeStyle: "short" })} · ${src}${lh} · ${run.reports.map((r) => (r.device === "mobile" ? "Mobile" : "Desktop")).join(" and ")}</div></div>${overview}</header>
${run.reports.map(section).join("")}
<footer>Scores: 90–100 good, 50–89 needs work, 0–49 poor. Lab results vary a little between runs; real-visitor data covers the last 28 days. Made with Livecrafts.</footer>
</div></body></html>`;
}

const CATEGORY_LABEL: Record<SpeedFix["category"], string> = { performance: "Speed", accessibility: "Accessibility", "best-practices": "Best practice", seo: "SEO" };

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
