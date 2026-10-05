import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, buildTimeline, followJob, lastStatus, ledgerFrom, setToken } from "../api";
import { Composer } from "../components/Composer";
import { Transcript } from "../components/Messages";
import { ApprovalModePicker, RequestChanges } from "../components/RequestChanges";
import { Icon } from "../icons";
import type { ApprovalMode, AssistantInfo, ChangeRecord, JobEvent, JobSummary, Site } from "../types";
import { groupRequests, titleOf, writeCount } from "../util";
import { QuickActions, elementContext, type ManualEdit, type PickedElement } from "./QuickActions";

/** Settings the WordPress plugin passes in the address (#cfg=...). */
interface WidgetConfig {
  siteUrl: string; pageUrl: string; botName?: string; welcome?: string; accent?: string; approvalMode?: ApprovalMode;
  token?: string; user?: string; parentOrigin: string; tab?: Tab; widgetVersion?: string;
}
type Tab = "chat" | "actions" | "changes";

function readConfig(): WidgetConfig | null {
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get("cfg");
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c.siteUrl || !c.parentOrigin) return null;
    if (c.token) setToken(c.token); // the backend access token from the plugin settings (if the backend requires one)
    return c;
  } catch { return null; }
}
const sameSite = (a: string, b: string) => a.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase() === b.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* blocked */ } },
  sget: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* blocked */ } },
};

/**
 * The chat inside the WordPress widget (an iframe on the live site): Chat · Quick actions · Changes.
 * It talks to its parent page only through postMessage with the site's exact origin.
 */
export default function WidgetApp() {
  const cfg = useMemo(readConfig, []);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => { if (cfg) api.sites().then(setSites).catch((e) => setErr(e.message)); }, [cfg]);
  useEffect(() => { if (cfg) window.parent.postMessage({ type: "lc:ready" }, cfg.parentOrigin); }, [cfg]);

  if (!cfg) return <div className="w-shell"><div className="w-center"><strong>Livecrafts widget</strong><p>This page is opened by the WordPress plugin.</p></div></div>;
  const site = sites?.find((s) => sameSite(s.url, cfg.siteUrl));
  return (
    <div className="w-shell" style={cfg.accent ? ({ "--accent": cfg.accent, "--w-accent": cfg.accent } as React.CSSProperties) : undefined}>
      {err ? <div className="w-center"><strong>Cannot reach the Livecrafts app</strong><p>{err}</p></div>
        : !sites ? <div className="w-center"><span className="spin" /></div>
        : !site ? <ConnectSite cfg={cfg} onDone={() => api.sites().then(setSites)} />
        : <Widget cfg={cfg} site={site} />}
    </div>
  );
}

function ConnectSite({ cfg, onDone }: { cfg: WidgetConfig; onDone: () => void }) {
  const [f, setF] = useState({ username: cfg.user ?? "", appPassword: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="w-connect">
      <div className="qa-orb"><Icon.Globe size={24} /></div>
      <h2>Connect this site</h2>
      <p className="muted">One time: let {cfg.botName || "the assistant"} work on <b>{cfg.siteUrl.replace(/^https?:\/\//, "")}</b>.</p>
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr("");
        try { await api.addSite({ name: cfg.siteUrl.replace(/^https?:\/\//, ""), url: cfg.siteUrl, username: f.username.trim(), appPassword: f.appPassword.trim() }); onDone(); }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <label>WordPress username <input required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></label>
        <label>Application Password <input required type="password" value={f.appPassword} onChange={(e) => setF({ ...f, appPassword: e.target.value })} placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" autoComplete="new-password" /></label>
        <p className="muted small">Create it in WordPress → Users → Profile → Application Passwords (an administrator account, so theme files can be edited too).</p>
        {err && <div className="banner error">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Connect"}</button>
      </form>
    </div>
  );
}

function Widget({ cfg, site }: { cfg: WidgetConfig; site: Site }) {
  const jobKey = `lcw_job:${site.id}`;
  const [info, setInfo] = useState<AssistantInfo>({ botName: cfg.botName, welcome: cfg.welcome, approvalMode: cfg.approvalMode });
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobId, setJobId] = useState(store.get(jobKey) ?? "");
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [baseLedger, setBaseLedger] = useState<ChangeRecord[]>([]);
  const [tab, setTabState] = useState<Tab>(cfg.tab ?? "chat");
  const [mode, setMode] = useState<ApprovalMode>((store.get("lcw_mode") as ApprovalMode) || cfg.approvalMode || "request");
  const [selected, setSelected] = useState<PickedElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<"" | "history">("");
  const [answering, setAnswering] = useState(false);
  const [problem, setProblem] = useState("");
  const [toast, setToast] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(store.get("lcw_refresh") !== "0");
  const baseline = useRef<number | null>(null);

  const post = useCallback((msg: Record<string, unknown>) => window.parent.postMessage(msg, cfg.parentOrigin), [cfg.parentOrigin]);
  const say = (t: string) => { setToast(t); setTimeout(() => setToast(""), 1800); };
  const setTab = (t: Tab) => { setTabState(t); post({ type: "lc:tab", tab: t }); };
  const refreshJobs = useCallback(() => api.jobs().then((j) => setJobs(j.filter((x) => x.siteId === site.id))).catch(() => {}), [site.id]);

  useEffect(() => { api.assistant(site.id).then((a) => { setInfo((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v)) })); if (!store.get("lcw_mode") && a.approvalMode) setMode(a.approvalMode); }).catch(() => {}); refreshJobs(); }, [site.id, refreshJobs]);
  useEffect(() => { store.set(jobKey, jobId || null); }, [jobId, jobKey]);

  // messages from the page (element picker)
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== cfg.parentOrigin || !e.data || typeof e.data.type !== "string") return;
      if (e.data.type === "lc:selected") { setSelected(e.data.element as PickedElement); setPicking(false); setTab("actions"); }
      if (e.data.type === "lc:pick-ended") setPicking(false);
      if (e.data.type === "lc:text-edited") textEdited.current?.(String(e.data.selector), String(e.data.oldText ?? ""), String(e.data.newText ?? ""));
      if (e.data.type === "lc:text-error") setProblem(String(e.data.error ?? "Could not edit that text."));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [cfg.parentOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  // follow the current chat
  useEffect(() => {
    setEvents([]); setBaseLedger([]); baseline.current = null;
    if (!jobId) return;
    let alive = true;
    api.job(jobId).then((j) => {
      if (!alive) return;
      setBaseLedger(j.changes ?? []);
      if (j.approvalMode) setMode(j.approvalMode);
      // writes that already happened before this page load must not trigger another reload
      const done = writeCount(buildTimeline((j as any).events ?? [])) + ((j as any).events ?? []).filter((e: JobEvent) => e.type === "change_update").length;
      const key = `lcw_reloaded:${jobId}`;
      baseline.current = Math.max(Number(store.sget(key) ?? -1), done);
      store.sset(key, String(baseline.current));
    }).catch(() => { if (alive) { setJobId(""); } });
    const stop = followJob(jobId, (e) => { setEvents((cur) => [...cur, e]); if (e.type === "status") refreshJobs(); }, () => {});
    return () => { alive = false; stop(); };
  }, [jobId, refreshJobs]);

  const status = jobId ? lastStatus(events) : "idle";
  const working = status === "queued" || status === "running";
  const waiting = status === "waiting_approval";
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const ledger = useMemo(() => ledgerFrom(baseLedger, events), [baseLedger, events]);
  const groups = useMemo(() => groupRequests(timeline, ledger, working), [timeline, ledger, working]);
  const writes = useMemo(() => writeCount(timeline) + events.filter((e) => e.type === "change_update").length, [timeline, events]);
  const lastRevertable = [...groups].reverse().find((g) => g.changes.some((c) => !c.revertedAt && c.revert));

  // show the result: reload the page once the assistant has finished a step that changed the site
  useEffect(() => {
    if (!jobId || baseline.current === null || !autoRefresh || working) return;
    if (writes > baseline.current) {
      baseline.current = writes;
      store.sset(`lcw_reloaded:${jobId}`, String(writes));
      post({ type: "lc:reload", tab });
    }
  }, [writes, working, jobId, autoRefresh, post, tab]);

  /** Manual edit: saved by the backend without AI, recorded in Changes; the page then reloads to show it. */
  async function manualEdit(edit: ManualEdit): Promise<boolean> {
    setProblem("");
    try {
      const r = await api.manual(site.id, { ...edit, jobId: jobId || undefined });
      if (r.jobId !== jobId) setJobId(r.jobId);
      say(r.note ? "Saved (see note in chat)" : "Saved");
      if (r.note) setProblem(r.note);
      post({ type: "lc:preview-clear" });
      if (autoRefresh) setTimeout(() => post({ type: "lc:reload", tab }), r.note ? 1800 : 300);
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      post({ type: "lc:preview-clear" });
      return false;
    }
  }
  const textEdited = useRef<((selector: string, oldText: string, newText: string) => void) | null>(null);
  textEdited.current = (selector, oldText, newText) => {
    if (!selected) return;
    void manualEdit({ kind: "text", selector, label: selected.label, pageUrl: selected.pageUrl, pageKey: selected.pageKey, elementor: selected.elementor ?? null, oldText, newText, hasChildren: selected.hasChildren });
  };

  async function send(prompt: string, fileIds: string[], extraContext?: string) {
    setProblem("");
    try {
      const args = { prompt, fileIds, pageUrl: cfg.pageUrl, approvalMode: mode, extraContext };
      if (jobId && (status === "completed" || status === "failed")) await api.message(jobId, args);
      else { const j = await api.createJob(site.id, args); setJobId(j.id); }
      setTab("chat");
      refreshJobs();
    } catch (e) { setProblem((e as Error).message); throw e; }
  }
  async function answer(approvalId: string, ok: boolean, reason?: string) {
    setAnswering(true);
    try { await api.approve(jobId, approvalId, ok, reason); } catch (e) { setProblem((e as Error).message); } finally { setAnswering(false); }
  }
  async function revertGroup(requestId: number) {
    try { const r = await api.revertRequest(jobId, requestId); say(`Reverted ${r.reverted}`); }
    catch (e) { setProblem((e as Error).message); }
  }
  async function changeMode(m: ApprovalMode) {
    setMode(m); store.set("lcw_mode", m);
    if (jobId) await api.setApprovalMode(jobId, m).catch(() => {});
  }
  async function clearHistory() {
    setConfirmClear(false);
    let failed = 0;
    for (const j of jobs) await api.deleteJob(j.id).catch(() => { failed++; });
    setJobId(""); setMenu(""); refreshJobs();
    say(failed ? `${failed} chat(s) still working - not deleted` : "History cleared");
  }

  const name = info.botName || "Livecrafts";
  const welcome = (
    <div className="w-welcome">
      <div className="w-avatar lg">{name.charAt(0).toUpperCase()}</div>
      <div className="w-bubble">{info.welcome || "Hi! What would you like to change on this page?"}</div>
      <div className="w-suggest">
        <button onClick={() => { setTab("actions"); setPicking(true); post({ type: "lc:pick" }); }}><Icon.Cursor size={14} /> Pick an element to change</button>
        <button onClick={() => void send("What can I edit on this page? Give me a short overview.", [])}><Icon.List size={14} /> What can I edit here?</button>
        <button onClick={() => void send("Check this page on mobile and tell me what looks wrong.", [])}><Icon.Phone size={14} /> Check this page on mobile</button>
      </div>
    </div>
  );

  return (
    <div className="w-app">
      <header className="w-head">
        <div className="w-avatar">{name.charAt(0).toUpperCase()}</div>
        <div className="w-title">
          <b>{name}</b>
          <small>{working ? <><span className="spin" /> Working…</> : waiting ? "Waiting for your approval" : site.name}</small>
        </div>
        <button className="w-icon" title="New chat" onClick={() => { setJobId(""); setTab("chat"); }}><Icon.Plus size={17} /></button>
        <div className="w-menuwrap">
          <button className="w-icon" title="Chat history" aria-expanded={menu === "history"} onClick={() => setMenu(menu ? "" : "history")}><Icon.Chat size={17} /></button>
          {menu === "history" && (
            <>
              <div className="mode-scrim" onMouseDown={() => { setMenu(""); setConfirmClear(false); }} />
              <div className="menu down w-history">
                <div className="menu-label">Chats on this site</div>
                {jobs.length === 0 && <div className="menu-foot">No chats yet.</div>}
                <div className="w-hist-list">
                  {jobs.map((j) => (
                    <button key={j.id} className={`menu-item ${j.id === jobId ? "on" : ""}`} onClick={() => { setJobId(j.id); setMenu(""); setTab("chat"); }}>
                      <span className={`dot ${j.status}`} /><span className="grow hist-text">{titleOf(j, {})}</span>
                    </button>
                  ))}
                </div>
                <div className="menu-sep" />
                <label className="menu-item w-toggle"><input type="checkbox" checked={autoRefresh} onChange={(e) => { setAutoRefresh(e.target.checked); store.set("lcw_refresh", e.target.checked ? "1" : "0"); }} /> Reload the page after changes</label>
                {!confirmClear
                  ? <button className="menu-item danger" disabled={!jobs.length} onClick={() => setConfirmClear(true)}><Icon.Trash size={15} /> Clear history</button>
                  : <div className="w-confirm">
                      <span>Delete all {jobs.length} chat{jobs.length === 1 ? "" : "s"}? Changes on the site stay.</span>
                      <div><button className="rbtn" onClick={() => setConfirmClear(false)}>Cancel</button><button className="rbtn danger solid" onClick={() => void clearHistory()}>Delete</button></div>
                    </div>}
              </div>
            </>
          )}
        </div>
        <button className="w-icon" title="Close" onClick={() => post({ type: "lc:close" })}><Icon.Close size={18} /></button>
      </header>

      <nav className="w-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}><Icon.Chat size={15} /> Chat</button>
        <button role="tab" aria-selected={tab === "actions"} className={tab === "actions" ? "on" : ""} onClick={() => setTab("actions")}><Icon.Wand size={15} /> Quick actions{selected && <span className="qa-dot" />}</button>
        <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}><Icon.List size={15} /> Changes{groups.filter((g) => g.changes.length).length > 0 && <span className="count">{groups.filter((g) => g.changes.length).length}</span>}</button>
      </nav>

      {problem && <div className="banner error w-banner"><span>{problem}</span><button onClick={() => setProblem("")}><Icon.Close size={13} /></button></div>}

      <div className="w-body">
        {tab === "chat" && (
          <div className="w-chat">
            <Transcript items={timeline} model={name} busy={answering} working={working} welcome={welcome}
              onAnswer={(a, ok, r) => void answer(a, ok, r)} onCopy={(t) => { navigator.clipboard?.writeText(t); say("Copied"); }}
              onEdit={() => {}} onRetry={(t) => { if (t && (status === "completed" || status === "failed")) void send(t, []); }}
              onOpen={(url) => post({ type: "lc:navigate", url })} />
            <Composer compact disabled={working || waiting} model={name} context={{}}
              placeholder={waiting ? "Answer the approval above…" : working ? "Working…" : "Ask for any change on this page…"}
              onClearContext={() => {}} onSend={(p, f) => send(p, f, selected ? `The person may mean this element (they picked it on the page):\n${elementContext(selected)}` : undefined)}
              chips={selected ? <span className="chip"><Icon.Cursor size={12} /> {selected.label}<button aria-label="forget selection" onClick={() => setSelected(null)}><Icon.Close size={11} /></button></span> : undefined}
              extra={<ApprovalModePicker mode={mode} onChange={(m) => void changeMode(m)} />} />
          </div>
        )}
        {tab === "actions" && (
          <div className="w-scroll">
            <QuickActions siteId={site.id} widgetVersion={cfg.widgetVersion} selected={selected} picking={picking} disabled={working || waiting}
              onPick={() => { setPicking(true); post({ type: "lc:pick" }); }} onCancelPick={() => { setPicking(false); post({ type: "lc:cancel-pick" }); }}
              onSend={send} canUndo={!!lastRevertable && !working}
              onUndo={() => { if (lastRevertable) void revertGroup(lastRevertable.requestId); }}
              onHighlight={(selector) => post({ type: "lc:highlight", selector })}
              onManual={manualEdit} onPreview={(selector, styles) => post({ type: "lc:preview", selector, styles })}
              onClearPreview={() => post({ type: "lc:preview-clear" })} onEditText={(selector) => post({ type: "lc:edit-text", selector })} />
          </div>
        )}
        {tab === "changes" && (
          <div className="w-scroll pad">
            <RequestChanges jobId={jobId} groups={groups} busy={working}
              onRevert={(g) => revertGroup(g.requestId)}
              onOpen={(url) => post({ type: "lc:navigate", url })}
              emptyText="Each request shows up here as one item. Click a file to see exactly what changed, or revert the whole request." />
          </div>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
