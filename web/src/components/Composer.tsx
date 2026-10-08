import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { UploadedFile } from "../types";

interface Attachment { key: string; name: string; preview: string; state: "uploading" | "ready" | "error"; file?: UploadedFile; error?: string }

export interface Context { pageUrl?: string; selectedTarget?: string }

export function Composer({ disabled, placeholder, model, context, draft, onClearContext, onSend, extra, chips, compact, onStop, stopping, notice, voice, attachNote }: {
  disabled: boolean; placeholder: string; model: string; context: Context; draft?: { text: string; n: number };
  extra?: ReactNode; chips?: ReactNode; compact?: boolean;
  /** While the assistant works: the send button becomes Stop. */
  onStop?: () => void; stopping?: boolean;
  /** A bar above the input (e.g. "Paused - Continue / note / correction"). */
  notice?: ReactNode;
  /** The voice-mode button, next to the attach buttons. */
  voice?: ReactNode;
  /** Shown under attached images (e.g. "also save them to the Media Library"). */
  attachNote?: ReactNode;
  onClearContext: (k: keyof Context) => void; onSend: (text: string, fileIds: string[], files: UploadedFile[]) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [drag, setDrag] = useState(false);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => { if (ta.current) { ta.current.style.height = "auto"; ta.current.style.height = Math.min(ta.current.scrollHeight, 180) + "px"; } }, [text]);
  useEffect(() => { if (draft) { setText(draft.text); ta.current?.focus(); } }, [draft?.n]); // "Edit" on a past message loads it back here

  function add(list: FileList | File[]) {
    for (const f of Array.from(list)) {
      if (!f.type.startsWith("image/")) continue;
      const key = Math.random().toString(36).slice(2);
      const name = f.name || "pasted-image.png";
      setFiles((a) => [...a, { key, name, preview: URL.createObjectURL(f), state: "uploading" }]);
      api.uploadFile(f.name ? f : new File([f], name, { type: f.type }))
        .then((file) => setFiles((a) => a.map((x) => (x.key === key ? { ...x, state: "ready", file } : x))))
        .catch((e) => setFiles((a) => a.map((x) => (x.key === key ? { ...x, state: "error", error: e.message } : x))));
    }
  }

  const ready = files.filter((f) => f.state === "ready");
  const uploading = files.some((f) => f.state === "uploading");
  const canSend = !disabled && !sending && !uploading && (text.trim().length > 0 || ready.length > 0);

  async function submit() {
    if (!canSend) return;
    setSending(true);
    try { await onSend(text.trim() || "Use the attached image(s).", ready.map((f) => f.file!.id), ready.map((f) => f.file!)); setText(""); setFiles([]); }
    finally { setSending(false); }
  }

  return (
    <div className={`composer ${drag ? "drag" : ""} ${disabled ? "off" : ""} ${compact ? "compact" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
      {notice}
      {(context.pageUrl || context.selectedTarget || chips) && (
        <div className="chips">
          {chips}
          {context.pageUrl && <span className="chip"><Icon.Globe size={13} /> {context.pageUrl.replace(/^https?:\/\//, "")}<button aria-label="remove" onClick={() => onClearContext("pageUrl")}><Icon.Close size={12} /></button></span>}
          {context.selectedTarget && <span className="chip"><Icon.Pin size={13} /> <code>{context.selectedTarget}</code><button aria-label="remove" onClick={() => onClearContext("selectedTarget")}><Icon.Close size={12} /></button></span>}
        </div>
      )}
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f) => (
            <div key={f.key} className={`att ${f.state}`} title={f.error ?? f.name}>
              <img src={f.preview} alt={f.name} />
              {f.state === "uploading" && <span className="att-badge"><span className="spin" /></span>}
              {f.state === "error" && <span className="att-badge err">!</span>}
              <button className="att-x" aria-label="remove" onClick={() => setFiles((a) => a.filter((x) => x.key !== f.key))}><Icon.Close size={11} /></button>
            </div>
          ))}
          {attachNote && <div className="att-note">{attachNote}</div>}
        </div>
      )}
      <div className="c-input">
        <span className="c-spark"><Icon.Sparkle size={18} /></span>
        <textarea ref={ta} rows={1} value={text} disabled={disabled} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); add(imgs); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
      </div>
      <div className="c-bar">
        <button className="mode" title="Attach an image (you can also drag & drop or paste)" onClick={() => picker.current?.click()} disabled={disabled}><Icon.Image size={17} /></button>
        <button className="mode" title="Attach a file" onClick={() => picker.current?.click()} disabled={disabled}><Icon.Clip size={17} /></button>
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
        {voice}
        <span className="c-hint">Enter to send · Shift+Enter for a new line</span>
        <span className="grow" />
        {extra ?? <span className="model-pill" title="Change the model with LC_MODEL in the backend .env"><Icon.Sparkle size={13} /> {model}</span>}
        {onStop
          ? <button className="send stop" onClick={onStop} disabled={stopping} aria-label="Stop" title={stopping ? "Stopping after the current step…" : "Stop (you can continue, add a note or correct the request)"}>{stopping ? <span className="spin" /> : <Icon.Stop size={17} />}</button>
          : <button className="send" onClick={() => void submit()} disabled={!canSend} aria-label="Send"><Icon.Send size={19} /></button>}
      </div>
    </div>
  );
}
