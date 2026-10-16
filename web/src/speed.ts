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
export interface SpeedRun extends Omit<SpeedRunSummary, "scores"> { siteId: string; reports: SpeedReport[] }

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

/** A self-contained, printable HTML page of a run (the person saves it as PDF from the print dialog). */
export function reportHtml(run: Pick<SpeedRun, "url" | "startedAt" | "source" | "reports">, siteName = ""): string {
  const tone = { good: "#0a6b3d", ok: "#9a4a00", bad: "#a51c1a", none: "#5c6070" };
  const section = (r: SpeedReport) => `
    <section>
      <h2>${r.device === "mobile" ? "Mobile" : "Desktop"}</h2>
      <div class="scores">${SCORE_LABELS.map(([k, label]) => `<div class="score"><b style="color:${tone[scoreTone(r.scores[k])]}">${r.scores[k] ?? "–"}</b><span>${label}</span></div>`).join("")}</div>
      ${r.field.metrics.length ? `<h3>Real visitors (${r.field.scope === "page" ? "this page" : "whole site"}, last 28 days)</h3>
      <table>${r.field.metrics.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.display)}</td><td>${m.rating ? RATING_LABEL[m.rating] : ""}</td></tr>`).join("")}</table>` : ""}
      <h3>Lab test</h3>
      <table>${r.lab.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.display)}</td><td>${m.rating ? RATING_LABEL[m.rating] : ""}</td></tr>`).join("")}</table>
      <h3>Fixes</h3>
      ${r.fixes.length ? `<ol>${r.fixes.map((f) => `<li><b>${esc(f.title)}</b>${savingsLabel(f) ? ` <em>${esc(savingsLabel(f))}</em>` : ""}<br><span>${esc(f.detail)}</span>${f.items.length ? `<ul>${f.items.slice(0, 4).map((i) => `<li>${esc(i.label || i.url || i.selector)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ol>` : "<p>Nothing important to fix.</p>"}
      ${r.warnings.length ? `<p class="note">${r.warnings.map(esc).join("<br>")}</p>` : ""}
    </section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PageSpeed report – ${esc(run.url)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#15161a;max-width:820px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #e3e5ea;padding-bottom:6px}h3{font-size:14px;margin:18px 0 6px}
.meta{color:#5c6070;margin:0}.scores{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.score{border:1px solid #e3e5ea;border-radius:12px;padding:12px;text-align:center}
.score b{display:block;font-size:30px}.score span{color:#3d404b;font-size:12.5px}table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-top:1px solid #eceef2}
td:nth-child(2),td:nth-child(3){text-align:right;white-space:nowrap}ol{padding-left:20px}ol>li{margin:0 0 10px}em{font-style:normal;color:#9a4a00;font-size:12.5px}
ul{color:#5c6070;font-size:12.5px;margin:4px 0}.note{color:#5c6070;font-size:12.5px}@media print{body{margin:0}section{break-inside:avoid-page}}
</style></head><body>
<h1>PageSpeed report${siteName ? " – " + esc(siteName) : ""}</h1>
<p class="meta">${esc(run.url)}<br>${new Date(run.startedAt).toLocaleString()} · ${run.source === "google" ? "Google PageSpeed Insights" : "Lighthouse on this computer"}${run.reports[0]?.lighthouseVersion ? " " + esc(run.reports[0].lighthouseVersion) : ""}</p>
${run.reports.map(section).join("")}
</body></html>`;
}
