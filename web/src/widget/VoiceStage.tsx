import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import type { VoiceAgent, VoiceState } from "./voice";
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

export function VoiceStage({ agent, state, heard, saying, steps, busy, waiting, queued, blocked, speak, onSpeak, onChat, onEnd }: {
  agent: VoiceAgent | null;
  state: VoiceState;
  /** The last thing the person said, and the line being read out now. */
  heard: string;
  saying: string;
  /** The last few things that actually happened, newest last. */
  steps: TimelineItem[];
  busy: boolean; waiting: boolean; queued: string; blocked: boolean;
  speak: boolean;
  onSpeak: (on: boolean) => void;
  onChat: () => void;
  onEnd: () => void;
}) {
  const orb = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!agent) return;
    agent.levelSink = (l) => orb.current?.style.setProperty("--lvl", l.toFixed(3));
    return () => { agent.levelSink = null; };
  }, [agent]);

  const phase = waiting ? "waiting" : busy && state !== "speaking" && state !== "hearing" ? "working" : state;
  const { title, hint } = LABEL[phase as keyof typeof LABEL] ?? LABEL.listening;

  return (
    <div className={`vstage vs-${phase}`} role="status" aria-live="polite">
      <div className="vs-top">
        <button className="w-icon" onClick={onChat} title="Show the chat"><Icon.Chat size={16} /></button>
        <span className="grow" />
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
