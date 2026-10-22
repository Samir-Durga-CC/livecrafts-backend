import { useRef, useState } from "react";
import { FloatingMenu } from "../components/FloatingMenu";
import { Icon } from "../icons";

export type VoiceMode = "dictate" | "agent";
/** "" idle · "warming" opening, not listening yet · "rec" live, and the button now means Stop. */
export type VoicePhase = "" | "warming" | "rec";

/**
 * One control for both ways of talking to it.
 *
 * There were two buttons side by side - a microphone and a waveform - which cost two of the six slots in a
 * toolbar that had already run out of room, and never said what the difference was. They are one button now:
 * it does the mode it is set to, and the caret beside it changes the mode. Dictation is the default, because it
 * is the one that only types into the box and so can surprise nobody.
 *
 * Pressed, it becomes the stop button for whatever it started - amber while the session is opening, red once it
 * is really listening, which is the same thing the beep says.
 */
export function VoiceButton({ mode, phase, on, onStart, onEnd }: {
  mode: VoiceMode;
  phase: VoicePhase;
  /** A voice session is running (in `mode`). */
  on: boolean;
  onStart: (m: VoiceMode) => void;
  onEnd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const live = on && phase !== "";
  const agent = mode === "agent";

  const title = phase === "warming" ? (agent ? "Connecting - wait for the beep" : "Opening the microphone - wait for the beep")
    : live ? (agent ? "Stop talking to the assistant" : "Stop dictating (what was written stays in the box)")
    : agent ? "Talk: it answers out loud and does the work" : "Dictate: what you say is typed into the box";

  return (
    <span className="voice-pick">
      <button className={`mode mic ${phase} ${live ? "live" : ""}`} aria-pressed={live} title={title}
        onClick={() => (live ? onEnd() : onStart(mode))}>
        {live ? <Icon.Stop size={15} /> : agent ? <Icon.Waveform size={17} /> : <Icon.Mic size={17} />}
      </button>
      {/* Hidden while it is running: changing mode mid-session would mean stopping it, and the one button that
          must always do the obvious thing is the one that stops a live microphone. */}
      {!live && (
        <>
          <button ref={caret} className="voice-caret" aria-label="Choose dictation or the assistant"
            aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon.ChevronDown size={11} />
          </button>
          <FloatingMenu anchor={caret} open={open} onClose={() => setOpen(false)} align="left">
            <div className="menu-label">Voice</div>
            <button className="menu-item" onClick={() => { setOpen(false); onStart("dictate"); }}>
              <Icon.Mic size={16} />
              <span className="grow"><b>Dictate</b><small>types into the box · nothing is sent until you press send</small></span>
              {!agent && <Icon.Check size={15} />}
            </button>
            <button className="menu-item" onClick={() => { setOpen(false); onStart("agent"); }}>
              <Icon.Waveform size={16} />
              <span className="grow"><b>Talk to the assistant</b><small>sends when you stop speaking · answers out loud</small></span>
              {agent && <Icon.Check size={15} />}
            </button>
          </FloatingMenu>
        </>
      )}
    </span>
  );
}
