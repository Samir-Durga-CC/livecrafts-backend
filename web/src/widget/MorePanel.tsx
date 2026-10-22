import { useEffect, useState } from "react";
import { api } from "../api";
import { blogPrompt } from "../blog";
import { Icon } from "../icons";
import { scoreTone, whenLabel, type SpeedRunSummary } from "../speed";
import { updatable, type PluginList } from "../plugins";

/**
 * The widget's "More" tab: a short menu. Picking an item opens that feature on its own screen (blog post, PageSpeed
 * report, plugin updates), so nothing is crowded; each row shows a small status so you know where to look.
 */
export function MoreMenu({ siteId, pageUrl, onOpen }: { siteId: string; pageUrl: string; onOpen: (view: "blog" | "speed" | "plugins") => void }) {
  const speed = useSpeedStatus(siteId, pageUrl);
  const plugins = usePluginStatus(siteId);
  const items: Array<{ id: "blog" | "speed" | "plugins"; icon: React.ReactNode; title: string; text: string; badge?: React.ReactNode }> = [
    { id: "blog", icon: <Icon.Page size={17} />, title: "New blog post", text: "A full post with SEO and image, as a draft" },
    { id: "speed", icon: <Icon.Gauge size={17} />, title: "PageSpeed report", text: speed.text, badge: speed.badge },
    { id: "plugins", icon: <Icon.Plug size={17} />, title: "Plugin updates", text: plugins.text, badge: plugins.badge },
  ];
  return (
    <nav className="more-menu" aria-label="More tools">
      {items.map((it) => (
        <button key={it.id} type="button" className="more-item" onClick={() => onOpen(it.id)}>
          <span className="more-ico">{it.icon}</span>
          <span className="more-item-text"><b>{it.title}</b><span>{it.text}</span></span>
          {it.badge}
          <Icon.ChevronRight size={15} />
        </button>
      ))}
    </nav>
  );
}

function useSpeedStatus(siteId: string, pageUrl: string) {
  const [last, setLast] = useState<SpeedRunSummary | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.speedHistory(siteId, pageUrl).then((r) => { if (alive) setLast(r.runs.find((x) => x.status !== "failed") ?? null); }).catch(() => { if (alive) setLast(null); });
    return () => { alive = false; };
  }, [siteId, pageUrl]);
  const mobile = last?.scores.find((x) => x.device === "mobile") ?? last?.scores[0];
  return {
    text: last === undefined ? "Scores and top fixes for this page" : last ? (last.status === "running" ? "Running now…" : `Last report ${whenLabel(last.startedAt)}`) : "No report for this page yet",
    badge: mobile && mobile.performance !== null ? <span className={`sp-pill ${scoreTone(mobile.performance)}`} title="Performance">{mobile.device === "mobile" ? <Icon.Phone size={11} /> : <Icon.Monitor size={11} />}{mobile.performance}</span> : undefined,
  };
}

function usePluginStatus(siteId: string) {
  const [d, setD] = useState<PluginList | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.plugins(siteId).then((r) => { if (alive) setD(r); }).catch(() => { if (alive) setD(null); });
    return () => { alive = false; };
  }, [siteId]);
  const n = d ? d.plugins.filter(updatable).length : 0;
  return {
    text: d === undefined ? "Update with a backup, roll back any time" : d ? (n ? "Backup first, automatic rollback if the site breaks" : `All up to date · ${d.plugins.length} installed`) : "Update with a backup, roll back any time",
    badge: n ? <span className="more-count">{n} update{n === 1 ? "" : "s"}</span> : undefined,
  };
}

/** More → New blog post: only a title is needed (professional, about 800 words, AI image); "Change options" opens the full form. */
export function BlogPanel({ busy, onBlog, onBlogOptions, onOpenChat, onBack }: {
  /** "working": the assistant is running a request; "waiting": a chat waits for approval (a blog post can still start, as a new chat). */
  busy: "working" | "waiting" | null;
  onOpenChat: () => void; onBack: () => void;
  onBlog: (prompt: string) => Promise<void>;
  onBlogOptions: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState("");

  async function write(e: React.FormEvent) {
    e.preventDefault();
    if (starting) return;
    if (title.trim().length < 3) { setErr("Enter a title first."); return; }
    if (busy === "working") { setErr("The assistant is still working on another request. Wait for it to finish (or stop it in Chat), then write the post."); return; }
    setStarting(true); setErr("");
    try { await onBlog(blogPrompt({ title, tone: "Professional", words: 800, image: "ai" })); setTitle(""); }
    catch (x) { setErr((x as Error).message); }
    finally { setStarting(false); }
  }

  return (
    <div className="more-panel">
      <button type="button" className="sp-back" onClick={onBack}><Icon.ChevronRight size={13} /> More</button>
      {busy && (
        <div className={`more-busy ${busy}`} role="status">
          <span>{busy === "working" ? "The assistant is working on a request in Chat." : "A chat is waiting for your approval. A new blog post starts in its own chat; that one stays in your chat list."}</span>
          <button type="button" className="btn" onClick={onOpenChat}>Open chat</button>
        </div>
      )}
      <form className="more-card" onSubmit={write} noValidate>
        <div className="more-head"><span className="more-ico"><Icon.Page size={16} /></span><div><b>New blog post</b><span>Give a title. The assistant writes the post, SEO description, excerpt, categories, tags and featured image as a draft.</span></div></div>
        <label className="sr-only" htmlFor="lc-blog-title">Blog title</label>
        <input id="lc-blog-title" value={title} onChange={(e) => { setTitle(e.target.value); if (err) setErr(""); }} placeholder="5 ways to speed up your site" disabled={starting} aria-invalid={!!err} aria-describedby={err ? "lc-blog-err" : undefined} autoFocus />
        {err && <p id="lc-blog-err" className="more-err">{err}</p>}
        <div className="more-chips" aria-label="Defaults">
          <span>Professional tone</span><span>About 800 words</span><span>AI image, about $0.04</span><span>Saved as a draft</span>
        </div>
        <div className="more-actions">
          <button type="button" className="btn" onClick={() => onBlogOptions(title)}>Change options</button>
          <button className="btn primary">{starting ? "Starting…" : "Write blog post"}</button>
        </div>
      </form>
    </div>
  );
}
