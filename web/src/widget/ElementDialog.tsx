import { useEffect, type ReactNode } from "react";
import { Icon } from "../icons";

/**
 * The element editor in the large centred view - the same shell as the Section Gallery's.
 *
 * The editor opens in the side panel, as it always did; the expand icon brings it here, where it has the room for
 * Content, Style, Layout, Visibility and Animation side by side. Like the gallery, it asks the plugin to widen the
 * panel (lc:wide, plugin 0.24+): the page dims and the panel becomes a large popup. An older plugin ignores the
 * message, and the editor still fills the panel it has.
 *
 * Collapse goes back to the side panel with the same element; Close (or Escape) lets go of the element.
 */
export function ElementDialog({ title, subtitle, post, onCollapse, onClose, children }: {
  title: string;
  subtitle?: string;
  post: (msg: Record<string, unknown>) => void;
  onCollapse: () => void;
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
        <button type="button" className="w-icon" title="Back to the side panel" aria-label="Collapse" onClick={onCollapse}><Icon.Collapse size={16} /></button>
        <button type="button" className="btn ghost small" onClick={onClose}><Icon.Close size={15} /> Close</button>
      </header>
      <div className="ep-dialog-body">
        <div className="ep-dialog-inner">{children}</div>
      </div>
    </div>
  );
}
