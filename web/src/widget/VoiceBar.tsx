import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import type { VoiceAgent, VoiceState } from "./voice";

const VOICE_LABEL: Record<string, string> = {
  onyx: "Onyx · deep", ash: "Ash · clear", echo: "Echo · calm", fable: "Fable · British", sage: "Sage · soft", alloy: "Alloy · neutral",
  coral: "Coral · warm", nova: "Nova · bright", shimmer: "Shimmer · light", ballad: "Ballad · gentle", verse: "Verse · expressive",
};

/** The strip above the input while voice mode is on: what it is doing, what it heard, and its few settings. */
export function VoiceBar({ agent, state, heard, busy, waiting, queued, blocked, voices, voice, speak, onVoice, onSpeak, onEnd }: {
  agent: VoiceAgent | null; state: VoiceState; heard: string; busy: boolean; waiting: boolean; queued: string; blocked: boolean;
  voices: string[]; voice: string; speak: boolean;
  onVoice: (v: string) => void; onSpeak: (on: boolean) => void; onEnd: () => void;
}) {
  const orb = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!agent) return;
    agent.levelSink = (l) => orb.current?.style.setProperty("--lvl", l.toFixed(3));
    return () => { agent.levelSink = null; };
  }, [agent]);

  const [title, hint] =
    state === "starting" ? ["Opening the microphone…", "Allow the microphone if the browser asks."]
    : state === "hearing" ? ["Listening…", "Pause when you are done - no need to press anything."]
    : state === "transcribing" ? ["Got it…", ""]
    : state === "speaking" ? ["Speaking…", "Start talking or tap the circle to interrupt."]
    : waiting ? ["Waiting for your OK", "Say “yes” to go ahead or “no” to cancel."]
    : busy ? ["Working on it…", "Say “stop” to interrupt."]
    : ["I'm listening", "Just say what you want to change."];

  return (
    <div className={`vbar ${state}${busy && state === "listening" ? " busy" : ""}`} role="status" aria-live="polite">
      <div className="vbar-row">
        <button ref={orb} className="vb-orb" title={state === "speaking" ? "Interrupt" : "Voice mode is on"}
          onClick={() => { if (state === "speaking") agent?.stopSpeaking(); }} aria-label={state === "speaking" ? "Interrupt" : title}>
          <span className="vb-ring" /><span className="vb-core"><Icon.Mic size={15} /></span>
        </button>
        <div className="vb-main">
          <b>{title}</b>
          <small>{heard ? <>You said: <q>{heard}</q></> : hint}</small>
        </div>
        {voices.length > 0 && (
          <select className="vb-voice" value={voice} onChange={(e) => onVoice(e.target.value)} title="Voice" aria-label="Voice">
            {voices.map((v) => <option key={v} value={v}>{VOICE_LABEL[v] ?? v}</option>)}
          </select>
        )}
        <button className="w-icon" onClick={() => onSpeak(!speak)} title={speak ? "Mute the spoken answers (keep listening)" : "Read the answers aloud"} aria-pressed={speak}>
          {speak ? <Icon.Speaker size={16} /> : <Icon.SpeakerOff size={16} />}
        </button>
        <button className="w-icon" onClick={onEnd} title="End voice mode"><Icon.Close size={16} /></button>
      </div>
      {blocked && <button className="vb-unblock" onClick={() => agent?.unblock()}><Icon.Speaker size={14} /> Tap to hear the answer</button>}
      {queued && <div className="vb-queued">Next, when this step is done: <q>{queued}</q></div>}
    </div>
  );
}
