import { Icon } from "../icons";
import type { VoiceState } from "./voice";

/**
 * One line above the composer that says what voice is doing - instead of a full-screen orb.
 *
 * The chat stays the chat: what was said appears as an ordinary message, the answer appears as an ordinary answer.
 * This strip only carries the state nobody can see otherwise (is it listening, is it talking) and the few controls
 * that have to be within reach while talking.
 */
export function VoiceStrip({ mode, state, heard, busy, blocked, speak, onSpeak, onUnblock, onDiagnostics, onEnd }: {
  mode: "dictate" | "agent";
  state: VoiceState;
  /** What it heard last - in dictation this is already in the box, so it is only shown while it is still coming. */
  heard: string;
  busy: boolean;
  blocked: boolean;
  speak: boolean;
  onSpeak: (on: boolean) => void;
  onUnblock: () => void;
  onDiagnostics?: () => void;
  onEnd: () => void;
}) {
  const label =
    // Dictation holds this state until the speech session is live and the beep has sounded, so it says what the
    // person is waiting for rather than what has already happened.
    state === "starting" ? (mode === "dictate" ? "Getting ready — speak after the beep" : "Opening the microphone…")
    : state === "hearing" ? "Listening…"
    : state === "transcribing" ? "Writing that down…"
    : state === "speaking" ? "Speaking — talk over me to interrupt"
    : busy ? "Working on it…"
    : mode === "dictate" ? "Speak — it types into the box" : "Listening";

  return (
    <div className={`vstrip vstrip-${state}${busy ? " busy" : ""}`} role="status" aria-live="polite">
      <span className="vstrip-dot" aria-hidden="true" />
      <span className="vstrip-label">{label}</span>
      {heard && state !== "listening" && <span className="vstrip-heard">“{heard}”</span>}
      <span className="grow" />
      {blocked && <button className="vstrip-btn" onClick={onUnblock}>Tap for sound</button>}
      {mode === "agent" && (
        <button className="w-icon" onClick={() => onSpeak(!speak)} aria-pressed={speak}
          title={speak ? "Stop reading answers aloud" : "Read answers aloud"}>
          {speak ? <Icon.Speaker size={15} /> : <Icon.SpeakerOff size={15} />}
        </button>
      )}
      {onDiagnostics && (
        <button className="w-icon" onClick={onDiagnostics} title="Save this voice session's log, to send to support">
          <Icon.Share size={14} />
        </button>
      )}
      <button className="w-icon" onClick={onEnd} title={mode === "dictate" ? "Stop dictating" : "End voice mode"}>
        <Icon.Close size={15} />
      </button>
    </div>
  );
}
