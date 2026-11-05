import { useEffect, useState } from "react";
import { api, setToken } from "../api";
import type { InstructionVersion } from "../types";

/**
 * "My instructions": what this account adds to the assistant's rules. The rules themselves are never shown here as
 * editable - they stay as they are - so "Reset to original" simply means: nothing of my own. Every saved version is
 * listed and can be brought back.
 */
export function InstructionsDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [history, setHistory] = useState<InstructionVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const take = (r: { text: string; history: InstructionVersion[] }) => { setText(r.text); setSaved(r.text); setHistory(r.history); };
  useEffect(() => { api.myInstructions().then(take).catch((e) => setMsg({ ok: false, text: (e as Error).message })); }, []);

  async function run(fn: () => Promise<{ text: string; history: InstructionVersion[] }>, ok: string) {
    setBusy(true); setMsg(null);
    try { take(await fn()); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>My instructions</h2>
        <p className="muted small">
          Added to the assistant's own rules for every request you send - never in place of them. Use it for how you like
          to work: tone, language, what to always check. Empty = the original assistant.
        </p>
        <textarea className="instr-text" value={text} maxLength={4000} rows={8} onChange={(e) => setText(e.target.value)}
          placeholder="For example: Answer in British English. Keep headings under 8 words. Always show me the mobile view after a change." />
        <div className="muted small">{text.length} / 4000</div>
        {msg && <div className={`banner ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
        <div className="dialog-actions">
          <button className="btn ghost danger" disabled={busy || (!saved && !text)} onClick={() => void run(api.resetMyInstructions, "Back to the original assistant. Your earlier text is kept below.")}>Reset to original</button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy || text === saved} onClick={() => void run(() => api.saveMyInstructions(text), "Saved. It applies from your next request.")}>Save</button>
        </div>
        {history.length > 1 && (
          <div className="instr-history">
            <div className="menu-label">Earlier versions</div>
            {history.map((h, i) => (
              <div key={h.at + i} className="instr-ver">
                <span className="muted small">{new Date(h.at).toLocaleString()} · {h.by}</span>
                <span className="instr-ver-text">{h.text || <em className="muted">original (nothing of my own)</em>}</span>
                {h.text !== text && <button className="rbtn" onClick={() => setText(h.text)}>Use this</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.next !== f.again) return setMsg({ ok: false, text: "The two new passwords are not the same." });
    setBusy(true); setMsg(null);
    try { const r = await api.changePassword(f.current, f.next); setToken(r.token); setMsg({ ok: true, text: "Changed. You are signed out everywhere else." }); setF({ current: "", next: "", again: "" }); }
    catch (e2) { setMsg({ ok: false, text: (e2 as Error).message }); }
    finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Change password</h2>
        <label>Current password <input type="password" required value={f.current} onChange={set("current")} autoComplete="current-password" /></label>
        <label>New password <small className="muted">(10 characters or more)</small><input type="password" required minLength={10} value={f.next} onChange={set("next")} autoComplete="new-password" /></label>
        <label>New password again <input type="password" required value={f.again} onChange={set("again")} autoComplete="new-password" /></label>
        {msg && <div className={`banner ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
        </div>
      </form>
    </div>
  );
}
