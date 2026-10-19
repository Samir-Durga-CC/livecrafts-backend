import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import type { VoiceState } from "./voice";

/** Either engine: the old level-watching one, or the realtime one where the server does the listening. */
export interface StageAgent {
  levelSink: ((level: number) => void) | null;
  level: { db: number; threshold: number; recording: boolean; heardAt: number };
  stopSpeaking: () => void;
  unblock: () => void;
}
import type { TimelineItem } from "../types";

/**
 * Voice mode as a surface of its own, not a strip above a chat box.
 *
 * While the microphone is open this replaces the transcript: one orb that breathes with your voice, what it is doing
 * in plain words, what it heard, what it is saying, and the work ticking past underneath. The chat is one tap away
 * and keeps everything - this is the view for when you are talking, not reading.
 */
const LABEL: Record<VoiceState | "working" | "waiting", { title: string; hint: string }> = {
  off: { title: "Voice is off", hint: "" },
  starting: { title: "Opening the microphone", hint: "Allow the microphone if your browser asks." },
  listening: { title: "I'm listening", hint: "Just say what you want changed." },
  hearing: { title: "Listening…", hint: "Pause when you're done - nothing to press." },
  transcribing: { title: "Got that", hint: "" },
  speaking: { title: "Speaking", hint: "Talk over me to interrupt." },
  working: { title: "Working on it", hint: "Say “stop” to interrupt." },
  waiting: { title: "Need your OK", hint: "Say “yes” to go ahead, or “no”." },
};

export function VoiceStage({ agent, state, heard, saying, steps, busy, waiting, queued, blocked, speak, engine, rate, onRate, onSpeak, onChat, onDiagnostics, onEnd }: {
  agent: StageAgent | null;
  state: VoiceState;
  /** The last thing the person said, and the line being read out now. */
  heard: string;
  saying: string;
  /** The last few things that actually happened, newest last. */
  steps: TimelineItem[];
  busy: boolean; waiting: boolean; queued: string; blocked: boolean;
  speak: boolean;
  /** Which engine is talking: shown so nobody tests the old one and thinks the new one is broken. */
  engine?: "realtime" | "classic";
  /** How fast it talks: 1 is the model's own pace, 1.15 is the default, 1.4 is brisk. */
  rate: number;
  onRate: (r: number) => void;
  onSpeak: (on: boolean) => void;
  onChat: () => void;
  /** Save the session's event log so a voice problem can be looked at instead of described. */
  onDiagnostics?: () => void;
  onEnd: () => void;
}) {
  const orb = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!agent) return;
    agent.levelSink = (l) => orb.current?.style.setProperty("--lvl", l.toFixed(3));
    return () => { agent.levelSink = null; };
  }, [agent]);

  /**
   * When it has been listening for a while and has heard nothing at all, say WHY instead of waiting forever: the
   * level it is getting against the level it needs. That turns "it just sits there" into something to act on -
   * usually the wrong input device, a muted microphone, or a browser that cannot record.
   */
  const [deaf, setDeaf] = useState<null | { db: number; threshold: number; recording: boolean }>(null);
  useEffect(() => {
    if (!agent || state !== "listening") { setDeaf(null); return; }
    const since = Date.now();
    const t = window.setInterval(() => {
      const l = agent.level;
      const quietFor = Date.now() - Math.max(l.heardAt, since);
      setDeaf(quietFor > 7000 && l.db < l.threshold ? { db: l.db, threshold: l.threshold, recording: l.recording } : null);
    }, 1000);
    return () => window.clearInterval(t);
  }, [agent, state]);

  const phase = waiting ? "waiting" : busy && state !== "speaking" && state !== "hearing" ? "working" : state;
  const { title, hint } = LABEL[phase as keyof typeof LABEL] ?? LABEL.listening;

  return (
    <div className={`vstage vs-${phase}`} role="status" aria-live="polite">
      <div className="vs-top">
        <button className="w-icon" onClick={onChat} title="Show the chat"><Icon.Chat size={16} /></button>
        {engine && <span className={`vs-engine ${engine}`} title={engine === "realtime" ? "The voice service listens and takes turns; interrupt any time" : "Older voice mode: records, transcribes, then answers"}>{engine === "realtime" ? "live" : "basic"}</span>}
        <span className="grow" />
        <div className="vs-rate" role="group" aria-label="Speaking speed">
          {[1, 1.15, 1.4].map((r) => (
            <button key={r} className={Math.abs(rate - r) < 0.01 ? "on" : ""} onClick={() => onRate(r)}
              title={r === 1 ? "Normal speed" : r === 1.15 ? "A little quicker" : "Brisk"}>{r === 1 ? "1×" : r === 1.15 ? "1.15×" : "1.4×"}</button>
          ))}
        </div>
        <button className="w-icon" onClick={() => onSpeak(!speak)} aria-pressed={speak}
          title={speak ? "Stop reading answers aloud" : "Read answers aloud"}>
          {speak ? <Icon.Speaker size={16} /> : <Icon.SpeakerOff size={16} />}
        </button>
        <button className="w-icon" onClick={onEnd} title="End voice mode"><Icon.Close size={16} /></button>
      </div>

      <div className="vs-mid">
        <button ref={orb} className="vs-orb" onClick={() => { if (state === "speaking") agent?.stopSpeaking(); }}
          aria-label={state === "speaking" ? "Interrupt" : title}>
          <span className="vs-wave vs-w1" /><span className="vs-wave vs-w2" /><span className="vs-wave vs-w3" />
          <span className="vs-core"><Icon.Mic size={26} /></span>
        </button>
        <h2 className="vs-title">{title}</h2>
        <p className="vs-hint">{hint}</p>

        {heard && <p className="vs-heard"><q>{heard}</q></p>}
        {saying && state === "speaking" && <p className="vs-saying">{saying}</p>}
        {queued && <p className="vs-queued">Next: <q>{queued}</q></p>}
        {deaf && (
          <div className="vs-deaf">
            {deaf.recording
              ? <><b>I can't hear anything yet.</b><span>Your microphone is giving {Math.round(deaf.db)} dB; speech needs about {Math.round(deaf.threshold)} dB. Check that the right input device is selected and not muted, then speak a little closer.</span></>
              : <><b>Nothing is being recorded.</b><span>The microphone is open but this browser is not capturing from it. Try Chrome or Edge, or pick another input device.</span></>}
          </div>
        )}
        {blocked && <button className="vb-unblock" onClick={() => agent?.unblock()}><Icon.Speaker size={14} /> Tap to hear the answer</button>}
      </div>

      {steps.length > 0 && (
        <ul className="vs-steps">
          {steps.map((s, i) => (
            <li key={i} className={s.kind === "tool" && s.state === "failed" ? "bad" : ""}>
              <Icon.Check size={13} /> {describe(s)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What one step of the work was, in the fewest words that still mean something. */
function describe(i: TimelineItem): string {
  if (i.kind !== "tool") return i.kind === "error" ? "Something went wrong" : "";
  const id = String((i.input as any)?.id ?? "").replace(/_/g, " ");
  switch (i.tool) {
    case "place_component": return id ? `Added the ${id} section` : "Added a section";
    case "create_page": return `Created ${(i.input as any)?.title ?? "a page"}`;
    case "make_change": return String((i.ui as any)?.summary ?? "Changed it").slice(0, 70);
    case "revert_change": return "Reverted that";
    case "screenshot_page": return "Looked at the page";
    case "analyze_design": return "Measured the design";
    case "ask_person": return "Asked you a question";
    default: return i.tool.replace(/_/g, " ");
  }
}
