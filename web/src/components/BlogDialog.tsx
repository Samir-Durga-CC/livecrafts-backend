import { useEffect, useRef, useState } from "react";
import { api, type MediaItem } from "../api";
import { Icon } from "../icons";
import { LENGTHS, TONES, blogPrompt, type BlogRequest } from "../blog";

/**
 * "New blog post": the person gives a title (and optionally tone, length, image); the assistant writes the rest.
 * The image is AI-generated, uploaded here, picked from the Media Library, or left out.
 */
export function BlogDialog({ siteId, initialTitle = "", onClose, onSubmit }: {
  siteId: string; initialTitle?: string; onClose: () => void; onSubmit: (prompt: string, fileIds: string[]) => Promise<void>;
}) {
  const [r, setR] = useState<BlogRequest>({ title: initialTitle, tone: "Professional", words: 800, image: "ai" });
  const [customTone, setCustomTone] = useState(false);
  const [upload, setUpload] = useState<{ id?: string; preview: string; busy: boolean; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof BlogRequest>(k: K, v: BlogRequest[K]) => setR((x) => ({ ...x, [k]: v }));
  useEffect(() => { titleRef.current?.focus(); }, []);

  function pickFile(f?: File) {
    if (!f || !f.type.startsWith("image/")) return;
    setUpload({ preview: URL.createObjectURL(f), busy: true });
    api.uploadFile(f).then((u) => setUpload((x) => x && { ...x, id: u.id, busy: false }), (e) => setUpload((x) => x && { ...x, busy: false, error: e.message }));
  }

  const imageReady = r.image === "upload" ? !!upload?.id : r.image === "library" ? !!r.mediaId : true;
  const canSend = r.title.trim().length > 2 && imageReady && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true); setErr("");
    try { await onSubmit(blogPrompt(r), r.image === "upload" && upload?.id ? [upload.id] : []); onClose(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog wide blog-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New blog post</h2>
        <p className="muted">Give a title. The assistant writes the post, the SEO description, the excerpt, categories, tags and the featured image, and saves it as a draft. Nothing is published until you deploy.</p>
        <label>Title <input ref={titleRef} required value={r.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. 7 ways to speed up your WordPress site" /></label>

        <div className="blog-row">
          <label>Tone
            {customTone
              ? <input value={r.tone} onChange={(e) => set("tone", e.target.value)} placeholder="e.g. warm and expert" />
              : <select value={r.tone} onChange={(e) => { if (e.target.value === "custom") { setCustomTone(true); set("tone", ""); } else set("tone", e.target.value); }}>
                  {TONES.map((t) => <option key={t}>{t}</option>)}
                  <option value="custom">Other…</option>
                </select>}
          </label>
          <label>Length
            <select value={r.words} onChange={(e) => set("words", Number(e.target.value))}>
              {LENGTHS.map((n) => <option key={n} value={n}>about {n} words</option>)}
            </select>
          </label>
        </div>

        <fieldset className="blog-image">
          <legend>Featured image</legend>
          <div className="seg" role="radiogroup">
            {([["ai", "AI generated", Icon.Sparkle], ["upload", "Upload", Icon.Upload], ["library", "Media Library", Icon.Image], ["none", "None", Icon.Close]] as const).map(([v, label, Ico]) => (
              <button type="button" key={v} role="radio" aria-checked={r.image === v} className={r.image === v ? "on" : ""} onClick={() => set("image", v)}><Ico size={14} /> {label}</button>
            ))}
          </div>
          {r.image === "ai" && (
            <>
              <input value={r.imageIdea ?? ""} onChange={(e) => set("imageIdea", e.target.value)} placeholder="Optional: describe the picture (else it matches the title)" />
              <p className="muted small">One image on your OpenAI key, about $0.04. Alt text is written automatically.</p>
            </>
          )}
          {r.image === "upload" && (
            <div className="blog-upload">
              {upload ? <img src={upload.preview} alt="" /> : null}
              <label className="btn">{upload ? "Choose another" : "Choose an image"}<input type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0])} /></label>
              {upload?.busy && <span className="spin" />}
              {upload?.error && <span className="banner error">{upload.error}</span>}
              <p className="muted small">It goes into the Media Library with alt text written for it.</p>
            </div>
          )}
          {r.image === "library" && <MediaPicker siteId={siteId} selected={r.mediaId} onPick={(m) => setR((x) => ({ ...x, mediaId: m.id, mediaAlt: m.alt || m.title }))} />}
        </fieldset>

        <label>Notes for the writer (optional)
          <textarea rows={2} value={r.notes ?? ""} onChange={(e) => set("notes", e.target.value)} placeholder="Points to cover, audience, keywords, a call to action…" />
        </label>

        {err && <div className="banner error">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canSend}>{busy ? "Starting…" : "Write the draft"}</button>
        </div>
      </form>
    </div>
  );
}

function MediaPicker({ siteId, selected, onPick }: { siteId: string; selected?: number; onPick: (m: MediaItem) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const t = setTimeout(() => { setErr(""); api.media(siteId, q).then(setItems, (e) => { setItems([]); setErr(e.message); }); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [siteId, q]);
  return (
    <div className="media-picker">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Media Library" />
      {err && <div className="banner error">{err}</div>}
      {items === null ? <span className="spin" /> : items.length === 0 ? <p className="muted small">No images found.</p> : (
        <div className="media-grid">
          {items.map((m) => (
            <button type="button" key={m.id} className={m.id === selected ? "on" : ""} onClick={() => onPick(m)} title={m.alt || m.title} aria-pressed={m.id === selected}>
              <img src={m.url} alt={m.alt} decoding="async" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
