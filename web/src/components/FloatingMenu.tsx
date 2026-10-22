import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * A menu that opens OUTSIDE its own toolbar.
 *
 * WHAT WAS WRONG. These menus were absolutely positioned inside the composer's button row, and that row scrolls
 * sideways in the narrow panel (`.embed .c-bar { overflow-x: auto }`). An element with overflow clips every
 * absolutely positioned descendant, so the menu was drawn and then cut off by the strip it lived in - about
 * thirty pixels tall, behind the buttons. It looked like the dropdown did nothing.
 *
 * Nothing positioned inside that row can escape it, so this one is not inside it: it is rendered into
 * document.body through a portal, and placed with `fixed` against the button's position on screen. It opens
 * UPWARDS, above the button, because the composer sits at the bottom of a short panel and there is never room
 * below - and it flips down only when there is genuinely more space that way.
 *
 * It follows the button while it is open (scrolling the chat, resizing the panel), closes on Escape, on a click
 * anywhere else, and when the page behind it scrolls the button out of view.
 */
export function FloatingMenu({ anchor, open, onClose, className = "", children, align = "right", gap = 8 }: {
  /** The button this hangs off. */
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
  /** Which edge lines up with the button's. */
  align?: "left" | "right";
  gap?: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);

  // Measured after layout and before paint, so it never appears in the wrong place for a frame.
  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const place = () => {
      const a = anchor.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const h = card.current?.offsetHeight ?? 0;
      const w = card.current?.offsetWidth ?? 0;
      const above = r.top - gap - h;
      const below = r.bottom + gap;
      // Above unless there is no room for it there and more room underneath.
      const top = above >= 8 || r.top > window.innerHeight - r.bottom ? Math.max(8, above) : below;
      const wanted = align === "right" ? r.right - w : r.left;
      const left = Math.min(Math.max(8, wanted), Math.max(8, window.innerWidth - w - 8));
      setAt({ top, left, width: r.width });
    };
    place();
    // While it is open the button can move under it: the chat streams in behind, the panel is resized.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (card.current) ro?.observe(card.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { ro?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, anchor, align, gap]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <>
      {/* Catches the click that closes it. mousedown, not click: a button underneath must not also fire. */}
      <div className="fm-scrim" onMouseDown={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={card} className={`fm-card ${className}`} role="menu"
        style={{ top: at?.top ?? -9999, left: at?.left ?? -9999, visibility: at ? "visible" : "hidden" }}>
        {children}
      </div>
    </>,
    document.body,
  );
}
