import type { Resolved } from "../types";

/** What the plugin's element picker (widget.js) sends for the clicked element. */
export interface PickedElement {
  selector: string; label: string; tag: string; id: string; classes: string; text: string; html: string;
  image: { src: string; alt: string; selector?: string } | null; link: string; styles: Record<string, string>; rawText?: string; bgImage?: string;
  rect: { width: number; height: number }; section: string; pageUrl: string; viewport: number;
  pageKey?: string; elementor?: { post: number; id: string; widget: string } | null; hasChildren?: boolean;
  block?: string; menuItem?: number; similarSelector?: string; similarCount?: number;
}

/**
 * Turns the selected element into context for the assistant.
 *
 * With the resolver's answer it also says where the element really comes from (a theme file, an ACF field, an
 * Elementor widget) and gives the exact change for each edit the element supports - so the assistant edits THIS
 * element by its target, instead of searching the page for something that looks like it and changing that.
 */
export function elementContext(el: PickedElement, resolved?: Resolved | null): string {
  const source = resolved?.source;
  const keep = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "text-align", "padding-top", "padding-bottom", "margin-top", "margin-bottom", "width", "max-width"];
  const styles = keep.map((k) => `${k}: ${el.styles[k]}`).join("; ");
  return [
    `SELECTED ELEMENT on ${el.pageUrl} (viewport ${el.viewport}px wide):`,
    source ? `- source: ${source.kind} ${source.label}${source.type ? ` (${source.type})` : ""}${source.where ? `, in ${source.where}` : ""}` : "",
    `- CSS selector: ${el.selector}${el.similarCount && el.similarCount > 1 ? ` (similar elements: ${el.similarSelector}, ${el.similarCount} on this page)` : ""}`,
    `- element: <${el.tag}${el.id ? ` id="${el.id}"` : ""}${el.classes ? ` class="${el.classes}"` : ""}>${el.section ? ` inside ${el.section}` : ""}`,
    el.elementor ? `- Elementor element ${el.elementor.id} (${el.elementor.widget}) on post ${el.elementor.post} → make_change el.setting target ${el.elementor.id}:<control>` : "",
    el.block ? `- block ${el.block} (post:path) → make_change block.* target ${el.block.split(":")[1]}` : "",
    el.menuItem ? `- menu link item ${el.menuItem}` : "",
    el.text ? `- text: "${el.text.slice(0, 200)}"` : "",
    el.image ? `- image: ${el.image.src}${el.image.alt ? ` (alt "${el.image.alt}")` : ""}` : "",
    el.link ? `- links to: ${el.link}` : "",
    `- current styles: ${styles}`,
    `- HTML (start): ${el.html.slice(0, 600)}`,
    exactEdits(resolved),
  ].filter(Boolean).join("\n");
}

/** The resolver's own changes for this element: kind + target, so the edit lands on it and nowhere else. */
function exactEdits(resolved?: Resolved | null): string {
  const edits = (resolved?.actions ?? []).filter((a) => a.input !== "ask" && a.change?.kind && a.change?.target).slice(0, 10);
  if (!edits.length) return "";
  const target = (c: Record<string, any>) => JSON.stringify({ kind: c.kind, target: c.target, ...(c.post ? { post: c.post } : {}) });
  return ["- exact edits for THIS element (use these targets; do not search the page for a lookalike):",
    ...edits.map((a) => `  · ${a.label}: make_change ${target(a.change)}`)].join("\n");
}
