import { safeShortcode, safeUrl } from "./engine.js";

/** How a component is built on a site. "html" is for classic / ACF-driven themes (and the Custom HTML block). */
export type Builder = "elementor" | "blocks" | "html";

export interface Slot {
  name: string;
  label: string;
  type: "text" | "textarea" | "url" | "image" | "select" | "shortcode" | "list";
  required?: boolean;
  max?: number;                 // characters
  choices?: string[];           // select
  fields?: Slot[];              // list: the fields of one row
  minItems?: number;
  maxItems?: number;
  help?: string;
}

export type Content = Record<string, any>;

/** Named CSS that goes into WordPress Additional CSS as one Livecrafts block (see css.block). */
export interface CssBlock { id: string; label: string; css: string }

/** What the site offers when a component is built. */
export interface BuildContext {
  /** Elementor widget names this site has (from site_profile). Empty = unknown: only widgets every Elementor has are used. */
  widgets: string[];
  /** Media Library images the content refers to (by attachment id), looked up before rendering. */
  media: Record<string, { url: string; alt: string }>;
}

export interface Rendered {
  builder: Builder;
  /** The change kind that places it: el.insert (value = ONE element as JSON) or block.insert (value = block markup). */
  kind: "el.insert" | "block.insert";
  value: string;
  css: CssBlock[];
  /** True when sample text was used where the person gave none: it must be replaced before the page goes live. */
  placeholders: boolean;
  warnings: string[];
}

export interface LibraryComponent {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  slots: Slot[];
  /** Sample content (marked as placeholder when used). */
  sample(): Content;
  /** Component-specific CSS (the shared core CSS is separate). */
  css: string;
  /** Add computed fields (links, layout modifiers) after validation. */
  prepare(content: Content): Content;
  /** True while the content still contains the sample text (it must be replaced before the page goes live). */
  isPlaceholder(content: Content): boolean;
  /** PHP for template variables the library computes (they are not ACF fields): variable name -> PHP code. */
  php?: Record<string, string>;
  /** Templates in the engine's syntax. html also feeds the ACF partial. */
  html: string;
  blocks: string;
  /** ONE Elementor element (nested containers + free widgets). Settings use only controls every Elementor has. */
  elementor(content: Content, ctx: BuildContext): Record<string, any>;
}

export class ContentError extends Error {}

const clean = (s: unknown) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();

/**
 * Check the content against the slots: right types, lengths, required fields, safe addresses. Returns the cleaned
 * content. Throws ContentError with a message the model can act on.
 */
export function validateContent(slots: Slot[], input: Content, path = ""): Content {
  const out: Content = {};
  for (const s of slots) {
    const at = path + s.name;
    const raw = input?.[s.name];
    if (s.type === "list") {
      const rows = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : null;
      if (rows === null) throw new ContentError(`${at} must be a list.`);
      if (s.required && !rows.length) throw new ContentError(`${at}: at least ${s.minItems ?? 1} item is needed.`);
      if (s.minItems && rows.length && rows.length < s.minItems) throw new ContentError(`${at}: at least ${s.minItems} items.`);
      if (s.maxItems && rows.length > s.maxItems) throw new ContentError(`${at}: at most ${s.maxItems} items (got ${rows.length}).`);
      out[s.name] = rows.map((r: Content, i: number) => validateContent(s.fields ?? [], r ?? {}, `${at}[${i + 1}].`));
      continue;
    }
    const v = clean(raw);
    if (!v) { if (s.required) throw new ContentError(`${at} is required.`); out[s.name] = ""; continue; }
    if (s.max && v.length > s.max) throw new ContentError(`${at} is too long (${v.length} characters, max ${s.max}). Shorten it.`);
    if (s.type === "image") {
      if (!/^\d{1,9}$/.test(v)) throw new ContentError(`${at} must be the id of an image in the Media Library (upload it first with upload_media_from_chat or upload_media_from_url).`);
      out[s.name] = v;
    } else if (s.type === "url") {
      const u = safeUrl(v);
      if (!u) throw new ContentError(`${at} must be an http(s) address, mailto:, tel:, a /path or #anchor.`);
      out[s.name] = u;
    } else if (s.type === "shortcode") {
      const sc = safeShortcode(v);
      if (!sc) throw new ContentError(`${at} must be ONE shortcode such as [contact-form-7 id="12"].`);
      out[s.name] = sc;
    } else if (s.type === "select") {
      if (!s.choices?.includes(v)) throw new ContentError(`${at} must be one of: ${s.choices?.join(", ")}.`);
      out[s.name] = v;
    } else out[s.name] = v;
  }
  return out;
}
