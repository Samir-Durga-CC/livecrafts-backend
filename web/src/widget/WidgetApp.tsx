import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PausedBar, type PauseKind } from "../components/PausedBar";
import { answerEyes, api, buildTimeline, fileUrl, followEyes, followJob, lastStatus, setWidgetToken } from "../api";
import { Composer } from "../components/Composer";
import { Transcript } from "../components/Messages";
import { ApprovalModePicker } from "../components/RequestChanges";
import { Icon } from "../icons";
import type { ApprovalMode, AssistantInfo, JobEvent, JobSummary, Resolved, Site, TimelineItem, UploadedFile } from "../types";
import { titleOf, writeCount } from "../util";
import { elementContext, type PickedElement } from "./element";
import { ElementPanel } from "./ElementPanel";
import { SiteChanges } from "./SiteChanges";
import { connectParent, uploadToMedia } from "./parent";
import { VoiceAgent, type VoiceState } from "./voice";
import { VoiceBar } from "./VoiceBar";

/** Told to the assistant with every spoken request. */
const VOICE_NOTE = "VOICE MODE: the person is talking to you and hears your replies read aloud. Answer in one to three short, natural spoken sentences - no tables, code, URLs or long lists. Say what you did or found; the details stay visible in the chat.";
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|approve|approved|confirm|confirmed|proceed|sounds good|perfect|please do|of course|absolutely|correct)\b[\s,.!]*/i;
const NO = /^(no|nope|nah|don'?t|do not|cancel|deny|reject|not now)\b[\s,.!]*/i;

/** What the voice reads out of the chat: finished answers, approval questions, errors. */
const sayableOf = (items: TimelineItem[]) => items.filter((i) => (i.kind === "assistant" && !i.streaming && i.text.trim() !== "") || i.kind === "approval" || i.kind === "error");
function sayText(i: TimelineItem): string {
  if (i.kind === "assistant") return i.text;
  if (i.kind === "error") return `Sorry, that did not work. ${i.text}`;
  if (i.kind === "approval") return i.tool === "propose_plan" && i.input?.summary ? `Here is my plan: ${i.input.summary}. Shall I go ahead?` : "This needs your OK before I change the site. Shall I go ahead?";
  return "";
}

/** Settings the WordPress plugin passes in the address (#cfg=...). */
interface WidgetConfig {
  siteUrl: string; pageUrl: string; botName?: string; welcome?: string; accent?: string; approvalMode?: ApprovalMode;
  user?: string; parentOrigin: string; tab?: Tab; widgetVersion?: string;
  /** The person's signed token from the plugin: the backend signs them in with it and credits changes to them. */
  widgetToken?: string; postId?: number; view?: "draft" | "live"; drafts?: number; canDeploy?: boolean;
  /** Plugin 0.11+: images from this computer can be saved into the Media Library (and the account may upload). */
  canUpload?: boolean; maxUpload?: number;
}
type Tab = "chat" | "actions" | "changes";

function readConfig(): WidgetConfig | null {
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get("cfg");
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c.siteUrl || !c.parentOrigin) return null;
    if (c.widgetToken) setWidgetToken(c.widgetToken);
    connectParent(c.parentOrigin);
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
  const [tab, setTabState] = useState<Tab>(cfg.tab ?? "chat");
  const [mode, setMode] = useState<ApprovalMode>((store.get("lcw_mode") as ApprovalMode) || cfg.approvalMode || "request");
  const [selected, setSelected] = useState<PickedElement | null>(null);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const editApply = useRef<((text: string) => Promise<void>) | null>(null);
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
      if (e.data.type === "lc:selected") { setSelected(e.data.element as PickedElement); setResolved(null); setResolveError(""); setResolving(true); setPicking(false); setTab("actions"); }
      if (e.data.type === "lc:resolved") { setResolving(false); if (e.data.resolved) setResolved(e.data.resolved as Resolved); else setResolveError(String(e.data.error ?? "Could not find out what this element is.")); }
      if (e.data.type === "lc:pick-ended") setPicking(false);
      if (e.data.type === "lc:text-edited") { const f = editApply.current; editApply.current = null; void f?.(String(e.data.newText ?? "")); }
      if (e.data.type === "lc:text-cancelled") editApply.current = null;
      if (e.data.type === "lc:eyes-result") eyesWaiting.current.get(String(e.data.id))?.({ ok: !!e.data.ok, result: e.data.result, error: e.data.error });
      if (e.data.type === "lc:text-error") setProblem(String(e.data.error ?? "Could not edit that text."));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [cfg.parentOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  // voice: how many speakable items of the current chat were already read out (or are history, never read out)
  const spoken = useRef<{ job: string; count: number } | null>({ job: "", count: 0 });
  const freshJob = useRef("");
  const [spokenReady, setSpokenReady] = useState("");

  // follow the current chat
  useEffect(() => {
    setEvents([]); baseline.current = null;
    spoken.current = jobId ? null : { job: "", count: 0 };
    if (!jobId) return;
    let alive = true;
    api.job(jobId).then((j) => {
      if (!alive) return;
      // a chat that was just started from here: read its answers; an existing one: its history stays silent
      spoken.current = { job: jobId, count: freshJob.current === jobId ? 0 : sayableOf(buildTimeline((j as any).events ?? [])).length };
      setSpokenReady(jobId);
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
  const paused = status === "paused";
  const [pauseKind, setPauseKind] = useState<PauseKind>("note");
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!working) setStopping(false); if (paused) setPauseKind("note"); }, [working, paused]);
  const stop = () => { setStopping(true); api.stop(jobId).catch((e) => { setStopping(false); setProblem((e as Error).message); }); };
  const cont = () => api.resume(jobId).catch((e) => setProblem((e as Error).message));
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const writes = useMemo(() => writeCount(timeline) + events.filter((e) => e.type === "change_update").length, [timeline, events]);

  // ---- voice mode: talk hands-free and hear the answers; every message still appears in the chat
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("off");
  const [heard, setHeard] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [queued, setQueued] = useState("");
  const queuedRef = useRef("");
  const [voiceList, setVoiceList] = useState<string[]>([]);
  const [voiceName, setVoiceName] = useState(store.get("lcw_voice_name") ?? "");
  const [speakOn, setSpeakOn] = useState(store.get("lcw_voice_speak") !== "0");
  const onUtterance = useRef<(text: string) => void>(() => {});
  const [voice] = useState(() => new VoiceAgent({
    onState: setVoiceState, onUtterance: (t) => onUtterance.current(t), onError: (m) => setProblem(m), onBlocked: setBlocked,
  }));
  useEffect(() => () => voice.stop(), [voice]);
  const sayable = useMemo(() => sayableOf(timeline), [timeline]);

  // read out what is new in the chat (declared before the reload below: the answer is spoken before the page reloads)
  useEffect(() => {
    const s = spoken.current;
    if (!s || s.job !== jobId || sayable.length < s.count) return;
    if (voiceOn) for (let k = s.count; k < sayable.length; k++) voice.say(sayText(sayable[k]));
    s.count = sayable.length;
  }, [sayable, jobId, voiceOn, voice, spokenReady]);

  // show the result: reload the page once the assistant has finished a step that changed the site
  useEffect(() => {
    if (!jobId || baseline.current === null || !autoRefresh || working) return;
    if (writes > baseline.current) {
      baseline.current = writes;
      setHistoryKey((k) => k + 1);
      store.sset(`lcw_reloaded:${jobId}`, String(writes));
      const reload = () => post({ type: "lc:reload", tab });
      if (voiceOn) void voice.whenIdle().then(reload); else reload(); // let it finish speaking; voice mode resumes after the reload
    }
  }, [writes, working, jobId, autoRefresh, post, tab, voiceOn, voice]);

  /** A change made in the click panel (directly in WordPress, no AI): show it - it is a draft only editors see. */
  function applied(summary: string) {
    say(`Saved as a draft: ${summary.length > 60 ? summary.slice(0, 59) + "…" : summary}`);
    setHistoryKey((k) => k + 1);
    post({ type: "lc:drafts-changed" });
    if (autoRefresh) setTimeout(() => post({ type: "lc:reload", tab }), 600);
  }
  // ---- eyes: answer "look at the page" requests from the assistant with THIS browser (plugin 0.9.2+ on the page)
  const [looking, setLooking] = useState(0);
  const eyesWaiting = useRef(new Map<string, (r: { ok: boolean; result?: any; error?: string }) => void>());
  const eyesOk = (() => { const v = (cfg.widgetVersion ?? "").split(".").map(Number); return v[0] > 0 || (v[1] ?? 0) > 9 || ((v[1] ?? 0) === 9 && (v[2] ?? 0) >= 2); })();
  useEffect(() => {
    if (!eyesOk) return;
    return followEyes(site.id, cfg.pageUrl, 0, (r) => {
      setLooking((n) => n + 1);
      const finish = async (ans: { ok: boolean; result?: any; error?: string }) => {
        try {
          if (ans.ok && ans.result?.image) {
            // a screenshot taken in this browser: store it on the backend (the assistant receives it as an image)
            const blob = await (await fetch(ans.result.image)).blob();
            const up = await api.uploadFile(new File([blob], `page-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" }));
            const { image: _drop, ...rest } = ans.result;
            ans = { ok: true, result: { ...rest, screenshotId: up.id } };
          }
        } catch (e) { ans = { ok: false, error: `Could not store the screenshot: ${(e as Error).message}` }; }
        await answerEyes(site.id, r.id, ans);
        setLooking((n) => Math.max(0, n - 1));
      };
      eyesWaiting.current.set(r.id, (ans) => { eyesWaiting.current.delete(r.id); void finish(ans); });
      post({ type: "lc:eyes", id: r.id, action: r.action, args: r.args });
      setTimeout(() => { const f = eyesWaiting.current.get(r.id); if (f) f({ ok: false, error: "The page did not answer in time." }); }, 28_000);
    });
  }, [site.id, cfg.pageUrl, eyesOk, post]);

  async function send(prompt: string, fileIds: string[], extraContext?: string) {
    setProblem("");
    try {
      const args = { prompt, fileIds, pageUrl: cfg.pageUrl, approvalMode: mode, extraContext };
      if (jobId && paused) await api.message(jobId, { ...args, kind: pauseKind });
      else if (jobId && (status === "completed" || status === "failed")) await api.message(jobId, args);
      else { const j = await api.createJob(site.id, args); freshJob.current = j.id; setJobId(j.id); }
      setTab("chat");
      refreshJobs();
    } catch (e) { setProblem((e as Error).message); throw e; }
  }
  async function answer(approvalId: string, ok: boolean, reason?: string) {
    setAnswering(true);
    try { await api.approve(jobId, approvalId, ok, reason); } catch (e) { setProblem((e as Error).message); } finally { setAnswering(false); }
  }
  async function changeMode(m: ApprovalMode) {
    setMode(m); store.set("lcw_mode", m);
    if (jobId) await api.setApprovalMode(jobId, m).catch(() => {});
  }
  /** Images attached in the chat: also put them into the WordPress Media Library (as this person), and tell the assistant their ids. */
  const [saveToLibrary, setSaveToLibrary] = useState(store.get("lcw_save_media") !== "0");
  const selectionContext = () => selected ? `The person may mean this element (they picked it on the page):\n${elementContext(selected, resolved?.source)}` : "";
  async function sendFromComposer(prompt: string, fileIds: string[], files: UploadedFile[]) {
    const extra = [selectionContext()];
    if (files.length && cfg.canUpload && saveToLibrary) {
      const saved: string[] = [], failed: string[] = [];
      for (const f of files) {
        try {
          const blob = await (await fetch(await fileUrl(f.id))).blob();
          const att = await uploadToMedia(blob, f.filename);
          saved.push(`attachment ${att.id} (${f.filename}, ${att.url})`);
        } catch (e) { failed.push(`${f.filename}: ${(e as Error).message}`); }
      }
      if (saved.length) {
        say(`Saved ${saved.length} image${saved.length === 1 ? "" : "s"} to the Media Library`);
        extra.push(`The attached image(s) are ALREADY in the WordPress Media Library: ${saved.join("; ")}. Use these attachment ids directly - do not upload them again.`);
      }
      if (failed.length) setProblem(`Not saved to the Media Library: ${failed.join("; ")}`);
    }
    if (voiceOn) extra.push(VOICE_NOTE);
    return send(prompt, fileIds, extra.filter(Boolean).join("\n\n") || undefined);
  }

  // ---- voice: start / end, and what a spoken sentence means right now
  async function startVoice(resume = false) {
    setProblem("");
    const info = await api.voiceInfo().catch(() => ({ available: false, voice: "onyx", voices: [] as string[] }));
    setVoiceList(info.available ? info.voices : []);
    voice.voice = voiceName && info.voices.includes(voiceName) ? voiceName : info.voice;
    voice.speakReplies = speakOn;
    if (!(await voice.start(info.available))) { store.sset("lcw_voice", "0"); return; }
    setVoiceOn(true); setHeard(""); store.sset("lcw_voice", "1");
    if (!resume) voice.say("I'm listening. What would you like to change?");
  }
  function endVoice() {
    voice.stop();
    setVoiceOn(false); setHeard(""); setQueued(""); queuedRef.current = "";
    store.sset("lcw_voice", "0");
  }
  useEffect(() => { if (store.sget("lcw_voice") === "1") void startVoice(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const voiceContext = () => [selectionContext(), VOICE_NOTE].filter(Boolean).join("\n\n");
  const pendingApproval = [...timeline].reverse().find((i): i is Extract<TimelineItem, { kind: "approval" }> => i.kind === "approval" && !i.answer);

  onUtterance.current = (text: string) => {
    setHeard(text);
    const low = text.toLowerCase().replace(/[.!?]+$/, "").trim();
    if (/^(stop listening|goodbye|good bye|bye|that'?s all|that is all|(turn off|end|exit|close) voice( mode)?)$/.test(low)) { voice.say("Goodbye."); void voice.whenIdle(8000).then(endVoice); return; }
    if (/^(stop talking|be quiet|quiet|silence|shut up|enough)$/.test(low)) { voice.stopSpeaking(); return; }
    if (waiting && pendingApproval) {
      const y = YES.exec(text), n = NO.exec(text);
      if (y) { void answer(pendingApproval.approvalId, true, text.slice(y[0].length).trim() || undefined); voice.say("On it."); }
      else if (n) { void answer(pendingApproval.approvalId, false, text.slice(n[0].length).trim() || undefined); voice.say("Cancelled."); }
      else { void answer(pendingApproval.approvalId, false, text); voice.say("Understood. I'll take that into account."); }
      return;
    }
    if (working) {
      if (/^(stop|cancel|halt|abort|pause|wait|hold on)\b/.test(low)) { stop(); voice.say("Stopping."); return; }
      queuedRef.current = text; setQueued(text);
      voice.say("Noted. I'll do that next.");
      return;
    }
    send(text, [], voiceContext()).catch(() => voice.say("Sorry, I could not send that."));
  };
  // something said while the assistant was busy: send it as soon as it is free
  useEffect(() => {
    if (!voiceOn || working || waiting || !queuedRef.current) return;
    const t = queuedRef.current; queuedRef.current = ""; setQueued("");
    send(t, [], voiceContext()).catch(() => {});
  }, [voiceOn, working, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <small>{looking > 0 ? <><Icon.Eye size={12} /> Looking at the page…</> : working ? <><span className="spin" /> Working…</> : waiting ? "Waiting for your approval" : paused ? "Paused" : site.name}</small>
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
        <button role="tab" aria-selected={tab === "actions"} className={tab === "actions" ? "on" : ""} onClick={() => setTab("actions")}><Icon.Cursor size={15} /> Edit{selected && <span className="qa-dot" />}</button>
        <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}><Icon.List size={15} /> Changes</button>
      </nav>

      {problem && <div className="banner error w-banner"><span>{problem}</span><button onClick={() => setProblem("")}><Icon.Close size={13} /></button></div>}

      <div className="w-body">
        {tab === "chat" && (
          <div className="w-chat">
            <Transcript items={timeline} model={name} busy={answering} working={working} welcome={welcome}
              onAnswer={(a, ok, r) => void answer(a, ok, r)} onCopy={(t) => { navigator.clipboard?.writeText(t); say("Copied"); }}
              onEdit={() => {}} onRetry={(t) => { if (t && (status === "completed" || status === "failed")) void send(t, []); }}
              onOpen={(url) => post({ type: "lc:navigate", url })} />
            {voiceOn && (
              <VoiceBar agent={voice} state={voiceState} heard={heard} busy={working} waiting={waiting} queued={queued} blocked={blocked}
                voices={voiceList} voice={voiceName && voiceList.includes(voiceName) ? voiceName : voice.voice} speak={speakOn}
                onVoice={(v) => { voice.voice = v; setVoiceName(v); store.set("lcw_voice_name", v); voice.say("This is how I sound now."); }}
                onSpeak={(on) => { voice.speakReplies = on; if (!on) voice.stopSpeaking(); setSpeakOn(on); store.set("lcw_voice_speak", on ? "1" : "0"); }}
                onEnd={endVoice} />
            )}
            <Composer compact disabled={working || waiting} model={name} context={{}}
              onStop={working && jobId ? stop : undefined} stopping={stopping}
              notice={paused ? <PausedBar kind={pauseKind} onKind={setPauseKind} onContinue={() => void cont()} /> : undefined}
              placeholder={voiceOn && !waiting && !working ? "Voice mode is on - just talk, or type here…" : waiting ? "Answer the approval above…" : working ? (stopping ? "Stopping…" : "Working… (Stop to pause)") : paused ? (pauseKind === "edit" ? "Type your corrected request…" : "Type a note…") : "Ask for any change on this page…"}
              voice={<button className={`mode mic ${voiceOn ? "on" : ""}`} aria-pressed={voiceOn} onClick={() => (voiceOn ? endVoice() : void startVoice())}
                title={voiceOn ? "End voice mode" : "Voice mode: just talk - no need to press Enter. Answers are read aloud."}><Icon.Mic size={17} /></button>}
              attachNote={cfg.canUpload ? <label className="att-save"><input type="checkbox" checked={saveToLibrary} onChange={(e) => { setSaveToLibrary(e.target.checked); store.set("lcw_save_media", e.target.checked ? "1" : "0"); }} /> Also save to the Media Library</label> : undefined}
              onClearContext={() => {}} onSend={sendFromComposer}
              chips={selected ? <span className="chip"><Icon.Cursor size={12} /> {selected.label}<button aria-label="forget selection" onClick={() => setSelected(null)}><Icon.Close size={11} /></button></span> : undefined}
              extra={<ApprovalModePicker mode={mode} onChange={(m) => void changeMode(m)} />} />
          </div>
        )}
        {tab === "actions" && (
          <div className="w-scroll">
            <ElementPanel selected={selected} resolved={resolved} resolving={resolving} error={resolveError} picking={picking} disabled={working || waiting} canUpload={!!cfg.canUpload}
              onPick={() => { setPicking(true); post({ type: "lc:pick" }); }} onCancelPick={() => { setPicking(false); post({ type: "lc:cancel-pick" }); }}
              onApplied={applied} onHighlight={(selector) => post({ type: "lc:highlight", selector })}
              onAsk={(q) => void send(q, [], selected ? `The person picked this element on the page:\n${elementContext(selected, resolved?.source)}` : undefined)}
              onEditOnPage={(selector, apply) => { editApply.current = apply; post({ type: "lc:edit-text", selector }); }} />
          </div>
        )}
        {tab === "changes" && (
          <div className="w-scroll pad">
            <SiteChanges postId={Number(cfg.postId) || 0} reloadKey={historyKey} canDeploy={!!cfg.canDeploy} onChanged={(m) => { say(m); post({ type: "lc:drafts-changed" }); if (autoRefresh) setTimeout(() => post({ type: "lc:reload", tab }), 600); }} />
          </div>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
