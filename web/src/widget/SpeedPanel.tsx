import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import { RATING_LABEL, SCORE_LABELS, delta, reportHtml, savingsLabel, scoreTone, whenLabel, type SpeedDevice, type SpeedReport, type SpeedRun, type SpeedRunSummary } from "../speed";

type DeviceChoice = SpeedDevice | "both";
const STEPS_GOOGLE = ["Asking Google to load the page", "Running Lighthouse on Google's servers", "Collecting real-visitor data", "Picking the fixes for this page"];
const STEPS_LOCAL = ["Opening the page in this computer's browser", "Running Lighthouse", "Measuring the second device", "Picking the fixes for this page"];

/**
 * The widget's Speed tab: run a Google PageSpeed report for the page the person is on (or Lighthouse on this computer
 * for a localhost site), see scores, Core Web Vitals and the top fixes, and send a fix to the assistant.
 */
export function SpeedPanel({ siteId, pageUrl, siteName, disabled, onAsk }: {
  siteId: string; pageUrl: string; siteName?: string; disabled: boolean; onAsk: (prompt: string) => void;
}) {
  const [url, setUrl] = useState(pageUrl);
  const [device, setDevice] = useState<DeviceChoice>("mobile");
  const [history, setHistory] = useState<SpeedRunSummary[] | null>(null);
  const [info, setInfo] = useState<{ keySource: "env" | "saved" | "none"; local: boolean } | null>(null);
  const [run, setRun] = useState<SpeedRun | null>(null);        // the report on screen (or the one running)
  const [shown, setShown] = useState<SpeedDevice>("mobile");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const poll = useRef<number | null>(null);

  const loadHistory = (u = url) => api.speedHistory(siteId, u).then((r) => { setHistory(r.runs); setInfo({ keySource: r.google.keySource, local: r.local }); return r.runs; }).catch((e) => { setHistory([]); setErr(e.message); return []; });

  useEffect(() => { setUrl(pageUrl); }, [pageUrl]);
  useEffect(() => {
    let alive = true;
    // Coming back to the tab (or to a page tested before): show the latest report straight away, no new scan.
    void loadHistory(pageUrl).then((runs) => {
      const r = runs[0];
      if (!alive || !r) return;
      if (r.status === "running") void follow(r.id);
      else if (r.status === "done") void open(r.id);
    });
    return () => { alive = false; stopPolling(); };
  }, [siteId, pageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopPolling() { if (poll.current) window.clearInterval(poll.current); poll.current = null; }

  /** Poll a running report every 2 s until it is done or failed. */
  async function follow(id: string) {
    stopPolling();
    setBusy(true); setErr(""); setElapsed(0);
    const t0 = Date.now();
    const tick = async () => {
      setElapsed(Math.round((Date.now() - t0) / 1000));
      try {
        const r = await api.speedRun(siteId, id);
        setRun(r);
        if (r.status !== "running") {
          stopPolling(); setBusy(false);
          if (r.status === "failed") setErr(r.error || "The report failed.");
          else setShown(r.reports[0]?.device ?? "mobile");
          void loadHistory(r.url);
        }
      } catch (e) { stopPolling(); setBusy(false); setErr((e as Error).message); }
    };
    poll.current = window.setInterval(() => void tick(), 2000);
    void tick();
  }

  async function start(d = device, u = url) {
    setErr("");
    try { const s = await api.startSpeed(siteId, u.trim(), d); setRun(null); await follow(s.id); }
    catch (e) {
      const m = (e as Error).message;
      setErr(m);
    }
  }

  async function open(id: string) {
    setErr("");
    try { const r = await api.speedRun(siteId, id); if (r.status === "running") return follow(id); setRun(r); setShown(r.reports[0]?.device ?? "mobile"); if (r.error) setErr(r.error); }
    catch (e) { setErr((e as Error).message); }
  }

  function printReport() {
    if (!run) return;
    const blob = new Blob([reportHtml(run, siteName)], { type: "text/html" });
    const href = URL.createObjectURL(blob);
    const w = window.open(href, "_blank", "noopener");
    if (!w) { const a = document.createElement("a"); a.href = href; a.download = "pagespeed-report.html"; a.click(); }
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }

  // ------------------------------------------------------------------ running
  if (busy) {
    const local = run?.source === "local" || info?.local;
    const steps = local ? STEPS_LOCAL : STEPS_GOOGLE;
    const at = elapsed < 4 ? 0 : elapsed < 14 ? 1 : elapsed < 24 ? 2 : 3;
    return (
      <div className="sp">
        <SpeedHead url={run?.url || url} />
        <div className="sp-running" role="status" aria-live="polite">
          <div className="sp-running-top"><b>Testing the page…</b><span className="sp-mono">{elapsed} s</span></div>
          <div className="sp-bar"><span style={{ width: `${Math.min(95, 6 + elapsed * 2.6)}%` }} /></div>
          {steps.map((s, i) => <div key={s} className={`sp-step ${i < at ? "done" : i === at ? "now" : ""}`}><span aria-hidden="true" />{s}</div>)}
          <p className="muted small">{local ? "Your site is on this computer, so Lighthouse runs here (Google cannot reach it)." : "Google runs the test on its servers. Usually 15–40 seconds."} You can keep using the other tabs.</p>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ report
  const rep = run?.status === "done" ? run.reports.find((r) => r.device === shown) ?? run.reports[0] : null;
  if (run && rep) {
    const prev = history?.find((h) => h.id !== run.id && h.status === "done" && h.startedAt < run.startedAt && h.scores.some((s) => s.device === rep.device))?.scores.find((s) => s.device === rep.device);
    const fixable = rep.fixes.filter((f) => f.assistant).length;
    return (
      <div className="sp">
        <div className="sp-head">
          <div className="sp-head-text">
            <button type="button" className="sp-back" onClick={() => setRun(null)}><Icon.ChevronRight size={13} /> All reports</button>
            <b title={rep.finalUrl}>{shortUrl(run.url)}</b>
            <span className="muted small">{whenLabel(run.startedAt)} · {run.source === "google" ? "Google PageSpeed" : "Lighthouse on this computer"}</span>
          </div>
          <button type="button" className="btn" disabled={disabled} onClick={() => void start(run.devices.length > 1 ? "both" : run.devices[0], run.url)}><Icon.Retry size={14} /> Re-run</button>
        </div>
        {run.reports.length > 1 && (
          <div className="sp-seg two" role="radiogroup" aria-label="Device">
            {run.reports.map((r) => <button key={r.device} type="button" role="radio" aria-checked={r.device === rep.device} className={r.device === rep.device ? "on" : ""} onClick={() => setShown(r.device)}>{r.device === "mobile" ? <Icon.Phone size={14} /> : <Icon.Monitor size={14} />} {cap(r.device)}</button>)}
          </div>
        )}
        <div className="sp-scores">
          {SCORE_LABELS.map(([k, label]) => <ScoreRing key={k} label={label} value={rep.scores[k]} change={delta(rep.scores[k], prev?.[k])} />)}
        </div>
        <Vitals rep={rep} />
        <div className="sp-fixes">
          <div className="sp-sec-title"><b>Top fixes for this page</b>{rep.fixes.some((f) => savingsLabel(f)) && <span className="muted small">est. saving</span>}</div>
          {rep.fixes.length === 0 && <p className="muted small">Nothing important to fix. Nice work.</p>}
          {rep.fixes.map((f) => (
            <div key={f.id} className="sp-fix">
              <div className="sp-fix-top">
                <div><b>{f.title}</b><span>{f.detail}</span></div>
                {savingsLabel(f) && <span className="sp-save">{savingsLabel(f)}</span>}
              </div>
              {f.items.length > 0 && (
                <details className="sp-items"><summary>{f.items.length} affected</summary>
                  <ul>{f.items.map((i, n) => <li key={n} title={i.selector || i.url}>{i.label || i.url || i.selector}</li>)}</ul>
                </details>
              )}
              <div className="sp-fix-actions">
                <span className={`sp-cat ${f.category}`}>{CAT[f.category]}</span>
                <button type="button" className={`btn ${f.assistant ? "dark" : ""}`} disabled={disabled} onClick={() => onAsk(f.prompt)}>
                  {f.assistant ? <><Icon.Sparkle size={13} /> Fix with assistant</> : <><Icon.Chat size={13} /> How to fix</>}
                </button>
              </div>
            </div>
          ))}
        </div>
        {rep.warnings.length > 0 && <div className="sp-note">{rep.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
        {err && <div className="banner error">{err}</div>}
        <div className="sp-foot">
          <button type="button" className="btn" onClick={printReport}><Icon.Page size={14} /> Print / PDF</button>
          <button type="button" className="btn primary" disabled={disabled || !fixable || !rep.fixAllPrompt} onClick={() => rep.fixAllPrompt && onAsk(rep.fixAllPrompt)} title={fixable ? "Send the fixes the assistant can make to the chat (it proposes a plan first)" : "None of these can be changed from page content"}>
            <Icon.Wand size={14} /> Fix all{fixable ? ` (${fixable})` : ""}
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ start + history
  return (
    <div className="sp">
      <div className="sp-intro">
        <h2>Google PageSpeed report</h2>
        <p className="muted small">Scores, Core Web Vitals and the fixes that matter most for one page.</p>
      </div>
      <label className="sp-field">Page
        <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </label>
      <div className="sp-field"><span>Device</span>
        <div className="sp-seg" role="radiogroup" aria-label="Device">
          {(["mobile", "desktop", "both"] as const).map((d) => <button key={d} type="button" role="radio" aria-checked={device === d} className={device === d ? "on" : ""} onClick={() => setDevice(d)}>{cap(d)}</button>)}
        </div>
      </div>
      <button type="button" className="btn primary sp-run" disabled={!url.trim()} onClick={() => void start()}><Icon.Play size={15} /> Run report</button>
      {info && (info.local
        ? <p className="muted small">This address is only on your computer, so Google cannot test it: Lighthouse runs in this computer's Chrome / Edge instead (same scores and fixes, no real-visitor data).</p>
        : info.keySource === "none" ? <p className="muted small">Tip: Google allows only a few tests without an API key. Add a free key in the Livecrafts app → Integrations → PageSpeed.</p> : null)}
      {err && <div className="banner error">{err}</div>}
      <div className="sp-history">
        <b className="small">Earlier reports for this page</b>
        {history === null ? <span className="spin" /> : history.length === 0 ? <p className="muted small">None yet.</p> : history.map((h) => (
          <button key={h.id} type="button" className="sp-hist" onClick={() => void open(h.id)}>
            <span className="sp-hist-text"><span>{whenLabel(h.startedAt)}</span><span className="muted small">{h.status === "failed" ? (h.error || "Failed") : h.status === "running" ? "Running…" : h.source === "google" ? "Google" : "This computer"}</span></span>
            <span className="sp-hist-scores">{h.scores.map((s) => <span key={s.device} className={`sp-pill ${scoreTone(s.performance)}`} title={`${cap(s.device)} performance`}>{s.device === "mobile" ? <Icon.Phone size={11} /> : <Icon.Monitor size={11} />}{s.performance ?? "–"}</span>)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const CAT = { performance: "Speed", accessibility: "Accessibility", seo: "SEO", "best-practices": "Best practice" } as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "") || u;

function SpeedHead({ url }: { url: string }) {
  return <div className="sp-head"><div className="sp-head-text"><span className="muted small">Page tested</span><b>{shortUrl(url)}</b></div></div>;
}

function ScoreRing({ label, value, change }: { label: string; value: number | null; change: string }) {
  const tone = scoreTone(value);
  const C = 2 * Math.PI * 31;
  const word = { good: "good", ok: "needs work", bad: "poor", none: "not measured" }[tone];
  return (
    <div className="sp-score">
      <svg role="img" aria-label={`${label} ${value ?? "not measured"}${value !== null ? " out of 100" : ""}, ${word}`} width="68" height="68" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="31" className={`ring-bg ${tone}`} strokeWidth="6" />
        <circle cx="36" cy="36" r="31" className={`ring ${tone}`} strokeWidth="6" strokeLinecap="round" fill="none" strokeDasharray={`${((value ?? 0) / 100) * C} ${C}`} transform="rotate(-90 36 36)" />
        <text x="36" y="42" textAnchor="middle" className={`ring-num ${tone}`}>{value ?? "–"}</text>
      </svg>
      <span>{label}</span>
      {change && <span className={`sp-delta ${change.startsWith("+") ? "up" : "down"}`}>{change}</span>}
    </div>
  );
}

function Vitals({ rep }: { rep: SpeedReport }) {
  const field = rep.field.metrics;
  return (
    <div className="sp-vitals">
      <div className="sp-sec-title"><b>Core Web Vitals</b><span className="muted small">{field.length ? `Real visitors, last 28 days${rep.field.scope === "site" ? " (whole site)" : ""}` : rep.source === "local" ? "Lab test on this computer" : "Lab test (not enough real visitors yet)"}</span></div>
      {(field.length ? field : rep.lab).map((m) => <MetricRow key={m.id} m={m} />)}
      {field.length > 0 && (
        <details className="sp-lab"><summary>Lab test details</summary>{rep.lab.map((m) => <MetricRow key={m.id} m={m} />)}</details>
      )}
    </div>
  );
}

function MetricRow({ m }: { m: SpeedReport["lab"][number] }) {
  return (
    <div className="sp-metric">
      <span className={`sp-dot ${m.rating ?? "none"}`} aria-hidden="true" />
      <span className="sp-metric-name"><span>{m.name}</span><span className="muted small">{m.hint}</span></span>
      <span className={`sp-metric-val ${m.rating ?? ""}`}><span className="sp-mono">{m.display}</span><span className="small">{m.rating ? RATING_LABEL[m.rating] : ""}</span></span>
    </div>
  );
}
