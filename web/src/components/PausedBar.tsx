import { Icon } from "../icons";

export type PauseKind = "note" | "edit";

/** Shown above the message box while a chat is paused: continue as is, or say something first. */
export function PausedBar({ kind, onKind, onContinue, busy }: { kind: PauseKind; onKind: (k: PauseKind) => void; onContinue: () => void; busy?: boolean }) {
  return (
    <div className="paused-bar" role="status">
      <div className="pb-top">
        <span className="pb-title"><Icon.Stop size={12} /> Paused</span>
        <span className="pb-hint">Finished work is kept. Continue, or type below first.</span>
        <button className="btn accent sm" onClick={onContinue} disabled={busy}><Icon.Play size={12} /> Continue</button>
      </div>
      <div className="qa-seg pb-kind" role="radiogroup" aria-label="What your message is">
        <button className={kind === "note" ? "on" : ""} onClick={() => onKind("note")} title="Extra instruction - the same request continues">Add a note</button>
        <button className={kind === "edit" ? "on" : ""} onClick={() => onKind("edit")} title="Replace what you asked for - changes already made that conflict are reverted">Correct my request</button>
      </div>
    </div>
  );
}

/** Shown when a chat stopped on its own (the server restarted, or an error): what happened, and Continue. */
export function InterruptedBar({ failed, error, onContinue }: { failed: boolean; error?: string; onContinue: () => void }) {
  return (
    <div className="paused-bar" role="status">
      <div className="pb-top">
        <span className="pb-title"><Icon.Stop size={12} /> {failed ? "Stopped by an error" : "Interrupted"}</span>
        <span className="pb-hint">{failed ? (error ? error.slice(0, 160) : "Something went wrong.") : "The server restarted while I was working."} Finished work is kept.</span>
        <button className="btn accent sm" onClick={onContinue}><Icon.Play size={12} /> Continue</button>
      </div>
    </div>
  );
}
