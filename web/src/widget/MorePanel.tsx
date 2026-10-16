import { useEffect, useState } from "react";
import { api } from "../api";
import { blogPrompt } from "../blog";
import { Icon } from "../icons";
import { scoreTone, whenLabel, type SpeedRunSummary } from "../speed";

/**
 * The widget's "More" tab: a blog post in one step, and the PageSpeed report for this page. A blog post needs only a title here (professional, about
 * 800 words, AI featured image); "More options" opens the full form for tone, length, image and notes.
 */
export function MorePanel({ disabled, onBlog, onBlogOptions, siteId, pageUrl, onSpeed }: {
  disabled: boolean;
  siteId: string; pageUrl: string; onSpeed: () => void;
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
      <SpeedCard siteId={siteId} pageUrl={pageUrl} onOpen={onSpeed} />
    </div>
  );
}

/** PageSpeed: the latest scores for this page (if any) and a button into the full report. */
function SpeedCard({ siteId, pageUrl, onOpen }: { siteId: string; pageUrl: string; onOpen: () => void }) {
  const [last, setLast] = useState<SpeedRunSummary | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.speedHistory(siteId, pageUrl).then((r) => { if (alive) setLast(r.runs.find((x) => x.status !== "failed") ?? null); }).catch(() => { if (alive) setLast(null); });
    return () => { alive = false; };
  }, [siteId, pageUrl]);
  return (
    <div className="more-card">
      <div className="more-head"><span className="more-ico"><Icon.Gauge size={16} /></span><div><b>Google PageSpeed report</b><span>Scores, Core Web Vitals and the top fixes for this page. The assistant can fix most of them for you.</span></div></div>
      {last === undefined ? <span className="spin" /> : last ? (
        <div className="more-speed-last">
          <span className="muted small">{last.status === "running" ? "Running now…" : `Last report: ${whenLabel(last.startedAt)}`}</span>
          <span className="sp-hist-scores">{last.scores.map((s) => <span key={s.device} className={`sp-pill ${scoreTone(s.performance)}`} title={`${s.device} performance`}>{s.device === "mobile" ? <Icon.Phone size={11} /> : <Icon.Monitor size={11} />}{s.performance ?? "–"}</span>)}</span>
        </div>
      ) : <p className="muted small">No report for this page yet.</p>}
      <div className="more-actions">
        <button type="button" className="btn primary" onClick={onOpen}>{last ? "Open report" : "Run PageSpeed report"}</button>
      </div>
    </div>
  );
}
