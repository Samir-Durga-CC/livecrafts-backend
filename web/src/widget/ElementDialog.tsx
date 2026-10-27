import { useEffect, type ReactNode } from "react";
import { Icon } from "../icons";

/**
 * The element editor as a large dialog over the page - the same shell as the Section Gallery.
 *
 * In the narrow side panel the editor had about 400px for Content, Style, Layout, Visibility and Animation, so every
 * group was a cramped list and most of it sat below the fold. Like the gallery, it asks the plugin to widen the
 * panel (lc:wide, plugin 0.24+): the page dims and the panel becomes a large popup. An older plugin ignores the
 * message, and the dialog still fills the panel it has.
 *
 * It closes back to the narrow panel with Close, Escape, or "pick another element", because picking needs the page
 * clickable - the wide panel covers most of it.
 */
export function ElementDialog({ title, subtitle, post, onClose, children }: {
  title: string;
  subtitle?: string;
  post: (msg: Record<string, unknown>) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    post({ type: "lc:wide", on: true });
    return () => post({ type: "lc:wide", on: false });
  }, [post]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sg ep-dialog" role="dialog" aria-modal="true" aria-label={`Edit ${title}`}>
      <header className="sg-head">
        <span className="ep-dialog-icon"><Icon.Cursor size={15} /></span>
        <div className="ep-dialog-title">
          <b className="sg-title">{title}</b>
          {subtitle && <small>{subtitle}</small>}
        </div>
        <span className="grow" />
        <button type="button" className="btn ghost small" onClick={onClose}><Icon.Close size={15} /> Close</button>
      </header>
      <div className="ep-dialog-body">
        <div className="ep-dialog-inner">{children}</div>
      </div>
    </div>
  );
}
