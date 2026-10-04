import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, buildTimeline, followJob, lastStatus, ledgerFrom } from "./api";
import { ChangesPanel, type PanelTab } from "./components/ChangesPanel";
import { Composer, type Context } from "./components/Composer";
import { IntegrationsDialog, SiteDialog, TokenDialog } from "./components/Dialogs";
import { Transcript } from "./components/Messages";
import { Sidebar } from "./components/Sidebar";
import { SitesDialog } from "./components/SitesDialog";
import { ApprovalModePicker } from "./components/RequestChanges";
import { Icon } from "./icons";
import type { ApprovalMode, ChangeRecord, JobEvent, JobSummary, Site } from "./types";
import { WRITE_TOOLS, groupRequests, prefs, titleOf, writeCount, type RequestGroup } from "./util";

const params = new URLSearchParams(location.search);
const wide = () => window.innerWidth > 800;
const STATUS_TEXT: Record<string, string> = {
  idle: "Ready", queued: "Starting…", running: "Working…", waiting_approval: "Waiting for your approval",
  completed: "Done", failed: "Failed", interrupted: "Interrupted",
};

export default function App() {
  const [health, setHealth] = useState<{ model: string; authRequired: boolean } | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string>(params.get("site") ?? localStorage.getItem("lc_site") ?? "");
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobId, setJobId] = useState<string>(params.get("job") ?? "");
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [live, setLive] = useState(true);
  const [dialog, setDialog] = useState<"" | "site" | "sites" | "token" | "integrations">("");
  const [mode, setMode] = useState<ApprovalMode>(() => (localStorage.getItem("lc_mode") as ApprovalMode) || "request");
  const [panelTab, setPanelTab] = useState<PanelTab>(() => (localStorage.getItem("lc_tab") as PanelTab) || "preview");
  const [hostingerOk, setHostingerOk] = useState(false);
  const [baseLedger, setBaseLedger] = useState<ChangeRecord[]>([]);
  const [navigate, setNavigate] = useState<{ url: string; n: number } | undefined>();
  const [tokenReason, setTokenReason] = useState<string | undefined>();
  const [navOpen, setNavOpen] = useState(wide());
  const [panelOpen, setPanelOpen] = useState(window.innerWidth > 1280);
  const [answering, setAnswering] = useState(false);
  const [problem, setProblem] = useState("");
  const [toast, setToast] = useState("");
  const [kebab, setKebab] = useState(false);
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>();
  const [titles, setTitles] = useState(prefs.titles());
  const [pinned, setPinned] = useState(prefs.pins());
  const [ctx, setCtx] = useState<Context>({ pageUrl: params.get("page") ?? undefined, selectedTarget: params.get("target") ?? undefined });
  const kebabRef = useRef<HTMLDivElement>(null);

  const say = useCallback((t: string) => { setToast(t); setTimeout(() => setToast(""), 1800); }, []);
  const guard = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) { setTokenReason("The backend rejected the token. Enter the correct one."); setDialog("token"); }
    else setProblem((e as Error).message);
  }, []);
  const refreshJobs = useCallback(() => { api.jobs().then(setJobs).catch(() => {}); }, []);
  const refreshSites = useCallback(() => {
    api.sites().then(setSites).catch(() => {});
    api.integrations().then((r) => setHostingerOk(r.hostinger.connected)).catch(() => {});
  }, []);

  useEffect(() => {
    api.health().then((h) => { setHealth(h); if (h.authRequired && !localStorage.getItem("lc_token")) { setTokenReason(undefined); setDialog("token"); } }).catch((e) => setProblem("Cannot reach the backend: " + e.message));
    api.sites().then((s) => { setSites(s); setSiteId((cur) => (s.some((x) => x.id === cur) ? cur : s[0]?.id ?? "")); }).catch(guard);
    refreshJobs();
    api.integrations().then((r) => setHostingerOk(r.hostinger.connected)).catch(() => {});
    const t = setInterval(refreshJobs, 5000);
    return () => clearInterval(t);
  }, [guard, refreshJobs]);

  useEffect(() => { if (siteId) localStorage.setItem("lc_site", siteId); }, [siteId]);
  useEffect(() => { try { localStorage.setItem("lc_tab", panelTab); } catch { /* ignore */ } }, [panelTab]);

  useEffect(() => {
    setEvents([]); setBaseLedger([]);
    if (!jobId) return;
    api.job(jobId).then((j) => { setBaseLedger(j.changes ?? []); if (j.approvalMode) setMode(j.approvalMode); }).catch(() => {});
    return followJob(jobId, (e) => {
      setEvents((cur) => [...cur, e]);
      if (e.type === "status") refreshJobs();
      // A change just landed on the live site: show it in the preview (not when an old chat is replayed).
      if (e.type === "tool_end" && e.data.ok && WRITE_TOOLS.includes(String(e.data.tool)) && Date.now() - Date.parse(e.ts) < 15_000) {
        setPanelTab("preview"); if (window.innerWidth > 1100) setPanelOpen(true);
        // a new page/post: show that page in the preview
        if ((e.data.tool === "create_page" || e.data.tool === "create_post") && e.data.ui?.link) setNavigate({ url: String(e.data.ui.link), n: Date.now() });
      }
    }, setLive);
  }, [jobId, refreshJobs]);

  useEffect(() => {
    if (!kebab) return;
    const close = (e: MouseEvent) => { if (!kebabRef.current?.contains(e.target as Node)) setKebab(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [kebab]);

  const site = sites.find((s) => s.id === siteId);
  const siteJobs = useMemo(() => jobs.filter((j) => j.siteId === siteId), [jobs, siteId]);
  const job = jobs.find((j) => j.id === jobId);
  const status = jobId ? lastStatus(events) : "idle";
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const ledger = useMemo(() => ledgerFrom(baseLedger, events), [baseLedger, events]);
  const groups = useMemo(() => groupRequests(timeline, ledger, status === "queued" || status === "running"), [timeline, ledger, status]);
  const changeCount = groups.filter((g) => g.changes.length).length;
  const reloadKey = useMemo(() => writeCount(timeline) + events.filter((e) => e.type === "change_update").length, [timeline, events]);
  const togglePanel = (t: PanelTab) => { if (panelOpen && panelTab === t) setPanelOpen(false); else { setPanelTab(t); setPanelOpen(true); } };
  const working = status === "queued" || status === "running";
  const waiting = status === "waiting_approval";
  const model = health?.model ?? "model";
  const title = job ? titleOf(job, titles) : "New chat";

  async function send(prompt: string, fileIds: string[]) {
    setProblem("");
    if (!siteId) { setDialog("site"); return; }
    try {
      const args = { prompt, fileIds, pageUrl: ctx.pageUrl, selectedTarget: ctx.selectedTarget, approvalMode: mode };
      if (jobId && (status === "completed" || status === "failed")) await api.message(jobId, args);
      else { const j = await api.createJob(siteId, args); setJobId(j.id); }
      refreshJobs();
    } catch (e) { guard(e); throw e; }
  }
  async function answer(approvalId: string, approved: boolean, reason?: string) {
    setAnswering(true); setProblem("");
    try { await api.approve(jobId, approvalId, approved, reason); } catch (e) { guard(e); } finally { setAnswering(false); }
  }
  async function revert(g: RequestGroup) {
    setProblem(""); // confirmed inline in the Changes card
    try { const r = await api.revertRequest(jobId, g.requestId); say(`Reverted ${r.reverted} change${r.reverted === 1 ? "" : "s"}`); setPanelTab("preview"); }
    catch (e) { guard(e); }
  }
  async function changeMode(m: ApprovalMode) {
    setMode(m);
    try { localStorage.setItem("lc_mode", m); } catch { /* ignore */ }
    if (jobId) await api.setApprovalMode(jobId, m).catch(guard);
    say(m === "auto" ? "Auto: changes run without asking" : m === "every" ? "Approve every change" : "One approval per request");
  }
  const openInPreview = (url: string) => { setPanelTab("preview"); setPanelOpen(true); setNavigate({ url, n: Date.now() }); };
  const copy = (t: string) => { navigator.clipboard?.writeText(t).then(() => say("Copied"), () => say("Copy failed")); };
  const openJob = (id: string) => { setJobId(id); if (!wide()) setNavOpen(false); };
  const newChat = () => { setJobId(""); if (!wide()) setNavOpen(false); };

  const welcome = (
    <div className="welcome">
      <div className="orb"><Icon.Sparkle size={30} /></div>
      <h1>{site ? "What should we change today?" : "Connect a site to get started"}</h1>
      <p className="muted">{site ? `Describe the change in plain words. I’ll show exactly what will happen on ${site.name} and wait for your approval before anything is written.` : "Add a WordPress site that has the Livecrafts plugin installed."}</p>
      {!site && <button className="btn primary" onClick={() => setDialog("site")}>Connect a site</button>}
      {site && (
        <div className="suggest">
          <button onClick={() => void send("Show me everything I can edit on the home page.", [])}><Icon.List size={15} /> What can I edit on the home page?</button>
          <button onClick={() => void send("List the pages of this site.", [])}><Icon.Globe size={15} /> List the pages of this site</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="shell">
      <div className={`app ${navOpen ? "nav-open" : ""} ${panelOpen ? "panel-open" : ""} ${panelOpen && panelTab === "preview" ? "panel-wide" : ""}`}>
        {navOpen && !wide() && <div className="scrim" onClick={() => setNavOpen(false)} />}
        {navOpen && (
          <Sidebar sites={sites} site={site} jobs={siteJobs} jobId={jobId} titles={titles} pinned={pinned} model={model}
            onSelectSite={(id) => { setSiteId(id); setJobId(""); }} onAddSite={() => setDialog("site")} onManageSites={() => setDialog("sites")} onToken={() => { setTokenReason(undefined); setDialog("token"); }} hostingerOk={hostingerOk} onIntegrations={() => setDialog("integrations")}
            onSelectJob={openJob} onNewChat={newChat} onTogglePin={(id) => setPinned(prefs.togglePin(id))} onHide={() => setNavOpen(false)} />
        )}

        <main className="main">
          <header className="topbar">
            {!navOpen && <button className="ghost-icon" onClick={() => setNavOpen(true)} aria-label="Show sidebar"><Icon.Sidebar size={19} /></button>}
            <div className="top-title" title={title}>{title}</div>
            <span className={`pill ${status}`}>{working && <span className="spin" />}{STATUS_TEXT[status] ?? status}</span>
            {!live && jobId && <span className="pill warn">Reconnecting…</span>}
            {(status === "failed" || status === "interrupted") && <button className="pillbtn" onClick={() => api.resume(jobId).catch(guard)}><Icon.Retry size={15} /> Resume</button>}
            <span className="grow" />
            <button className={`pillbtn ${panelOpen && panelTab === "preview" ? "on" : ""}`} disabled={!site} onClick={() => togglePanel("preview")} title="Live preview of the site"><Icon.Eye size={15} /> <span className="lbl">Preview</span></button>
            <button className="pillbtn" disabled={!jobId} onClick={() => { copy(`${location.origin}${location.pathname}?site=${siteId}&job=${jobId}`); }}><Icon.Share size={15} /> <span className="lbl">Share</span></button>
            <button className={`pillbtn ${panelOpen && panelTab === "changes" ? "on" : ""}`} onClick={() => togglePanel("changes")} title="Changes made in this chat"><Icon.List size={15} /> <span className="lbl">Changes</span>{changeCount > 0 && <span className="count">{changeCount}</span>}</button>
            <div className="kebab-wrap" ref={kebabRef}>
              <button className="ghost-icon" onClick={() => setKebab(!kebab)} aria-label="More" disabled={!jobId}><Icon.More size={18} /></button>
              {kebab && job && (
                <div className="menu down">
                  <button className="menu-item" onClick={() => { setKebab(false); setPinned(prefs.togglePin(jobId)); }}><Icon.Pin size={15} /> {pinned.includes(jobId) ? "Unpin chat" : "Pin chat"}</button>
                  <button className="menu-item" onClick={() => { setKebab(false); const t = window.prompt("Rename chat", title); if (t !== null) setTitles(prefs.setTitle(jobId, t)); }}><Icon.Edit size={15} /> Rename</button>
                  <button className="menu-item" onClick={() => { setKebab(false); copy(`${location.origin}${location.pathname}?site=${siteId}&job=${jobId}`); }}><Icon.Share size={15} /> Copy link</button>
                </div>
              )}
            </div>
          </header>

          <section className="chat-card">
            {problem && <div className="banner error top"><span>{problem}</span><button onClick={() => setProblem("")}><Icon.Close size={14} /></button></div>}
            <Transcript items={timeline} model={model} busy={answering} working={working} welcome={welcome}
              onAnswer={(a, ok, r) => void answer(a, ok, r)} onCopy={copy} onOpen={openInPreview}
              onEdit={(t) => setDraft({ text: t, n: Date.now() })}
              onRetry={(t) => { if (t && (status === "completed" || status === "failed")) void send(t, []); }} />
            <Composer disabled={!siteId || working || waiting} model={model} context={ctx} draft={draft}
              placeholder={waiting ? "Waiting for your approval above…" : working ? "Working…" : site ? "Ask Livecrafts to change anything on your site…" : "Connect a site first"}
              onClearContext={(k) => setCtx((c) => ({ ...c, [k]: undefined }))} onSend={send}
              extra={<><ApprovalModePicker mode={mode} onChange={(m) => void changeMode(m)} /><span className="model-pill" title="Default model (LC_MODEL). A site can choose its own in WordPress → Settings → Livecrafts Assistant."><Icon.Sparkle size={13} /> {model}</span></>} />
          </section>
        </main>

        {panelOpen && <ChangesPanel tab={panelTab} onTab={setPanelTab} jobId={jobId} groups={groups} context={ctx} siteUrl={site?.url} reloadKey={reloadKey} navigate={navigate} busy={working}
          onRevert={revert} onOpen={openInPreview} onClose={() => setPanelOpen(false)} />}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {dialog === "site" && <SiteDialog onClose={() => setDialog("")} onAdded={(s) => { refreshSites(); setSiteId(s.id); setJobId(""); say((s as any).reconnected ? "Site reconnected" : "Site connected"); }} />}
      {dialog === "sites" && <SitesDialog sites={sites} currentId={siteId} onClose={() => setDialog("")} onChanged={refreshSites}
        onSelect={(id) => { setSiteId(id); setJobId(""); }} onAdd={() => setDialog("site")} />}
      {dialog === "integrations" && <IntegrationsDialog sites={sites} onClose={() => { setDialog(""); refreshSites(); }} onSites={refreshSites} />}
      {dialog === "token" && <TokenDialog reason={tokenReason} onClose={() => setDialog("")} />}
    </div>
  );
}
