import { useEffect, useRef, useState } from "react";
import { fileUrl } from "../api";
import { Icon } from "../icons";
import type { TimelineItem } from "../types";
import { toBlocks, type ToolItem } from "../util";
import { Markdown } from "./Markdown";

const DOING: Record<string, string> = {
  get_page_map: "Reading the page", read_target: "Checking a stored value", find_text: "Searching the database",
  set_content: "Updating content", verify_page: "Verifying the live page", upload_media_from_chat: "Uploading the image",
  undo_last_change: "Undoing the last change", list_pages: "Listing pages",
  inspect_element: "Inspecting the element in a browser", screenshot_page: "Taking a screenshot", list_files: "Listing theme files",
  read_file: "Reading a theme file", edit_file: "Editing the theme file", restore_file: "Restoring the file",
  hostinger_read: "Checking the hosting account", hostinger_search: "Looking up hosting actions",
  find_posts: "Looking up pages", read_post: "Reading the page content", create_page: "Creating the page", create_post: "Creating the post",
  edit_post_content: "Editing the page content", set_post_status: "Changing the page status", get_menus: "Reading the menus",
  create_menu: "Creating the menu", add_menu_item: "Adding the menu link", upload_media_from_url: "Importing the image",
  view_image: "Looking at the image", create_file: "Creating a theme file", load_skill: "Reading WordPress guidelines",
  list_changes: "Checking the changes", revert_change: "Reverting a change", propose_plan: "Preparing the plan",
};
const DONE: Record<string, string> = {
  get_page_map: "Read the page", read_target: "Checked a stored value", find_text: "Searched the database",
  set_content: "Updated content", verify_page: "Verified the live page", upload_media_from_chat: "Uploaded the image",
  undo_last_change: "Undid the last change", list_pages: "Listed the pages",
  inspect_element: "Inspected the element", screenshot_page: "Took a screenshot", list_files: "Listed theme files",
  read_file: "Read a theme file", edit_file: "Edited the theme file", restore_file: "Restored the file",
  hostinger_read: "Checked the hosting account", hostinger_search: "Looked up hosting actions",
  find_posts: "Looked up pages", read_post: "Read the page content", create_page: "Created the page", create_post: "Created the post",
  edit_post_content: "Edited the page content", set_post_status: "Changed the page status", get_menus: "Read the menus",
  create_menu: "Created the menu", add_menu_item: "Added the menu link", upload_media_from_url: "Imported the image",
  view_image: "Looked at the image", create_file: "Created a theme file", load_skill: "Read WordPress guidelines",
  list_changes: "Checked the changes", revert_change: "Reverted a change", propose_plan: "Plan approved",
};

export function Thumb({ id, size = 56 }: { id: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => { fileUrl(id).then(setSrc).catch(() => setSrc("")); }, [id]);
  return src ? <img className="thumb" style={{ width: size, height: size }} src={src} alt="attachment" /> : <div className="thumb ph" style={{ width: size, height: size }} />;
}

/** A screenshot the agent took to check its work: a small chip; the picture only loads when the person asks for it. */
function Shot({ id, caption }: { id: string; caption: string }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState("");
  useEffect(() => { if (open && !src) fileUrl(id).then(setSrc).catch(() => setSrc("")); }, [id, open, src]);
  if (!open) return <button className="shot-chip" onClick={() => setOpen(true)} title={caption}><Icon.Eye size={13} /> View screenshot</button>;
  return (
    <figure className="shot">
      {src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={caption} /></a> : <div className="shot-ph" />}
      <figcaption><Icon.Eye size={13} /> {caption}</figcaption>
    </figure>
  );
}

const DEVICE_NAME: Record<string, string> = { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" };
function shotCaption(ui: Record<string, any>) {
  const where = ui.target && ui.target !== "page" ? ui.target : "the page";
  return `Live screenshot of ${where} · ${DEVICE_NAME[ui.device] ?? ui.device ?? "Desktop"}`;
}

/** One quiet line that summarises what the assistant did ("Read the page · Updated content"), expandable for details. */
function Activity({ items, onOpen }: { items: ToolItem[]; onOpen?: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const running = items.find((i) => i.state === "running");
  const failed = items.filter((i) => i.state === "failed").length;
  const labels = [...new Set(items.filter((i) => i.state !== "running").map((i) => DONE[i.tool] ?? i.tool))];
  const shots = items.filter((i) => i.tool === "screenshot_page" && i.ui?.screenshotId);
  const files = items.filter((i) => (i.tool === "edit_file" || i.tool === "restore_file" || i.tool === "create_file") && i.state === "ok" && i.ui?.path);
  const pages = items.filter((i) => (i.tool === "create_page" || i.tool === "create_post" || i.tool === "edit_post_content" || i.tool === "set_post_status") && i.state === "ok" && i.ui?.link);
  return (
    <div className={`activity ${running ? "live" : ""} ${failed ? "has-fail" : ""}`}>
      <button className="act-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="act-ico">{running ? <span className="spin" /> : failed ? <Icon.Close size={13} /> : <Icon.Check size={13} />}</span>
        <span className="act-text">
          {running ? <span className="shimmer">{DOING[running.tool] ?? running.tool}…</span> : labels.join(" · ")}
          {failed > 0 && <span className="act-fail"> · {failed} failed</span>}
        </span>
        <Icon.ChevronDown size={14} className={`act-chev ${open ? "up" : ""}`} />
      </button>
      {open && (
        <div className="act-list">
          {items.map((it) => (
            <details key={it.seq} className={`act-step ${it.state}`}>
              <summary>
                <span className="act-dot" />{it.state === "running" ? DOING[it.tool] : DONE[it.tool] ?? it.tool}
                {it.state === "failed" && it.error && <span className="act-err"> — {it.error}</span>}
              </summary>
              <pre>{JSON.stringify(it.input ?? {}, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
      {files.map((f) => (
        <div key={f.seq} className="file-done">
          <Icon.Code size={14} /> <code>{f.ui!.path}</code>
          {f.tool === "edit_file" && <span className={`fd-badge ${f.ui!.verifiedLive ? "ok" : "warn"}`}>{f.ui!.verifiedLive ? "Live on the site" : "Saved, not yet visible (cache)"}</span>}
          {f.tool === "restore_file" && <span className="fd-badge ok">Original restored</span>}
          {f.tool === "create_file" && <span className="fd-badge ok">New file</span>}
          {f.ui!.backupId && <span className="fd-backup" title="Ask “restore the file” to undo this edit">backup {String(f.ui!.backupId)}</span>}
        </div>
      ))}
      {pages.map((p) => (
        <div key={p.seq} className="file-done">
          <Icon.Page size={14} /> <a href={p.ui!.link} target="_blank" rel="noreferrer">{String(p.ui!.link).replace(/^https?:\/\/[^/]+/, "") || "/"}</a>
          <span className="fd-badge ok">{p.tool === "create_page" ? "Page created" : p.tool === "create_post" ? "Post created" : "Updated"}{p.ui!.status && p.ui!.status !== "publish" ? ` · ${p.ui!.status}` : ""}</span>
          {onOpen && <button className="fd-link" onClick={() => onOpen(p.ui!.link)}>Show in preview</button>}
        </div>
      ))}
      {shots.map((s) => <Shot key={s.seq} id={String(s.ui!.screenshotId)} caption={shotCaption(s.ui!)} />)}
    </div>
  );
}

/** Long code in an approval card: first lines visible, the rest on demand. */
function Collapsible({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const lines = code.split("\n");
  const long = lines.length > 10;
  return (
    <div className="ap-codewrap">
      <pre className="ap-code">{open || !long ? code : lines.slice(0, 10).join("\n")}</pre>
      {long && <button className="fd-link" onClick={() => setOpen(!open)}>{open ? "Show less" : `Show all ${lines.length} lines`}</button>}
    </div>
  );
}

function Approval({ item, onAnswer, busy }: { item: Extract<TimelineItem, { kind: "approval" }>; onAnswer: (approved: boolean, reason?: string) => void; busy: boolean }) {
  const [note, setNote] = useState("");
  const [denying, setDenying] = useState(false);
  const i = item.input ?? {};
  const a = item.answer;
  const TITLES: Record<string, string> = {
    set_content: "Change content", upload_media_from_chat: "Upload image to the Media Library", undo_last_change: "Undo the last change",
    edit_file: "Edit a theme file", restore_file: "Restore a file from its backup", create_file: "Create a new theme file",
    create_page: "Create a new page", create_post: "Create a new blog post", edit_post_content: "Change page content",
    set_post_status: "Change page status", create_menu: "Create a navigation menu", add_menu_item: "Add a menu link",
    upload_media_from_url: "Import an image to the Media Library", revert_change: "Revert a change",
    propose_plan: "Plan for this request",
  };
  const title = TITLES[item.tool] ?? item.tool;
  const backup = item.current as { path?: string; editedAt?: string } | null | undefined;
  const empty = item.current === undefined || item.current === null || item.current === "";

  return (
    <div className={`approval ${a ? (a.approved ? "is-approved" : "is-denied") : "is-pending"}`}>
      <div className="ap-head">
        <span className="ap-ico">{a ? (a.approved ? <Icon.Check size={15} /> : <Icon.Close size={15} />) : <Icon.Shield size={15} />}</span>
        <div className="ap-titles">
          <div className="ap-title">{title}</div>
          {i.reason && <div className="ap-sub">{i.reason}</div>}
        </div>
        <span className="ap-status">{a ? (a.approved ? "Approved" : "Denied") : "Needs approval"}</span>
      </div>

      {item.tool === "set_content" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">Field</span><code className="ap-target">{i.target}</code></div>
          <div className="ap-row before"><span className="ap-label">Before</span><span className="ap-val">{empty ? <em>empty</em> : String(item.current)}</span></div>
          <div className="ap-row after"><span className="ap-label">After</span><span className="ap-val">{String(i.value ?? "")}</span></div>
        </div>
      )}
      {item.tool === "upload_media_from_chat" && (
        <div className="ap-body ap-upload"><Thumb id={String(i.fileId)} size={84} /><div><div className="ap-val">{i.title || "Image"}</div><code className="ap-target">{i.fileId}</code></div></div>
      )}
      {item.tool === "undo_last_change" && <div className="ap-body"><div className="ap-val">Restore the previous value on page #{i.postId}.</div></div>}
      {item.tool === "edit_file" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">File</span><code className="ap-target">{i.path}</code></div>
          <div className="ap-row before"><span className="ap-label">Before</span><Collapsible code={String(i.find ?? "")} /></div>
          <div className="ap-row after"><span className="ap-label">After</span><Collapsible code={String(i.replace ?? "")} /></div>
          <div className="ap-row"><span className="ap-label">Safety</span><span className="ap-target">A backup is kept. If the page breaks after saving, the original file is put back automatically.</span></div>
        </div>
      )}
      {item.tool === "propose_plan" && (
        <div className="ap-body ap-plan">
          <div className="ap-plan-sum">{i.summary}</div>
          <ol>{(i.steps ?? []).map((st: string, n: number) => <li key={n}>{st}</li>)}</ol>
          <div className="ap-plan-note">One approval runs all steps. Every change is checked afterwards and the whole request can be reverted.</div>
        </div>
      )}
      {(item.tool === "create_page" || item.tool === "create_post") && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">Title</span><span className="ap-val">{i.title}</span></div>
          <div className="ap-row"><span className="ap-label">Status</span><span className="ap-val">{i.status === "draft" ? "Draft (only you can see it)" : "Published (visible to everyone)"}{i.slug ? ` · /${i.slug}/` : ""}</span></div>
          <div className="ap-row after"><span className="ap-label">Content</span><Collapsible code={String(i.content ?? "")} /></div>
        </div>
      )}
      {item.tool === "edit_post_content" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">Page</span><code className="ap-target">{i.type === "posts" ? "post" : "page"} #{i.id}</code></div>
          <div className="ap-row before"><span className="ap-label">Before</span><Collapsible code={String(i.find ?? "")} /></div>
          <div className="ap-row after"><span className="ap-label">After</span><Collapsible code={String(i.replace ?? "")} /></div>
        </div>
      )}
      {item.tool === "set_post_status" && <div className="ap-body"><div className="ap-row"><span className="ap-label">Page</span><span className="ap-val">{i.type === "posts" ? "Post" : "Page"} #{i.id} → <b>{i.status}</b></span></div></div>}
      {item.tool === "create_menu" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">Menu</span><span className="ap-val">{i.name} · shown in “{i.location}”</span></div>
          <div className="ap-row after"><span className="ap-label">Links</span><span className="ap-val">{(i.items ?? []).map((x: any, n: number) => <span key={n} className="ap-chip">{x.title}</span>)}</span></div>
        </div>
      )}
      {item.tool === "add_menu_item" && (
        <div className="ap-body">
          <div className="ap-row after"><span className="ap-label">Link</span><span className="ap-val">{i.title} <span className="ap-target">→ {i.url ?? `page #${i.pageId}`}</span></span></div>
          <div className="ap-row"><span className="ap-label">Menu</span><span className="ap-val">#{i.menuId}{i.position ? ` · position ${i.position}` : " · at the end"}</span></div>
        </div>
      )}
      {item.tool === "upload_media_from_url" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">From</span><a className="ap-target" href={i.url} target="_blank" rel="noreferrer">{i.url}</a></div>
          <div className="ap-row"><span className="ap-label">Alt text</span><span className="ap-val">{i.alt}</span></div>
        </div>
      )}
      {item.tool === "create_file" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">New file</span><code className="ap-target">{i.path}</code></div>
          <div className="ap-row after"><span className="ap-label">Content</span><Collapsible code={String(i.content ?? "")} /></div>
          <div className="ap-row"><span className="ap-label">Safety</span><span className="ap-target">PHP is syntax-checked before saving. Reverting deletes the file.</span></div>
        </div>
      )}
      {item.tool === "revert_change" && (
        <div className="ap-body"><div className="ap-row"><span className="ap-label">Undo</span><span className="ap-val">{(backup as any)?.title ?? i.changeId}</span></div></div>
      )}
      {item.tool === "restore_file" && (
        <div className="ap-body">
          <div className="ap-row"><span className="ap-label">File</span><code className="ap-target">{backup?.path ?? "unknown backup"}</code></div>
          <div className="ap-row"><span className="ap-label">Back to</span><span className="ap-val">The version from before the edit{backup?.editedAt ? ` (${new Date(backup.editedAt).toLocaleString()})` : ""}</span></div>
        </div>
      )}

      {!a ? (
        <div className="ap-actions">
          {denying
            ? <input className="ap-note" autoFocus placeholder="Why not? (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onAnswer(false, note || undefined); }} />
            : <span className="ap-hint">Nothing changes on your site until you approve.</span>}
          <button className="btn ghost" disabled={busy} onClick={() => (denying ? onAnswer(false, note || undefined) : setDenying(true))}>{denying ? "Confirm deny" : "Deny"}</button>
          <button className="btn primary" disabled={busy} onClick={() => onAnswer(true)}><Icon.Check size={15} /> {item.tool === "propose_plan" ? "Approve & run" : "Approve"}</button>
        </div>
      ) : a.reason && <div className="ap-reason">“{a.reason}”</div>}
    </div>
  );
}

export function Transcript({ items, model, busy, working, welcome, onAnswer, onCopy, onEdit, onRetry, onOpen }: {
  items: TimelineItem[]; model: string; busy: boolean; working: boolean; welcome: React.ReactNode; onOpen?: (url: string) => void;
  onAnswer: (approvalId: string, approved: boolean, reason?: string) => void;
  onCopy: (text: string) => void; onEdit: (text: string) => void; onRetry: (text: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the stream only while the reader is at the bottom
  const blocks = toBlocks(items);
  const last = items[items.length - 1];
  const lastUser = [...items].reverse().find((i) => i.kind === "user");
  const toolRunning = items.some((i) => i.kind === "tool" && i.state === "running");
  // "Thinking" only while the model is busy and nothing new is on screen yet (no text streaming, no step running).
  const thinking = working && !toolRunning && last?.kind !== "assistant";
  const size = items.reduce((n, i) => n + (i.kind === "assistant" ? i.text.length : 1), 0);

  // Jump instantly: with smooth scrolling the scroll events fired mid-animation look like "the reader scrolled up".
  const toBottom = (el: HTMLElement) => el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior });
  useEffect(() => { const el = scroller.current; if (el && stick.current) toBottom(el); }, [size, thinking]);
  // Content can grow after render (screenshots, images loading) - keep the newest message in view.
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current, box = inner.current;
    if (!el || !box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(el); });
    ro.observe(box);
    return () => ro.disconnect();
  }, [items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return <div className="transcript empty">{welcome}</div>;
  return (
    <div className="transcript" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="transcript-inner" ref={inner}>
        {blocks.map((b, idx) => {
          switch (b.kind) {
            case "user":
              return (
                <div key={b.key} className="turn user">
                  {b.item.fileIds.length > 0 && <div className="attach-row">{b.item.fileIds.map((f) => <Thumb key={f} id={f} size={120} />)}</div>}
                  <div className="u-bubble">{b.item.text}</div>
                  <div className="row-actions">
                    <button title="Copy" onClick={() => onCopy(b.item.text)}><Icon.Copy size={14} /></button>
                    <button title="Edit and resend" onClick={() => onEdit(b.item.text)}><Icon.Edit size={14} /></button>
                  </div>
                </div>
              );
            case "assistant":
              return (
                <div key={b.key} className="turn bot">
                  <Markdown text={b.item.text} streaming={b.item.streaming} />
                  {!b.item.streaming && (
                    <div className="row-actions bot-actions">
                      <button title="Copy" onClick={() => onCopy(b.item.text)}><Icon.Copy size={14} /></button>
                      {lastUser?.kind === "user" && idx === blocks.length - 1 && !working && <button title="Ask again" onClick={() => onRetry(lastUser.text)}><Icon.Retry size={14} /></button>}
                      <span className="b-model">{model}</span>
                    </div>
                  )}
                </div>
              );
            case "steps": return <Activity key={b.key} items={b.items} onOpen={onOpen} />;
            case "approval": return <Approval key={b.key} item={b.item} busy={busy} onAnswer={(a, r) => onAnswer(b.item.approvalId, a, r)} />;
            case "error": return <div key={b.key} className="banner error">{b.item.text}</div>;
          }
        })}
        {thinking && <div className="thinking"><span className="dots"><i /><i /><i /></span><span className="shimmer">Thinking</span></div>}
      </div>
    </div>
  );
}
