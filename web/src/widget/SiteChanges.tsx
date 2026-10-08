import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import type { SiteChange } from "../types";
import { tell, wp } from "./parent";

const SOURCE: Record<string, string> = { assistant: "Assistant", widget: "Edited on the page", "wp-admin": "WordPress admin", elementor: "Elementor editor", system: "Automatic", "admin-panel": "Admin panel" };
const when = (iso: string) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));

/**
 * The site's change history - every change from every source (the assistant, edits on the page, WP admin, the
 * Elementor editor), like `git status` + `git log`: drafts first (with Deploy / Discard), then what is live.
 * Read straight from WordPress through the page (as the logged-in person).
 */
export function SiteChanges({ postId, reloadKey, canDeploy, onChanged }: { postId: number; reloadKey: number; canDeploy: boolean; onChanged: (msg: string) => void }) {
  const [onlyPage, setOnlyPage] = useState(!!postId);
  const [status, setStatus] = useState<any>(null);
  const [list, setList] = useState<SiteChange[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<SiteChange | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    setProblem("");
    try {
      const [s, c] = await Promise.all([wp<any>("GET", "status"), wp<{ changes: SiteChange[] }>("GET", `changes?limit=60${onlyPage && postId ? `&post=${postId}` : ""}`)]);
      setStatus(s); setList(c.changes);
    } catch (e) { setProblem((e as Error).message); }
  }, [onlyPage, postId]);
  useEffect(() => { void load(); }, [load, reloadKey]);
  useEffect(() => {
    setDetail(null);
    if (open === null) return;
    wp<{ change: SiteChange }>("GET", `changes/${open}`).then((r) => setDetail(r.change), (e) => setProblem((e as Error).message));
  }, [open]);

  async function revert(c: SiteChange) {
    setBusy(c.id); setProblem("");
    try {
      const r = await wp<any>("POST", `changes/${c.id}/revert`, {});
      onChanged(r.note ?? "Reverted");
      await load();
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(null); }
  }

  const drafts = status?.drafts?.count ?? 0;
  const files = status?.files ?? 0; // theme files: live at once, undone by Discard all
  return (
    <div className="sc">
      <div className="sc-status">
        <div className="sc-dot-line"><span className={`sc-dot ${drafts ? "draft" : "live"}`} /><b>{drafts ? `${drafts} unpublished change${drafts === 1 ? "" : "s"}` : "No drafts - the preview is the live site"}</b></div>
        {files > 0 && <small className="muted">{files} theme-file edit{files === 1 ? " is" : "s are"} already live; Discard all puts {files === 1 ? "that file" : "those files"} back as before.</small>}
        {status?.last_release && <small className="muted">Last release #{status.last_release.id}: {status.last_release.summary} · {when(status.last_release.at)}{status.last_release.user ? ` · ${status.last_release.user.name}` : ""}</small>}
        {status?.conflicts?.length > 0 && <div className="qa-warn">Changed on the live site after the draft was made: {status.conflicts.map((c: any) => c.object).join(", ")}. Deploy asks you to confirm.</div>}
        {status?.broken?.length > 0 && <div className="banner error">Some drafts no longer fit the page: {status.broken.map((b: any) => `${b.object}: ${b.error}`).join("; ")}. Revert them.</div>}
        {drafts > 0 && (
          <div className="qa-row">
            {canDeploy && <button className="btn accent sm" onClick={() => tell({ type: "lc:deploy" })}><Icon.Check size={14} /> Deploy…</button>}
            <button className="btn sm" onClick={() => tell({ type: "lc:discard" })}><Icon.Trash size={14} /> Discard all</button>
            <button className="btn sm" onClick={() => tell({ type: "lc:view", view: "live" })}><Icon.Eye size={14} /> Show live</button>
          </div>
        )}
      </div>

      <div className="sc-head">
        <b className="grow">History</b>
        {postId > 0 && <label className="w-toggle"><input type="checkbox" checked={onlyPage} onChange={(e) => setOnlyPage(e.target.checked)} /> This page only</label>}
        <button className="w-icon" title="Refresh" onClick={() => void load()}><Icon.Retry size={15} /></button>
      </div>
      {problem && <div className="banner error">{problem}</div>}
      {!list && !problem && <div className="qa-empty"><span className="spin" /></div>}
      {list && list.length === 0 && <p className="muted">Nothing changed yet{onlyPage ? " on this page" : ""}.</p>}
      <ul className="sc-list">
        {list?.map((c) => (
          <li key={c.id} className={`sc-item ${c.status}`}>
            <button className="sc-main" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
              <span className={`sc-badge ${c.status}`}>{c.status === "draft" ? "Draft" : c.status === "live" ? (c.release ? `Live · #${c.release}` : "Live") : "Dropped"}</span>
              <span className="sc-sum">{c.summary}</span>
              <small className="muted">{c.object.label} · {c.user?.name ?? "-"} · {SOURCE[c.source] ?? c.source} · {when(c.at)}</small>
            </button>
            {open === c.id && (
              <div className="sc-detail">
                {!detail ? <span className="spin" /> : (
                  detail.diff?.length ? detail.diff.map((d) => <Diff key={d.path} label={d.path} before={d.before} after={d.after} />)
                    : <Diff label={detail.target || detail.kind} before={text(detail.payload.before)} after={text(detail.payload.after)} />
                )}
                {c.status !== "discarded" && c.kind !== "restore" && !c.reverts && (
                  <button className="btn sm" disabled={busy === c.id} onClick={() => void revert(c)}>
                    {busy === c.id ? <span className="spin" /> : <Icon.Retry size={14} />} {c.status === "draft" ? "Drop this draft" : c.kind === "file.write" ? "Put the file back now" : "Revert (as a draft)"}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Diff({ label, before, after }: { label: string; before: string; after: string }) {
  const cut = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…" : s);
  return (
    <div className="sc-diff">
      <div className="sc-diff-label">{label}</div>
      <pre className="sc-before" aria-label="before">{cut(before) || "(empty)"}</pre>
      <pre className="sc-after" aria-label="after">{cut(after) || "(empty)"}</pre>
    </div>
  );
}
