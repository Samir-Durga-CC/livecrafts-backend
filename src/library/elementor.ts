import { escapeHtml } from "./engine.js";

/**
 * Builders for Elementor elements, restricted on purpose to what EVERY Elementor install has (flexbox containers and
 * the free widgets heading, text-editor, image, button, shortcode) and to the controls the Livecrafts plugin can
 * validate (select, text, wysiwyg, url, media). All looks come from the library's core CSS through CSS classes, so an
 * editor can still change every text, link and image in Elementor, and no Elementor style setting fights the CSS.
 * Ids are left out: the plugin gives every new element a fresh id.
 */
export type ElNode = { elType: "container" | "widget"; widgetType?: string; settings: Record<string, any>; elements: ElNode[] };

export const container = (classes: string, elements: ElNode[], settings: Record<string, any> = {}): ElNode => ({
  elType: "container", settings: { content_width: "full", flex_direction: "column", _css_classes: classes, ...settings }, elements,
});

const widget = (widgetType: string, settings: Record<string, any>): ElNode => ({ elType: "widget", widgetType, settings, elements: [] });

/** size: h1..h6, div, span or p (the HTML tag Elementor prints). */
export const heading = (text: string, size: "h2" | "h3" | "div" | "p", classes: string) => widget("heading", { title: text, header_size: size, _css_classes: classes });

export const textEditor = (html: string, classes: string) => widget("text-editor", { editor: html, _css_classes: classes });

export const paragraph = (text: string, classes: string) => textEditor(`<p>${escapeHtml(text)}</p>`, classes);

export const button = (text: string, url: string, classes = "lc-btn-wrap") => widget("button", { text, link: { url }, _css_classes: classes });

export const image = (attachmentId: number, classes: string) => widget("image", { image: { id: attachmentId }, _css_classes: classes });

export const shortcode = (code: string, classes: string) => widget("shortcode", { shortcode: code, _css_classes: classes });

/** True when every element obeys Elementor's nesting rule (containers hold containers and widgets; widgets hold nothing). */
export function nestingOk(n: ElNode): boolean {
  if (n.elType === "widget") return !n.elements.length && !!n.widgetType;
  return n.elements.every(nestingOk);
}
