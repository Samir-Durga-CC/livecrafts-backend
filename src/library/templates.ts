import { container, shortcode, type ElNode } from "./elementor.js";
import { contrast } from "./index.js";

/**
 * The site's template library (the "AI Components" templates shipped inside the Livecrafts plugin, 0.14+).
 * The assistant never writes their markup: it picks a template, gives it content (attributes + list items) and a "fit"
 * measured from the site, and Livecrafts places ONE shortcode. These functions are pure (no network) so they are tested alone.
 */

/** One template as the plugin reports it (GET /livecrafts/v1/templates). */
export interface TemplateEntry {
  id: string;
  shortcode: string;
  title: string;
  params: string;
  example: string;
  attributes: string[];
  defaults: Record<string, unknown>;
  list: boolean;
  item_fields: string;
  usedOn?: Array<{ post: number; title: string; url: string; status: string; count: number; in: string[] }>;
  renderedAt?: Array<{ path: string; last: string }>;
}

/** Fit keys the templates understand (CSS variables). */
export const FIT_KEYS = ["brand", "surface", "surface_alt", "ink", "muted", "line", "max", "py", "py_sm", "radius", "font"] as const;
export type FitKey = (typeof FIT_KEYS)[number];
export type Fit = Partial<Record<FitKey, string>>;

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|rgba|hsl|hsla|oklch)\([0-9a-z\s.,%/-]+\)|var\(--[a-z0-9-]+\))$/i;
const LENGTH = /^(-?\d*\.?\d+(?:px|rem|em|%|vw|vh|ch)?|(?:clamp|min|max|calc)\([0-9a-z\s.,%+*/()-]+\)|var\(--[a-z0-9-]+\))$/i;
const FONT = /^[a-z0-9 ,_-]+$/i;
const KIND: Record<FitKey, RegExp> = { brand: COLOR, surface: COLOR, surface_alt: COLOR, ink: COLOR, muted: COLOR, line: COLOR, max: LENGTH, py: LENGTH, py_sm: LENGTH, radius: LENGTH, font: FONT };

export class TemplateError extends Error {}

/** Keep only fit values the plugin will accept; report the ones dropped. */
export function cleanFit(input: Record<string, unknown> | undefined): { fit: Fit; dropped: string[] } {
  const fit: Fit = {}, dropped: string[] = [];
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (!(FIT_KEYS as readonly string[]).includes(k)) { dropped.push(`${k} (unknown fit setting; allowed: ${FIT_KEYS.join(", ")})`); continue; }
    const s = String(v).trim();
    if (!KIND[k as FitKey].test(s)) { dropped.push(`${k}="${s.slice(0, 40)}" (not a plain colour / length)`); continue; }
    fit[k as FitKey] = s;
  }
  return { fit, dropped };
}

/** Text safe inside a shortcode attribute: no quotes, brackets or line breaks (they would end the shortcode early). */
export function attrText(v: unknown, max = 500): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f]+/g, " ").replace(/"/g, "”").replace(/\[/g, "(").replace(/\]/g, ")")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

const nameOk = (s: string) => /^[a-z][a-z0-9_]{0,40}$/.test(s);
const attrs = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && String(v) !== "").map(([k, v]) => ` ${k}="${attrText(v)}"`).join("");

export interface ShortcodeInput {
  /** Template attributes: heading, text, primary_label ... (see get_component). */
  attrs?: Record<string, unknown>;
  /** Rows of a list template (faq, pricing, testimonials ...). Every row is an object of short text fields. */
  items?: Array<Record<string, unknown>>;
  fit?: Fit;
}

/** The ONE shortcode that places a template. Throws TemplateError with a message the model can act on. */
/**
 * What a template prints for itself, and what it expects of the content it is given.
 *
 * The docblock says this in prose (entry.params, entry.example), which is easy to skim past: a footer that prints "©"
 * itself, handed "© 2026 Acme", shows two; a columns footer handed every link in one group renders one column and
 * three empty gaps. Both happened. So the rules are stated as rules - returned by get_component, and checked here,
 * because a rule nobody checks is a rule that gets broken.
 */
const PRINTS = [{ attr: /copyright/i, strip: /^\s*(?:&copy;|©|\(c\))\s*/i, adds: "©" }];

export function templateRules(entry: TemplateEntry): string[] {
  const rules: string[] = [];
  for (const p of PRINTS) {
    for (const attr of entry.attributes.filter((x) => p.attr.test(x))) {
      rules.push(`"${attr}": the template prints ${p.adds} itself - pass the text without it ("2026 Acme", not "${p.adds} 2026 Acme").`);
    }
  }
  if (entry.list && /\bgroup\b/.test(entry.item_fields ?? "")) {
    rules.push('Every row takes a "group", and the template lays out ONE COLUMN PER GROUP. Use 2-4 different groups ("Company", "Product", "Legal"); every row in one group renders a single column and leaves the rest of the row empty.');
  }
  if (entry.list && entry.item_fields) rules.push(`Row fields: ${entry.item_fields}.`);
  return rules;
}

export function buildShortcode(entry: TemplateEntry, input: ShortcodeInput): { code: string; warnings: string[] } {
  const warnings: string[] = [];
  const allowed = new Set(entry.attributes);
  const a: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.attrs ?? {})) {
    if (!nameOk(k)) throw new TemplateError(`"${k}" is not a valid attribute name.`);
    if (!allowed.has(k)) throw new TemplateError(`The ${entry.id} template has no attribute "${k}". It takes: ${entry.attributes.join(", ") || "(none)"}.`);
    if (v !== null && typeof v === "object") throw new TemplateError(`Attribute "${k}" must be plain text (list rows go in "items").`);
    a[k] = v;
  }
  for (const [k, v] of Object.entries(input.fit ?? {})) a[k] = v;
  // The template already prints these: passing them in as well shows them twice.
  for (const p of PRINTS) {
    for (const k of Object.keys(a)) {
      if (!p.attr.test(k) || typeof a[k] !== "string") continue;
      const cleaned = (a[k] as string).replace(p.strip, "");
      if (cleaned === a[k]) continue;
      a[k] = cleaned;
      warnings.push(`"${k}": the ${entry.id} template prints ${p.adds} itself, so it was taken off the text you passed - it would have shown twice.`);
    }
  }
  const rows = input.items ?? [];
  if (rows.length && !entry.list) throw new TemplateError(`The ${entry.id} template has no list rows; remove "items".`);
  if (entry.list && !rows.length) warnings.push(`The ${entry.id} template shows a list: without "items" it renders only its heading.`);
  if (rows.length > 24) throw new TemplateError("A template takes at most 24 list rows.");
  // One column per group: all the rows in one group is a section with one column and an empty row beside it.
  if (entry.list && /\bgroup\b/.test(entry.item_fields ?? "") && rows.length >= 3) {
    const groups = new Set(rows.map((r) => String((r as Record<string, unknown>).group ?? "").trim().toLowerCase()));
    if (groups.size <= 1) {
      warnings.push(`All ${rows.length} rows are in ${groups.has("") ? "no group" : "one group"}. This template lays out one column per group, so it will render a single column with the rest of the row empty. Give the rows 2-4 different "group" values, or place fewer rows.`);
    }
  }

  const open = `[${entry.shortcode}${attrs(a)}]`;
  if (!entry.list) return { code: open, warnings };
  const inner = rows.map((r, i) => {
    for (const k of Object.keys(r)) if (!nameOk(k)) throw new TemplateError(`Row ${i + 1}: "${k}" is not a valid field name.`);
    return `[ai_item${attrs(r)}]`;
  }).join("");
  return { code: `${open}${inner}[/${entry.shortcode}]`, warnings };
}

/** The shortcode in the way the page's builder holds it. */
export function placeShortcode(code: string, builder: "elementor" | "blocks" | "html", templateId: string): { kind: "el.insert" | "block.insert"; value: ElNode | string } {
  if (builder === "elementor") return { kind: "el.insert", value: container(`lc-tpl lc-tpl-${templateId}`, [shortcode(code, "")]) };
  return { kind: "block.insert", value: `<!-- wp:shortcode -->\n${code}\n<!-- /wp:shortcode -->` };
}

/**
 * Pages the THEME builds (front-page.php and friends) never print the page body, so a section saved in the page would
 * not appear. The plugin renders sections at the seams of the theme's own template instead - no theme file is touched.
 * The place is one of the page map's sections.places ("before:template-parts/why", "after:...", "start", "end").
 */
export const placeInTheme = (code: string, place: string) => ({ kind: "theme.section" as const, target: place, value: code });

/** "theme:before:template-parts/why" -> "before:template-parts/why" (the position syntax place_component takes). */
export function themePlace(position?: string): string | null {
  const m = /^theme:(.+)$/.exec((position ?? "").trim());
  if (!m) return null;
  const place = m[1].trim().toLowerCase();
  return /^(start|end|(before|after):[a-z0-9/_-]{1,80})$/.test(place) ? place : null;
}

/** Elementor's flexbox container has default padding/gap; a template brings its own spacing, so the wrapper must add none. */
export const TEMPLATE_WRAP_CSS = { id: "lc-tpl", label: "Template wrapper (no extra spacing)", css: ".lc-tpl.e-con{--padding-top:0px;--padding-right:0px;--padding-bottom:0px;--padding-left:0px;--gap:0px;--row-gap:0px;--column-gap:0px;}\n.lc-tpl .elementor-widget-shortcode,.lc-tpl .elementor-shortcode{width:100%;}" };

/* ------------------------------------------------------------------ fit from the measured site */

export interface SectionSample { tag?: string; width: number; height: number; paddingTop: number; paddingBottom: number; contentWidth: number }

/** What analyze_design reports (only the parts used here). */
export interface DesignLike {
  containerMaxWidth?: string | null;
  layout?: { sections?: SectionSample[]; typicalContentWidth?: number | null; typicalPaddingY?: number | null; typicalSectionHeight?: number | null };
  button?: { background?: string; radius?: string } | null;
  radii?: Array<{ value: string }>;
  pageBackground?: string | null;
  pageColor?: string | null;
  sectionSpacing?: Array<{ value: string }>;
}

const toHex = (c?: string | null): string | null => {
  if (!c) return null;
  const m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
  if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
  if (m[4] !== undefined && Number(m[4]) < 0.5) return null;
  return "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
};
const px = (v?: string | null) => { const m = String(v ?? "").match(/^([\d.]+)px$/); return m ? Number(m[1]) : null; };
const median = (n: number[]) => { const s = [...n].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const isGrey = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return Math.max(r, g, b) - Math.min(r, g, b) < 24; };

export interface FitResult { fit: Fit; basis: string[] }

/**
 * Turn the measured design into template settings: the content width and vertical padding of the site's own sections
 * (their median, so one odd banner does not decide), its corner radius, the colour of its buttons as brand, and the page
 * background and text colour (only when they read well together).
 */
export function fitFromDesign(d: DesignLike | null | undefined): FitResult {
  const fit: Fit = {}, basis: string[] = [];
  if (!d) return { fit, basis: ["the site could not be measured: templates use their neutral defaults"] };
  const n = d.layout?.sections?.length ?? 0;

  const width = d.layout?.typicalContentWidth ?? px(d.containerMaxWidth);
  if (width && width >= 600 && width <= 1800) { fit.max = `${Math.round(width)}px`; basis.push(`content width ${Math.round(width)}px (${d.layout?.typicalContentWidth ? `median of ${n} sections` : "the site's container"})`); }

  const pad = d.layout?.typicalPaddingY ?? median((d.sectionSpacing ?? []).map((s) => px(s.value)).filter((x): x is number => x !== null && x > 0));
  if (pad && pad >= 16 && pad <= 240) {
    fit.py = `${Math.round(pad)}px`;
    fit.py_sm = `${Math.max(32, Math.round(pad * 0.6))}px`;
    basis.push(`section padding ${Math.round(pad)}px on desktop, ${fit.py_sm} on mobile`);
  }

  const radius = px(d.button?.radius) ?? px(d.radii?.[0]?.value);
  if (radius !== null && radius !== undefined) { const r = Math.min(Math.max(radius, 0), 32); fit.radius = `${r}px`; basis.push(`corner radius ${r}px`); }

  const brand = toHex(d.button?.background);
  if (brand && !isGrey(brand)) { fit.brand = brand; basis.push(`brand colour ${brand} (the site's buttons)`); }

  const bg = toHex(d.pageBackground), ink = toHex(d.pageColor);
  if (bg && ink && contrast(bg, ink) >= 4.5) { fit.surface = bg; fit.ink = ink; basis.push(`page background ${bg} with text ${ink}`); }
  else if (bg || ink) basis.push("page background / text colour not copied (unclear or low contrast): templates keep readable defaults");

  if (!basis.length) basis.push("nothing usable was measured: templates use their neutral defaults");
  return { fit, basis };
}
