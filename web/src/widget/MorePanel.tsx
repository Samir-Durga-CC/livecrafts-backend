import { useState } from "react";
import { blogPrompt } from "../blog";
import { Icon } from "../icons";

/**
 * The widget's "More" tab: things to create in one step. A blog post needs only a title here (professional, about
 * 800 words, AI featured image); "More options" opens the full form for tone, length, image and notes.
 */
export function MorePanel({ disabled, onBlog, onBlogOptions }: {
  disabled: boolean;
  onBlog: (prompt: string) => Promise<void>;
  onBlogOptions: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ready = title.trim().length > 2 && !disabled && !busy;

  async function write(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr("");
    try { await onBlog(blogPrompt({ title, tone: "Professional", words: 800, image: "ai" })); setTitle(""); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="more-panel">
      <form className="more-card" onSubmit={write}>
        <div className="more-head"><span className="more-ico"><Icon.Page size={16} /></span><div><b>New blog post</b><span>Give a title - the assistant writes the post, SEO description, excerpt, categories, tags and featured image as a draft.</span></div></div>
        <label className="sr-only" htmlFor="lc-blog-title">Blog title</label>
        <input id="lc-blog-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Blog title, e.g. 5 ways to speed up your site" disabled={disabled || busy} />
        {err && <div className="banner error">{err}</div>}
        <div className="more-actions">
          <button type="button" className="btn" onClick={() => onBlogOptions(title)} disabled={disabled}>More options</button>
          <button className="btn primary" disabled={!ready}>{busy ? "Starting…" : "Write blog post"}</button>
        </div>
        <p className="muted small">Default: professional tone, about 800 words, AI image (about $0.04). Nothing is published until you deploy.</p>
      </form>
    </div>
  );
}
