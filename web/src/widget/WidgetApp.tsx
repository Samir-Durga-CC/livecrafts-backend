import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InterruptedBar, PausedBar, type PauseKind } from "../components/PausedBar";
import { answerEyes, api, buildTimeline, fileUrl, followEyes, followJob, lastStatus, setWidgetToken } from "../api";
import { Composer } from "../components/Composer";
import { BlogDialog } from "../components/BlogDialog";
import { Transcript } from "../components/Messages";
import { ApprovalModePicker } from "../components/RequestChanges";
import { ModelPicker } from "../components/ModelPicker";
import { Icon } from "../icons";
import type { ApprovalMode, AssistantInfo, JobEvent, JobSummary, Resolved, Site, TimelineItem, UploadedFile } from "../types";
import { titleOf, writeCount } from "../util";
import { elementContext, type PickedElement } from "./element";
import { ElementPanel } from "./ElementPanel";
import { SiteChanges } from "./SiteChanges";
import { BlogPanel, MoreMenu } from "./MorePanel";
import { SpeedPanel } from "./SpeedPanel";
import { PluginsPanel } from "./PluginsPanel";
import { connectParent, uploadToMedia } from "./parent";
import { VoiceAgent, type VoiceState } from "./voice";
import { VoiceBar } from "./VoiceBar";
import { VoiceStrip } from "./VoiceStrip";
import { VoiceButton } from "./VoiceButton";
import { VoiceWave } from "./VoiceWave";
import { Dictation, type DictateState } from "./dictation";
import { RealtimeVoice, type RealtimeState } from "./realtime";
import { voiceLog } from "./voicelog";

/** Told to the assistant with every spoken request. */
const VOICE_NOTE = "VOICE MODE: the person is talking to you and hears your replies read aloud. Answer in one to three short, natural spoken sentences - no tables, code, URLs or long lists. Say what you did or found; the details stay visible in the chat. " +
  "If you need something from them, use ask_person - the questions are read out and they answer by speaking. Never ask in prose, and never ask about design: decide it. " +
  "They cannot see the screen while you work, so make the first sentence the result (\"The testimonials section is on the page\"), not a preamble.";
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|approve|approved|confirm|confirmed|proceed|sounds good|perfect|please do|of course|absolutely|correct)\b[\s,.!]*/i;
const NO = /^(no|nope|nah|don'?t|do not|cancel|deny|reject|not now)\b[\s,.!]*/i;

/** What the voice reads out of the chat: finished answers, approval questions, errors. */
const sayableOf = (items: TimelineItem[]) => items.filter((i) =>
  (i.kind === "assistant" && !i.streaming && i.text.trim() !== "")
  || i.kind === "approval"
  || i.kind === "error"
  // The questions the assistant asked in the form: in voice mode they are read out and answered by speaking.
  || (i.kind === "tool" && i.tool === "ask_person" && i.state === "ok")
  // While it works, say what each change was - otherwise a long build is minutes of silence.
  );

/** Tools worth showing as a step on the voice stage (the rest are lookups nobody needs to watch). */
const WORTH = new Set(["place_component", "create_page", "make_change", "revert_change", "screenshot_page", "analyze_design", "ask_person"]);
const describeWorth = (i: TimelineItem) => i.kind === "tool" && WORTH.has(i.tool);

/**
 * What it is DOING, said as it starts - never what it has done.
 *
 * Announcing a finished step ("Added the testimonials section") arrives before the page can show it, so the voice is
 * ahead of what the person sees and sounds like it is making things up. Saying "I'm adding it now" is true the
 * moment it is said, and the finished answer reports the result once.
 */
function spokenDoing(i: Extract<TimelineItem, { kind: "tool" }>): string {
  const name = String((i.input as any)?.id ?? "").replace(/_/g, " ");
  switch (i.tool) {
    case "get_page_map": case "read_post": case "read_page": case "read_target": case "find_text": return "Reading the page.";
    case "analyze_design": case "site_profile": return "Looking at how your site is designed.";
    case "find_components": case "get_component": return "Finding the right section for this.";
    case "place_component": return name ? `Adding the ${name} section now.` : "Adding the section now.";
    case "create_page": return "Creating the page.";
    case "make_change": return "Making the change.";
    case "revert_change": return "Undoing that.";
    case "screenshot_page": case "inspect_element": return "Checking how it looks.";
    case "upload_media_from_chat": case "upload_media_from_url": return "Adding the image to your library.";
    case "site_status": case "site_history": return "Checking what is on the page already.";
    default: return "";
  }
}

function sayText(i: TimelineItem): string {
  if (i.kind === "assistant") return i.text;
  if (i.kind === "error") return `Sorry, that did not work. ${i.text}`;
  if (i.kind === "approval") return i.tool === "propose_plan" && i.input?.summary ? `Here is my plan: ${i.input.summary}. Shall I go ahead?` : "This needs your OK before I change the site. Shall I go ahead?";
  if (i.kind === "tool" && i.tool === "ask_person") {
    const qs: any[] = i.input?.questions ?? [];
    const intro = String(i.input?.intro ?? "").trim();
    const asked = qs.map((q, n) => `${qs.length > 1 ? `${n + 1}. ` : ""}${q.question}${q.options?.length ? ` ${q.options.join(", or ")}?` : ""}`).join(" ");
    return `${intro ? intro + " " : ""}${asked} You can just tell me, or say "you decide".`;
  }

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
type Tab = "chat" | "actions" | "blog" | "speed" | "plugins" | "changes" | "more";

function readConfig(): WidgetConfig | null {
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get("cfg");
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c.siteUrl || !c.parentOrigin) return null;
    setWidgetToken(c.widgetToken || "open"); // no sign-in: without a token the chat simply works unnamed
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
  // After a reload on More, open the feature that was open there (blog post, PageSpeed, plugins), not the menu again.
  const [tab, setTabState] = useState<Tab>(() => {
    const t = cfg.tab ?? "chat";
    const v = store.sget("lcw_moreview");
    return t === "more" && (v === "blog" || v === "speed" || v === "plugins") ? v : t;
  });
  // The Speed tab stays mounted once opened, so a report (or a running scan) survives switching tabs.
  const [speedSeen, setSpeedSeen] = useState(tab === "speed");
  // Inside More: was the PageSpeed report open? Then More opens it again (also after a page reload).
  // Inside More: which screen was open (the menu, or one feature). More opens it again, also after a page reload.
  type MoreView = "menu" | "blog" | "speed" | "plugins";
  const isMoreView = (t: string): t is Exclude<MoreView, "menu"> => t === "blog" || t === "speed" || t === "plugins";
  const [moreView, setMoreViewState] = useState<MoreView>(() => isMoreView(tab) ? tab : ((store.sget("lcw_moreview") as MoreView) || "menu"));
  const setMoreView = (v: MoreView) => { setMoreViewState(v); store.sset("lcw_moreview", v); };
  useEffect(() => { if (tab === "speed") setSpeedSeen(true); if (isMoreView(tab)) setMoreView(tab); else if (tab === "more") setMoreView("menu"); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const backToMenu = () => { setMoreView("menu"); setTab("more"); };
  const [mode, setMode] = useState<ApprovalMode>((store.get("lcw_mode") as ApprovalMode) || cfg.approvalMode || "request");
  // Which model answers this chat: "" = the one WordPress / the backend chose. Remembered in this browser.
  const [pick, setPick] = useState<string>(store.get("lcw_model") ?? "");
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
  /** How much of the answer being streamed has already been read out, so it is never said twice. */
  const partial = useRef<{ seq: number; chars: number }>({ seq: -1, chars: 0 });
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
  /**
   * Two ways to use the microphone:
   *   dictate - it only writes what you say into the box; you read it and press send
   *   agent   - a conversation: it answers out loud and does the work
   * Both put what was heard straight into the chat; neither takes the screen over.
   */
  const [voiceMode, setVoiceMode] = useState<"dictate" | "agent">((store.get("lcw_voice_mode") as any) === "dictate" ? "dictate" : "agent");
  const dictated = useRef("");
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>();
  /**
   * The box fills as you speak - about ten times a second, not on every delta.
   *
   * The speech service sends words in small pieces, and each one used to set state, which re-renders the whole
   * widget: transcript, composer, every button. During a sentence that is a steady stream of re-renders, and a
   * button that is re-rendered between the press and the release never reports the click - which is exactly the
   * "sometimes a click does nothing while voice is on" people see.
   *
   * Ten a second is faster than anyone reads, so the box looks no different; a finished sentence is passed with
   * `now` so nothing waits on the timer.
   */
  const draftTick = useRef<{ timer: number; text: string } | null>(null);
  const showDraft = (text: string, now = false) => {
    const pending = draftTick.current;
    if (now || !pending) {
      if (pending) { window.clearTimeout(pending.timer); draftTick.current = null; }
      setDraft({ text, n: Date.now() });
      if (now) return;
      draftTick.current = { text, timer: window.setTimeout(() => {
        const held = draftTick.current;
        draftTick.current = null;
        if (held && held.text !== text) setDraft({ text: held.text, n: Date.now() });
      }, 100) };
      return;
    }
    pending.text = text; // inside the window: remembered, and shown when it closes
  };
  useEffect(() => () => { if (draftTick.current) window.clearTimeout(draftTick.current.timer); }, []);
  // Voice mode shows its own surface; "show the chat" flips back to the transcript without ending voice.
  const [saying, setSaying] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("off");
  const [heard, setHeard] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [queued, setQueued] = useState("");
  const queuedRef = useRef("");
  const [voiceList, setVoiceList] = useState<string[]>([]);
  const [voiceName, setVoiceName] = useState(store.get("lcw_voice_name") ?? "");
  const [speakOn, setSpeakOn] = useState(store.get("lcw_voice_speak") !== "0");
  const [voiceRate, setVoiceRate] = useState(Number(store.get("lcw_voice_rate") ?? 1.15) || 1.15);
  const onUtterance = useRef<(text: string) => void>(() => {});
  // Realtime voice: the server does the listening and the turn-taking. The old engine stays as the fallback, and the
  // person can force it (Settings) if realtime is unavailable or misbehaving on their machine.
  /**
   * Which engine answers in voice mode.
   *
   *   stream    dictation's own streaming transcription, sent to the agent the moment a sentence ends, and the
   *             answer streamed back and spoken as it is written. The default: it is the only one of the three
   *             whose transcription is the one measured to work.
   *   realtime  speech to speech over WebRTC - the model holds the conversation itself
   *   classic   the old recorder: record, upload, wait
   */
  const [engine, setEngine] = useState<"realtime" | "classic" | "stream">(() => {
    const saved = store.get("lcw_voice_engine");
    return saved === "classic" || saved === "realtime" ? saved : "stream";
  });
  const waiting4 = useRef<((result: string) => void) | null>(null);
  const [realtime] = useState(() => new RealtimeVoice({
    onState: (s: RealtimeState) => setVoiceState(s === "thinking" ? "transcribing" : (s as VoiceState)),
    onHeard: (t) => setHeard(t),
    onSaying: (t) => setSaying(t),
    onError: (m) => setProblem(m),
    onBlocked: setBlocked,
    // do_on_site: hand it to the agent that already exists and wait for the result.
    onRequest: (request) => runForVoice(request),
  }));
  /**
   * Dictation that writes while you talk.
   *
   * `said` is the sentences it has finished, `saying` the one in progress. The composer is handed both joined, so
   * the box fills in as the person speaks and keeps filling across sentences until they press Stop.
   */
  const dictatedText = useRef("");
  const [dictateOn, setDictateOn] = useState(false);
  /**
   * Dictating, or talking to the agent?
   *
   * The same microphone and the same transcription serve both; only what happens at the end of a sentence
   * differs. Dictation leaves it in the box for the person to read and send. The agent sends it itself, because
   * waiting for a button is the thing that stops it being a conversation. Read through a ref: these handlers are
   * built once, and the mode changes under them.
   */
  const talkingToAgent = useRef(false);
  const [dictation] = useState(() => new Dictation({
    onState: (s: DictateState) => setVoiceState(s === "transcribing" ? "transcribing" : (s as VoiceState)),
    // The words appear in the box either way, as they are said - that is the whole point of streaming them.
    onPartial: (text) => showDraft([dictatedText.current, text].filter(Boolean).join(" ")),
    onFinal: (text) => {
      setHeard(text);
      if (talkingToAgent.current) {
        // The sentence is finished: hand it straight over. onUtterance decides what it means - an answer to a
        // question, a "stop", or a new request that replaces whatever is running.
        dictatedText.current = "";
        showDraft("", true);
        onUtterance.current(text);
        return;
      }
      dictatedText.current = [dictatedText.current, text].filter(Boolean).join(" ");
      showDraft(dictatedText.current, true);
    },
    onError: (m) => setProblem(m),
  }));
  /**
   * How far the voice has got through the answer on screen: everything before `to` has been heard.
   *
   * It follows the AUDIO, reported by the player as each sentence starts, not the text as it streams in - the
   * text runs sentences ahead of the voice, and a highlight that runs ahead of what you are hearing reads as the
   * wrong message being highlighted.
   */
  const [readAloud, setReadAloud] = useState<{ seq: number; to: number } | null>(null);
  const readSeq = useRef(-1);
  const [voice] = useState(() => new VoiceAgent({
    onState: setVoiceState, onUtterance: (t) => onUtterance.current(t), onError: (m) => setProblem(m), onBlocked: setBlocked,
    /**
     * The highlight sits where the voice is: across this sentence's span, by how far through its clip it is.
     *
     * Only when it has actually moved a few characters. Every one of these re-renders the whole widget - the
     * transcript, the composer, the buttons - and a re-render between pressing a button and releasing it is a
     * click that never happens. A character is less than a pixel of travel; six is still smooth.
     */
    onSpeaking: (part, progress) => setReadAloud((prev) => {
      if (readSeq.current < 0) return null;
      const to = Math.round(part.from + (part.to - part.from) * progress);
      if (prev && prev.seq === readSeq.current && Math.abs(to - prev.to) < 6 && progress > 0 && progress < 1) return prev;
      return { seq: readSeq.current, to };
    }),
  }));
  useEffect(() => () => voice.stop(), [voice]);
  useEffect(() => { voice.rate = voiceRate; }, [voice, voiceRate]);
  // While it is waiting for a yes, a no, or an answer to the form, let a short word cut straight in.
  useEffect(() => {
    const open = timeline.some((i) => i.kind === "tool" && i.tool === "ask_person" && i.state === "ok")
      && timeline[timeline.length - 1]?.kind !== "user";
    voice.expectingShortAnswer = waiting || open;
  }, [voice, waiting, timeline]);
  const sayable = useMemo(() => sayableOf(timeline), [timeline]);

  // read out what is new in the chat (declared before the reload below: the answer is spoken before the page reloads)
  useEffect(() => {
    const s = spoken.current;
    if (!s || s.job !== jobId || sayable.length < s.count) return;
    if (voiceOn && engine === "classic") for (let k = s.count; k < sayable.length; k++) {
      const item = sayable[k];
      let line = sayText(item);
      // The start of this answer may already have been read out while it was still streaming.
      if (item.kind === "assistant" && partial.current.seq === item.seq) {
        line = line.slice(partial.current.chars);
        partial.current = { seq: -1, chars: 0 };
      }
      if (line.trim()) { setSaying(line); voice.say(line); }
    }
    s.count = sayable.length;
  }, [sayable, jobId, voiceOn, voice, spokenReady]);

  // show the result: reload the page once the assistant has finished a step that changed the site
  // The page used to catch up only once the whole request had finished, so a build that places six sections showed
  // nothing for minutes while the voice said each one was done. Now it catches up as each change lands (at most
  // every few seconds), and once more when the work stops.
  const refreshedAt = useRef(0);
  useEffect(() => {
    if (!jobId || baseline.current === null || !autoRefresh) return;
    // Only when the work has stopped. Patching the page mid-run meant re-parsing the whole document every few
    // seconds while the browser was already busy, which froze the tab on a builder page. The voice says what is
    // happening; the page catches up once, at the end.
    if (working) return;
    if (writes > baseline.current) {
      refreshedAt.current = Date.now();
      baseline.current = writes;
      setHistoryKey((k) => k + 1);
      store.sset(`lcw_reloaded:${jobId}`, String(writes));
      // Show the change in place: the page is patched where it differs, with no reload, no white flash and no lost
      // scroll position. The widget only falls back to a full reload if the page says it could not do it.
      const refresh = () => post({ type: "lc:soft-refresh", tab, selector: lastSection.current });
      // Patching the page in place does not interrupt anything, so it no longer has to wait for the voice to finish:
      // waiting is what let the narration run ahead of what was on screen.
      refresh();
    }
  }, [writes, working, jobId, autoRefresh, post, tab, voiceOn, voice]);

  // Speak the answer AS IT ARRIVES: every finished sentence goes out while the rest is still being written. Waiting
  // for the whole answer added seconds of silence to every turn, which is most of what makes voice feel slow.
  useEffect(() => {
    // Streaming voice reads the answer aloud the same way; realtime does its own speaking.
    if (!voiceOn || !speakOn || (engine !== "classic" && engine !== "stream")) return;
    const last = timeline[timeline.length - 1];
    if (last?.kind !== "assistant" || !last.streaming) return;
    if (partial.current.seq !== last.seq) partial.current = { seq: last.seq, chars: 0 };
    /**
     * Grey from the FIRST character, not from the first clip of audio.
     *
     * This used to start when the player reported a sentence, which is a second or more after the words are on
     * screen. So an answer appeared in full contrast, turned grey, and only then began filling back in - the
     * wrong way round, and the greying read as something going wrong rather than as text waiting to be read.
     *
     * An answer that is going to be read aloud is text you have not been told yet, from the moment it exists.
     * It arrives grey and fills in as the voice reaches it; nothing ever goes from lit to grey.
     */
    if (readSeq.current !== last.seq) {
      readSeq.current = last.seq;
      setReadAloud({ seq: last.seq, to: 0 });
    }
    // Only up to the last sentence that is definitely complete.
    const done = last.text.search(/[.!?।]\s+[^\s]*$/) >= 0
      ? last.text.slice(0, last.text.lastIndexOf(" ", last.text.length - 1) + 1)
      : (last.text.match(/^[\s\S]*[.!?।]/)?.[0] ?? "");
    if (done.length > partial.current.chars + 15) {
      const chunk = done.slice(partial.current.chars);
      const from = partial.current.chars;
      partial.current = { seq: last.seq, chars: done.length };
      setSaying(chunk);
      voice.say(chunk, { from, to: done.length });
    }
  }, [timeline, voiceOn, speakOn, voice]);

  /**
   * Nothing stays grey that is never going to be read.
   *
   * Grey means "the voice has not reached this yet", so it has to stop meaning anything the moment there is no
   * voice: sound turned off, voice mode ended, or an answer that finished and fell silent without being spoken
   * (a speech request that failed takes its queue with it). Left alone, that message would sit unreadable at
   * half contrast for the rest of the conversation.
   */
  useEffect(() => {
    if (!voiceOn || !speakOn) { setReadAloud(null); readSeq.current = -1; return; }
    if (!readAloud || voiceState === "speaking") return;
    const it = timeline.find((i) => i.kind === "assistant" && i.seq === readAloud.seq);
    if (!it || it.kind !== "assistant" || it.streaming) return;
    // A gap between two sentences also looks like this, so give the next clip time to start.
    const t = window.setTimeout(() => { setReadAloud(null); readSeq.current = -1; }, 2500);
    return () => window.clearTimeout(t);
  }, [voiceOn, speakOn, readAloud, voiceState, timeline]);

  // Narrate the work as it happens: one short line when a step STARTS, never more than one every few seconds, and
  // only while it is actually working. This is what makes it feel like someone doing the job rather than a pause.
  const narrated = useRef<{ seqs: Set<number>; at: number }>({ seqs: new Set(), at: 0 });
  useEffect(() => {
    // Streaming voice reads the answer aloud the same way; realtime does its own speaking.
    if (!voiceOn || !speakOn || (engine !== "classic" && engine !== "stream")) return;
    const now = Date.now();
    for (const it of timeline) {
      if (it.kind !== "tool" || it.state !== "running") continue;
      if (narrated.current.seqs.has(it.seq)) continue;
      narrated.current.seqs.add(it.seq);
      const line = spokenDoing(it);
      // One line at a time: a burst of lookups should not become a burst of sentences.
      if (!line || now - narrated.current.at < 3500) continue;
      narrated.current.at = now;
      setSaying(line);
      voice.say(line);
    }
  }, [timeline, voiceOn, speakOn, voice]);
  useEffect(() => { if (!working) narrated.current = { seqs: new Set(), at: 0 }; }, [working]);

  /** A change made in the click panel (directly in WordPress, no AI): show it - it is a draft only editors see. */
  function applied(summary: string) {
    say(`Saved as a draft: ${summary.length > 60 ? summary.slice(0, 59) + "…" : summary}`);
    setHistoryKey((k) => k + 1);
    post({ type: "lc:drafts-changed" });
    if (autoRefresh) setTimeout(() => post({ type: "lc:soft-refresh", tab }), 400);
  }
  // ---- eyes: answer "look at the page" requests from the assistant with THIS browser (plugin 0.9.2+ on the page)
  // The selector of the section the assistant last placed or changed: the soft refresh scrolls there and outlines it.
  const lastSection = useRef<string | undefined>(undefined);
  useEffect(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const it: any = timeline[i];
      const sel = it?.kind === "tool" ? (it.ui?.selector ?? it.ui?.usedTemplate?.selector) : undefined;
      if (typeof sel === "string" && sel) { lastSection.current = sel; return; }
    }
  }, [timeline]);

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

  /** `spoken`: the request was said out loud. The backend then runs it as a voice job (faster model, low effort). */
  /** Read at send time, not from state: "Don't ask me again" sends its message in the same tick it is written. */
  const layoutPickerOn = () => localStorage.getItem("lc_layout_picker") !== "off";
  const neverAskLayout = () => localStorage.setItem("lc_layout_picker", "off");

  async function send(prompt: string, fileIds: string[], extraContext?: string, spoken = false): Promise<string> {
    setProblem("");
    try {
      // They have answered (typed, spoken, or filled the form): stop reading out whatever was still queued, or the
      // assistant carries on describing a question that is already answered.
      if (voiceOn) { voice.stopSpeaking(); setSaying(""); setReadAloud(null); readSeq.current = -1; partial.current = { seq: -1, chars: 0 }; }
      const args = { prompt, fileIds, pageUrl: cfg.pageUrl, approvalMode: mode, extraContext, ...(spoken ? { voice: true } : {}),
        ...(layoutPickerOn() ? {} : { layoutPicker: false }), ...(pick ? { model: pick } : {}) };
      let id = jobId;
      if (jobId && paused) await api.message(jobId, { ...args, kind: pauseKind });
      else if (jobId && (status === "completed" || status === "failed")) await api.message(jobId, args);
      else { const j = await api.createJob(site.id, args); freshJob.current = j.id; setJobId(j.id); id = j.id; }
      setTab("chat");
      refreshJobs();
      return id;
    } catch (e) { setProblem((e as Error).message); throw e; }
  }


  /** A blog post always starts its own chat. */
  const [blogOpen, setBlogOpen] = useState<false | { title: string }>(false);
  async function startBlog(prompt: string, fileIds: string[]) {
    if (working) throw new Error("The assistant is still working on another request. Wait for it to finish (or stop it in Chat), then write the post.");
    setProblem("");
    try { const j = await api.createJob(site.id, { prompt, fileIds, approvalMode: mode }); freshJob.current = j.id; setJobId(j.id); setTab("chat"); refreshJobs(); }
    catch (e) { setProblem((e as Error).message); throw e; }
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
    await send(prompt, fileIds, extra.filter(Boolean).join("\n\n") || undefined);
  }

  // ---- voice: start / end, and what a spoken sentence means right now
  /** One spoken request, run through the real agent; resolves with one line the voice can read out. */
  function runForVoice(request: string): Promise<string> {
    if (!request.trim()) return Promise.resolve("I did not catch what to do.");
    return new Promise<string>((resolve) => {
      waiting4.current = resolve;
      void send(request, [], voiceContext(), true).catch((e) => {
        waiting4.current = null;
        resolve(`That could not be sent: ${(e as Error).message}`);
      });
    });
  }
  // The job finished (or stopped for approval): give the voice its one line back.
  useEffect(() => {
    const done = waiting4.current;
    if (!done || working) return;
    if (waiting) { waiting4.current = null; done("It needs your approval on screen before I can carry on."); return; }
    const last = [...timeline].reverse().find((i): i is Extract<TimelineItem, { kind: "assistant" }> => i.kind === "assistant" && !i.streaming && i.text.trim() !== "");
    const failed = [...timeline].reverse().find((i): i is Extract<TimelineItem, { kind: "error" }> => i.kind === "error");
    waiting4.current = null;
    done(last ? last.text.slice(0, 600) : failed ? `It failed: ${failed.text.slice(0, 200)}` : "Done.");
  }, [working, waiting, timeline]);

  async function startVoice(resume = false, mode: "dictate" | "agent" = voiceMode) {
    setProblem("");
    setVoiceMode(mode);
    store.set("lcw_voice_mode", mode);
    dictated.current = "";
    /**
     * Decided here, once, for both modes - never left over from the last one.
     *
     * Dictation must NEVER send on its own: it types into the box and the person presses send, which is the
     * whole difference between the two. Switching straight from the agent to dictation (the buttons sit next to
     * each other, and neither stops the other first) used to leave this set, and dictation would quietly start
     * sending what it heard.
     */
    talkingToAgent.current = mode === "agent";
    // The two modes listen with different settings (how long a pause ends a sentence), and start() does nothing
    // if it is already running - so a switch has to close the old session or it keeps the old one's timing.
    if (voiceOn && voiceMode !== mode) { dictation.stop(); realtime.stop(); voice.stop(); }
    // Dictation never uses the realtime conversation: it only needs the words, and nothing should answer back.
    if (mode === "dictate") {
      const info = await api.voiceInfo({ siteId: site.id, pageUrl: cfg.pageUrl }).catch(() => ({ available: false, voice: "onyx", voices: [] as string[] }));
      // Streaming: the words arrive while they talk. Only if the backend cannot do it do we record-and-upload,
      // and then we say so - falling back quietly is how someone concludes the new thing never worked.
      if ((info as any).stream?.available) {
        dictatedText.current = "";
        if (await dictation.start({ siteId: site.id, pageUrl: cfg.pageUrl })) {
          setDictateOn(true); setVoiceOn(true); setHeard(""); store.sset("lcw_voice", "1");
          return;
        }
        setProblem("Dictation could not stream; using the older recorder.");
      }
      voiceLog.start("classic", (info as any).sttModel ?? "");
      voice.speakReplies = false;
      if (!(await voice.start(info.available))) { store.sset("lcw_voice", "0"); return; }
      setVoiceOn(true); setHeard(""); store.sset("lcw_voice", "1");
      return;
    }
    /**
     * Streaming voice: dictation's microphone, the agent's answer.
     *
     * The words appear in the box as they are said, the finished sentence goes to the agent without a button,
     * and the answer is streamed back - spoken sentence by sentence while the rest is still being written, so
     * nobody waits for a whole reply to be generated before hearing any of it.
     */
    if (engine === "stream") {
      talkingToAgent.current = true;
      dictatedText.current = "";
      // forAgent: close the sentence on a short pause. Here the pause is time the agent is NOT yet working.
      if (!(await dictation.start({ siteId: site.id, pageUrl: cfg.pageUrl, forAgent: true }))) {
        talkingToAgent.current = false;
        store.sset("lcw_voice", "0");
        return;
      }
      // The answers are read aloud by the old engine, used as a speaker only - the microphone stays with dictation.
      voice.voice = voiceName || voice.voice;
      voice.speakReplies = speakOn;
      if (speakOn) await voice.startSpeaker();
      setDictateOn(true); setVoiceOn(true); setHeard(""); store.sset("lcw_voice", "1");
      return;
    }
    if (engine === "realtime") {
      const info = await api.voiceInfo({ siteId: site.id, pageUrl: cfg.pageUrl }).catch(() => null as any);
      if (info?.realtime?.available) {
        const ok = await realtime.start({ siteId: site.id, botName: name, pageUrl: cfg.pageUrl });
        if (!ok) { store.sset("lcw_voice", "0"); return; }
        setVoiceOn(true); setHeard(""); store.sset("lcw_voice", "1");
        return;
      }
      // Falling back silently is how someone ends up testing the old engine and thinking realtime is broken.
      setEngine("classic");
      setProblem("Realtime voice is not available on this backend (restart it, or add an OpenAI key). Using the older voice mode.");
    }
    const info = await api.voiceInfo({ siteId: site.id, pageUrl: cfg.pageUrl }).catch(() => ({ available: false, voice: "onyx", voices: [] as string[] }));
    setVoiceList(info.available ? info.voices : []);
    voice.voice = voiceName && info.voices.includes(voiceName) ? voiceName : info.voice;
    voice.speakReplies = speakOn;
    voiceLog.start("classic", (info as any).sttModel ?? "");
    if (!(await voice.start(info.available))) { store.sset("lcw_voice", "0"); return; }
    setVoiceOn(true); setHeard(""); store.sset("lcw_voice", "1");
    if (!resume) voice.say("I'm listening. What would you like to change?");
  }
  function endVoice() {
    realtime.stop();
    voice.stop();
    dictation.stop();
    talkingToAgent.current = false;
    setReadAloud(null);
    readSeq.current = -1;
    setDictateOn(false);
    setVoiceOn(false); setHeard(""); setQueued(""); queuedRef.current = "";
    store.sset("lcw_voice", "0");
  }
  /**
   * What the button is doing right now: "" idle, "warming" opening, "rec" live and meaning Stop.
   *
   * The beep and the colour say the same thing, because a button that looks live before the session is ready is
   * the reason people spoke into a microphone that was not listening yet.
   */
  function micPhase(m: "dictate" | "agent"): "" | "warming" | "rec" {
    if (!voiceOn || voiceMode !== m) return "";
    return voiceState === "starting" ? "warming" : "rec";
  }
  useEffect(() => { if (store.sget("lcw_voice") === "1") void startVoice(true, voiceMode); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const voiceContext = () => [selectionContext(), VOICE_NOTE].filter(Boolean).join("\n\n");
  const pendingApproval = [...timeline].reverse().find((i): i is Extract<TimelineItem, { kind: "approval" }> => i.kind === "approval" && !i.answer);

  onUtterance.current = (text: string) => {
    setHeard(text);
    if (voiceMode === "dictate") {
      // Straight into the box. Nothing is sent until the person presses send, so a misheard word can be fixed.
      dictated.current = [dictated.current, text].filter(Boolean).join(" ");
      setDraft({ text: dictated.current, n: Date.now() });
      return;
    }
    const low = text.toLowerCase().replace(/[.!?]+$/, "").trim();
    if (/^(stop listening|goodbye|good bye|bye|that'?s all|that is all|(turn off|end|exit|close) voice( mode)?)$/.test(low)) { voice.say("Goodbye."); void voice.whenIdle(8000).then(endVoice); return; }
    if (/^(stop talking|be quiet|quiet|silence|shut up|enough)$/.test(low)) { voice.stopSpeaking(); return; }
    if (/^(you decide|your (choice|call)|whatever you think|up to you|anything|surprise me)/.test(low) && !working) {
      void send("You decide - pick what suits the site and carry on.", [], voiceContext(), true).catch(() => {});
      return;
    }
    if (waiting && pendingApproval) {
      const y = YES.exec(text), n = NO.exec(text);
      if (y) { void answer(pendingApproval.approvalId, true, text.slice(y[0].length).trim() || undefined); voice.say("On it."); }
      else if (n) { void answer(pendingApproval.approvalId, false, text.slice(n[0].length).trim() || undefined); voice.say("Cancelled."); }
      else { void answer(pendingApproval.approvalId, false, text); voice.say("Understood. I'll take that into account."); }
      return;
    }
    if (working) {
      if (/^(stop|cancel|halt|abort|pause|wait|hold on)\b/.test(low)) { stop(); voice.say("Stopping."); return; }
      /**
       * Speaking over the answer REPLACES it.
       *
       * Queueing was the old behaviour: "Noted, I'll do that next", and the thing you had just corrected ran
       * anyway, followed by the correction. In a conversation, interrupting means the previous thing is off -
       * so the running turn is stopped and the new sentence takes its place.
       */
      if (talkingToAgent.current) {
        /**
         * Stop what is running, then say the new thing INTO THE SAME CONVERSATION.
         *
         * stop() only asks: it sets a flag and the run ends at its next safe point, so for a moment afterwards
         * the job is still running. Sending in that moment is refused by the backend as "wait for it to finish"
         * (jobs.ts continue()), and the widget's send() answers a refusal-shaped situation by starting a NEW
         * job - which silently loses the conversation this correction belongs to. So it is queued, and the
         * effect below sends it the moment the job is actually free, into the chat it came from.
         */
        voice.stopSpeaking();
        setSaying("");
        setReadAloud(null);
        readSeq.current = -1;
        partial.current = { seq: -1, chars: 0 };
        queuedRef.current = text;
        setQueued(text);
        stop();
        return;
      }
      queuedRef.current = text; setQueued(text);
      voice.say("Noted. I'll do that next.");
      return;
    }
    send(text, [], voiceContext(), true).catch(() => voice.say("Sorry, I could not send that."));
  };
  // something said while the assistant was busy: send it as soon as it is free
  useEffect(() => {
    if (!voiceOn || working || waiting || !queuedRef.current) return;
    const t = queuedRef.current; queuedRef.current = ""; setQueued("");
    send(t, [], voiceContext(), true).catch(() => {});
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
        <button role="tab" aria-selected={tab === "more" || isMoreView(tab)} className={tab === "more" || isMoreView(tab) ? "on" : ""} onClick={() => setTab(isMoreView(tab) ? "more" : moreView === "menu" ? "more" : moreView)}><Icon.More size={15} /> More</button>
      </nav>

      {problem && <div className="banner error w-banner"><span>{problem}</span><button onClick={() => setProblem("")}><Icon.Close size={13} /></button></div>}

      <div className="w-body">
        {tab === "chat" && (
          <div className="w-chat">
            <Transcript items={timeline} model={name} busy={answering} working={working} welcome={welcome} spoken={readAloud}
              siteId={site.id} onNeverAskLayout={neverAskLayout}
              onAsk={(t) => void send(t, [])}
              onAskTouch={() => { if (voiceOn) { voice.stopSpeaking(); setSaying(""); } }}
              onAnswer={(a, ok, r) => void answer(a, ok, r)} onCopy={(t) => { navigator.clipboard?.writeText(t); say("Copied"); }}
              onEdit={() => {}} onRetry={(t) => { if (t && (status === "completed" || status === "failed")) void send(t, []); }}
              onOpen={(url) => post({ type: "lc:navigate", url })} onDeploy={cfg.canDeploy ? () => post({ type: "lc:deploy" }) : undefined} />
            {voiceOn && voiceMode === "agent" && (
              <VoiceBar agent={voice} state={voiceState} heard={heard} busy={working} waiting={waiting} queued={queued} blocked={blocked}
                voices={voiceList} voice={voiceName && voiceList.includes(voiceName) ? voiceName : voice.voice} speak={speakOn}
                onVoice={(v) => { voice.voice = v; setVoiceName(v); store.set("lcw_voice_name", v); voice.say("This is how I sound now."); }}
                onSpeak={(on) => { voice.speakReplies = on; if (!on) voice.stopSpeaking(); setSpeakOn(on); store.set("lcw_voice_speak", on ? "1" : "0"); }}
                onEnd={endVoice} />
            )}
            {/**
              * No strip in streaming voice.
              *
              * It carried "Listening…" and the last thing heard - both of which are now where they belong: the
              * button is red and says Stop, the waveform sits in the input box, and the words appear in the box
              * as they are spoken. A second panel repeating that is a row of chrome between the person and the
              * thing they are reading, on a widget that is already narrow.
              */}
            {voiceOn && engine !== "stream" && (
              <VoiceStrip mode={voiceMode} state={voiceState} heard={heard} busy={working} blocked={blocked} speak={speakOn}
                onSpeak={(on) => { setSpeakOn(on); voice.speakReplies = on; store.set("lcw_voice_speak", on ? "1" : "0"); if (!on) { voice.stopSpeaking(); realtime.stopSpeaking(); } }}
                onUnblock={() => (engine === "realtime" && voiceMode === "agent" ? realtime.unblock() : voice.unblock())}
                onDiagnostics={() => { voiceLog.download(); say("Voice log saved to your downloads"); }}
                onEnd={endVoice} />
            )}
            <Composer compact disabled={working || waiting} model={name} context={{}}
              onStop={working && jobId ? stop : undefined} stopping={stopping}
              notice={paused ? <PausedBar kind={pauseKind} onKind={setPauseKind} onContinue={() => void cont()} /> : status === "interrupted" || status === "failed" ? <InterruptedBar failed={status === "failed"} error={String([...events].reverse().find((e) => e.type === "status")?.data.error ?? "")} onContinue={() => void cont()} /> : undefined}
              placeholder={voiceOn && !waiting && !working ? "Voice mode is on - just talk, or type here…" : waiting ? "Answer the approval above…" : working ? (stopping ? "Stopping…" : "Working… (Stop to pause)") : paused ? (pauseKind === "edit" ? "Type your corrected request…" : "Type a note…") : "Ask for any change on this page…"}
              draft={draft}
              wave={voiceOn && (voiceMode === "dictate" || engine === "stream") ? <VoiceWave agent={dictateOn ? dictation : voice} state={voiceState} /> : undefined}
              voice={<VoiceButton mode={voiceMode} phase={micPhase(voiceMode)} on={voiceOn}
                onStart={(m) => void startVoice(false, m)} onEnd={endVoice} />}
              attachNote={cfg.canUpload ? <label className="att-save"><input type="checkbox" checked={saveToLibrary} onChange={(e) => { setSaveToLibrary(e.target.checked); store.set("lcw_save_media", e.target.checked ? "1" : "0"); }} /> Also save to the Media Library</label> : undefined}
              onClearContext={() => {}} onSend={sendFromComposer}
              chips={selected ? <span className="chip"><Icon.Cursor size={12} /> {selected.label}<button aria-label="forget selection" onClick={() => setSelected(null)}><Icon.Close size={11} /></button></span> : undefined}
              extra={<><ApprovalModePicker mode={mode} onChange={(m) => void changeMode(m)} /><ModelPicker value={pick} fallback={info.model} onChange={(id) => { setPick(id); store.set("lcw_model", id || null); }} /></>} />
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
        {tab === "more" && (
          <div className="w-scroll pad">
            <MoreMenu siteId={site.id} pageUrl={cfg.pageUrl || cfg.siteUrl} onOpen={(v) => setTab(v)} />
          </div>
        )}
        {tab === "blog" && (
          <div className="w-scroll pad">
            <BlogPanel busy={working ? "working" : waiting ? "waiting" : null} onOpenChat={() => setTab("chat")} onBack={backToMenu}
              onBlog={(p) => startBlog(p, [])} onBlogOptions={(title) => setBlogOpen({ title })} />
          </div>
        )}
        {tab === "plugins" && (
          <div className="w-scroll pad">
            <PluginsPanel siteId={site.id} disabled={working} onBack={backToMenu} onChanged={(m) => say(m)} />
          </div>
        )}
        {speedSeen && (
          <div className="w-scroll pad" style={tab === "speed" ? undefined : { display: "none" }}>
            <button type="button" className="sp-back more-back" onClick={backToMenu}><Icon.ChevronRight size={13} /> More</button>
            <SpeedPanel siteId={site.id} pageUrl={cfg.pageUrl || cfg.siteUrl} siteName={site.name} disabled={working} />
          </div>
        )}
        {tab === "changes" && (
          <div className="w-scroll pad">
            <SiteChanges postId={Number(cfg.postId) || 0} reloadKey={historyKey} canDeploy={!!cfg.canDeploy} onChanged={(m) => { say(m); post({ type: "lc:drafts-changed" }); if (autoRefresh) setTimeout(() => post({ type: "lc:reload", tab }), 600); }} />
          </div>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
      {blogOpen && <BlogDialog siteId={site.id} initialTitle={blogOpen.title} onClose={() => setBlogOpen(false)} onSubmit={startBlog} />}
    </div>
  );
}
