import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import { PHASE_TEXT, shortWhen, updatable, type PluginActionResult, type PluginHistoryEntry, type PluginInfo, type PluginJob, type PluginList } from "../plugins";

type Ask = { kind: "update" | "rollback" | "all"; plugin?: string; version?: string; backup?: string } | null;
type Outcome = { tone: "ok" | "warn" | "error"; text: string };

/**
 * More → Plugins: available updates, one-click update (backup → update → health check → automatic rollback if the site
 * breaks), roll back to a saved or official version, and the history. Everything here is live at once, so each action
 * asks once inline first.
 */
export function PluginsPanel({ siteId, disabled, onBack, onChanged }: {
  siteId: string; disabled: boolean; onBack: () => void; onChanged: (msg: string) => void;
}) {
  const [data, setData] = useState<PluginList | null>(null);
  const [history, setHistory] = useState<PluginHistoryEntry[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");                 // plugin file being changed, or "all"
  const [ask, setAsk] = useState<Ask>(null);
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const [open, setOpen] = useState("");                 // plugin whose "Other versions" list is open
  const [official, setOfficial] = useState<Record<string, string[] | string>>({});

  async function load(refresh = false) {
    setLoading(true); setErr("");
    try {
      const [d, h] = await Promise.all([api.plugins(siteId, refresh), api.pluginHistory(siteId).catch(() => ({ history: [] }))]);
      setData(d); setHistory(h.history);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = (plugin: string, r: PluginActionResult) => {
    const tone: Outcome["tone"] = r.ok ? (r.verified === false ? "warn" : "ok") : r.rolledBack ? "warn" : "error";
    setOutcome((o) => ({ ...o, [plugin]: { tone, text: r.message + (r.ok && r.dbHeavy ? " This plugin also changes the database; a rollback restores its files only." : "") } }));
  };

  const [phase, setPhase] = useState<PluginJob["phase"] | "">("");
  const [secs, setSecs] = useState(0);
  // The update runs as a job on the backend (backup -> install + check -> repair if the server cuts it off); poll it.
  async function update(plugin: string): Promise<boolean> {
    setBusy(plugin); setPhase("preparing"); setSecs(0); setOutcome((o) => { const n = { ...o }; delete n[plugin]; return n; });
    const t0 = Date.now();
    try {
      let j = await api.updatePlugin(siteId, plugin);
      let misses = 0;
      while (j.phase !== "done") {
        await new Promise((r) => setTimeout(r, 1500));
        setSecs(Math.round((Date.now() - t0) / 1000));
        try { j = await api.pluginJob(siteId, j.id); setPhase(j.phase); misses = 0; }
        catch (e) { if (++misses > 20) throw e; }        // the backend can be slow while the site is busy; keep waiting
      }
      if (j.error || !j.result) { setOutcome((o) => ({ ...o, [plugin]: { tone: "error", text: j.error ?? "The update did not finish." } })); return false; }
      say(plugin, j.result); onChanged(j.result.message); return j.result.ok;
    } catch (e) { setOutcome((o) => ({ ...o, [plugin]: { tone: "error", text: (e as Error).message } })); return false; }
    finally { setBusy(""); setPhase(""); }
  }

  async function updateAll() {
    const list = (data?.plugins ?? []).filter(updatable);
    setBusy("all");
    for (const p of list) {
      const ok = await update(p.plugin);
      if (!ok) { setOutcome((o) => ({ ...o, _all: { tone: "warn", text: `Stopped at ${p.name}. The plugins after it were not touched.` } })); break; }
      setBusy("all");
    }
    setBusy(""); await load();
  }

  async function rollback(plugin: string, to: { backup?: string; version?: string }) {
    setBusy(plugin); setOpen("");
    try { const r = await api.rollbackPlugin(siteId, plugin, to); say(plugin, r); onChanged(r.message); }
    catch (e) { setOutcome((o) => ({ ...o, [plugin]: { tone: "error", text: (e as Error).message } })); }
    finally { setBusy(""); await load(); }
  }

  async function loadOfficial(p: PluginInfo) {
    setOfficial((o) => ({ ...o, [p.plugin]: "loading" }));
    try { const r = await api.pluginVersions(siteId, p.plugin); setOfficial((o) => ({ ...o, [p.plugin]: r.versions.length ? r.versions : (r.note || "No older official versions.") })); }
    catch (e) { setOfficial((o) => ({ ...o, [p.plugin]: (e as Error).message })); }
  }

  async function confirm() {
    const a = ask; setAsk(null);
    if (!a) return;
    if (a.kind === "all") return updateAll();
    if (a.kind === "update" && a.plugin) { await update(a.plugin); return load(); }
    if (a.kind === "rollback" && a.plugin) return rollback(a.plugin, a.backup ? { backup: a.backup } : a.version ? { version: a.version } : {});
  }

  const plugins = data?.plugins ?? [];
  const canAll = plugins.filter(updatable);
  const locked = disabled || !!busy || !data?.canModify;

  const AskRow = ({ text }: { text: string }) => (
    <div className="pl-ask">
      <span>{text}</span>
      <span className="pl-btns">
        <button type="button" className="btn ghost sm" onClick={() => setAsk(null)}>Cancel</button>
        <button type="button" className="btn sm primary" onClick={() => void confirm()}>Yes, go ahead</button>
      </span>
    </div>
  );

  return (
    <div className="pl">
      <button type="button" className="sp-back" onClick={onBack}><Icon.ChevronRight size={13} /> Back</button>
      <div className="pl-head">
        <div><h2>Plugins</h2><span className="muted small">{data ? `WordPress ${data.wp} · ${plugins.length} installed${data.checkedAt ? ` · checked ${shortWhen(data.checkedAt)}` : ""}` : "Loading…"}</span></div>
        <button type="button" className="btn sm" disabled={loading || !!busy} onClick={() => void load(true)}>{loading ? <span className="spin" /> : <Icon.Retry size={13} />} Check for updates</button>
      </div>
      {err && <div className="banner error">{err}</div>}
      {data && !data.canModify && <div className="banner error">{data.blocked || "Plugins cannot be changed on this site."}</div>}
      {data && (
        <div className="pl-all">
          <span className="small">{canAll.length ? `${canAll.length} update${canAll.length === 1 ? "" : "s"} available` : "Everything is up to date."}</span>
          {canAll.length > 1 && <button type="button" className="btn sm primary" disabled={locked} onClick={() => setAsk({ kind: "all" })}>{busy === "all" ? <span className="spin" /> : null} Update all ({canAll.length})</button>}
        </div>
      )}
      {ask?.kind === "all" && <AskRow text={`Update ${canAll.length} plugins one at a time? Each goes live at once with a backup, and it stops at the first problem.`} />}
      {outcome._all && <div className={`banner ${outcome._all.tone === "warn" ? "warn" : outcome._all.tone}`}>{outcome._all.text}</div>}
      <p className="muted small pl-note">Updates are live at once. A backup is saved first, the homepage and wp-admin are checked after, and if they break the old version comes back by itself.</p>

      <div className="pl-list">
        {plugins.map((p) => {
          const older = p.backups.filter((b) => b.version !== p.version);
          const out = outcome[p.plugin];
          const working = busy === p.plugin;
          const off = official[p.plugin];
          return (
            <div key={p.plugin} className={`pl-item ${p.update ? "has-update" : ""}`} data-plugin={p.plugin}>
              <div className="pl-top">
                <div className="pl-name"><b>{p.name}</b><span className="muted small">{p.version}{p.active ? "" : " · inactive"}</span></div>
                {p.update ? <span className="pl-pill up">{p.version} → {p.update.version}</span> : p.self ? <span className="pl-pill">zip only</span> : null}
              </div>
              {working && (
                <div className="pl-working" role="status" aria-live="polite">
                  <span className="spin" />
                  <span>{phase ? PHASE_TEXT[phase] : "Working…"}{secs >= 5 ? ` ${secs} s` : ""}<br /><span className="muted small">It keeps running on the server even if you close the widget.</span></span>
                </div>
              )}
              {out && <div className={`banner ${out.tone === "warn" ? "warn" : out.tone}`}>{out.text}</div>}
              {p.self && <p className="muted small">Livecrafts is updated by uploading its zip (Plugins → Add New → Upload).</p>}
              {p.update && !p.self && !p.update.package && <p className="muted small">No download available. Premium plugins need an active licence to update.</p>}
              {p.update && !p.self && p.update.package && !p.update.compatible && <p className="muted small">Not compatible: needs {p.update.requires ? `WordPress ${p.update.requires}` : ""}{p.update.requires && p.update.requiresPhp ? " and " : ""}{p.update.requiresPhp ? `PHP ${p.update.requiresPhp}` : ""}.</p>}
              {p.update && p.dbHeavy && !p.self && <p className="pl-warn small">Changes the database when it updates. A rollback restores the files only, so take a hosting backup first for big updates.</p>}

              {ask && ask.plugin === p.plugin && <AskRow text={ask.kind === "update"
                ? `Update ${p.name} to ${p.update?.version}? It goes live at once; ${p.version} is saved first.`
                : `Put ${p.name} back to ${ask.version ?? older[0]?.version}? This is live at once; ${p.version} is saved too.`} />}

              {!p.self && !working && !(ask && ask.plugin === p.plugin) && (
                <div className="pl-actions">
                  {(older.length > 0 || p.wporg) && <button type="button" className="btn ghost sm" disabled={locked} onClick={() => setOpen(open === p.plugin ? "" : p.plugin)}>Versions</button>}
                  {older.length > 0 && <button type="button" className="btn sm" disabled={locked} onClick={() => setAsk({ kind: "rollback", plugin: p.plugin, version: older[0].version, backup: older[0].id })}><Icon.Retry size={13} /> Roll back to {older[0].version}</button>}
                  {updatable(p) && <button type="button" className="btn sm primary" disabled={locked} onClick={() => setAsk({ kind: "update", plugin: p.plugin })}>Update</button>}
                </div>
              )}

              {open === p.plugin && (
                <div className="pl-versions">
                  <b className="small">Saved on your server</b>
                  {older.length ? older.map((b) => (
                    <div key={b.id} className="pl-ver"><span>{b.version} <span className="muted small">saved {shortWhen(b.at)}</span></span>
                      <button type="button" className="btn ghost sm" disabled={locked} onClick={() => setAsk({ kind: "rollback", plugin: p.plugin, version: b.version, backup: b.id })}>Restore</button></div>
                  )) : <p className="muted small">No older version saved yet. One is saved with every update.</p>}
                  {p.wporg && <>
                    <b className="small">Official versions (WordPress.org)</b>
                    {off === undefined ? <button type="button" className="btn ghost sm" onClick={() => void loadOfficial(p)}>Show official versions</button>
                      : off === "loading" ? <span className="spin" />
                      : typeof off === "string" ? <p className="muted small">{off}</p>
                      : off.map((v) => <div key={v} className="pl-ver"><span>{v}</span><button type="button" className="btn ghost sm" disabled={locked} onClick={() => setAsk({ kind: "rollback", plugin: p.plugin, version: v })}>Install {v}</button></div>)}
                  </>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {history.length > 0 && (
        <details className="pl-history"><summary>History ({history.length})</summary>
          {history.map((h, i) => (
            <div key={i} className="pl-hist">
              <span className={`pl-dot ${h.result === "ok" ? "ok" : h.result === "rolled_back" || h.result === "unverified" ? "warn" : "bad"}`} aria-hidden="true" />
              <span><b>{h.name}</b> {h.action === "update" ? "updated" : h.action === "auto_rollback" ? "update undone automatically" : "rolled back"} {h.from} → {h.to}
                <span className="muted small"> · {shortWhen(h.at)}{h.by ? ` · ${h.by}` : ""}{h.result === "failed" ? " · failed" : h.result === "unverified" ? " · not checked" : ""}</span></span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
