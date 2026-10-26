/**
 * Put one gallery section on a page as a DRAFT - the Section Gallery's "Add to this page". No AI and no tokens:
 * the section is fixed markup, so placing it is a plain write the plugin validates, stores and can revert.
 *
 * One section, one markup, four ways in (whichever the page is built with):
 *   elementor  el.insert     a container (or section > column on sites without containers) holding a Text Editor widget
 *   blocks     block.insert  a full-width Group block holding a Custom HTML block
 *   divi       divi.insert   a Divi section > row > column > Code module (plugin 0.24+)
 *   html       post.field    classic content: the section is added to the page content at the start or the end
 * The look is two Additional CSS blocks (css.block): the shared design system and the section's own rules, both
 * written once per site and replaced (not duplicated) when they are written again.
 */
import { Bridge } from "../bridge.js";
import { lintCss, lintHtml, merge } from "../library/lint.js";
import { CATEGORIES, CORE_CSS, CORE_ID, SECTIONS, getSection, type SectionDef } from "./library.js";

export type SectionBuilder = "elementor" | "blocks" | "divi" | "html";
export interface Place { value: string; label: string }
export interface PageInfo { builder: SectionBuilder | null; why: string; places: Place[]; containers?: boolean; unsupported?: string }

/** Elementor kit settings the gallery adds to the design system, so a container around a section adds no padding. */
const HOST_CSS = `
/* Livecrafts sections: hosts (the wrapper a builder puts around a section) */
.e-con.lcs-host, .elementor .e-con.lcs-host { --padding-top: 0px; --padding-bottom: 0px; --padding-left: 0px; --padding-right: 0px; --gap: 0px; --content-width: 100%; }
.lcs-host .elementor-widget-text-editor, .lcs-host .et_pb_code_inner { width: 100%; }
.et_pb_section.lcs-host, .et_pb_section.lcs-host .et_pb_row { padding: 0; width: 100%; max-width: 100%; }
.wp-block-group.lcs-host { margin-block: 0; padding: 0; }
`;

export const coreCss = () => CORE_CSS + HOST_CSS;

/** The catalogue as the gallery shows it (no markup: the preview fetches that per section). */
export function catalogue() {
  return {
    categories: CATEGORIES.map((c) => ({ ...c, count: SECTIONS.filter((s) => s.category === c.id).length })),
    sections: SECTIONS.map(({ id, category, name, summary }) => ({ id, category, name, summary })),
  };
}

const plain = (s: unknown, n = 48) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Top-level blocks of block markup: name + a little text, in order. */
function topBlocks(content: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const re = /<!--\s+(\/)?wp:([a-z0-9/-]+)(?:\s+(\{[\s\S]*?\}))?\s+(\/)?-->/g;
  let depth = 0, m: RegExpExecArray | null, openAt = -1, openName = "";
  while ((m = re.exec(content))) {
    const closing = !!m[1], self = !!m[4];
    if (self) { if (depth === 0) out.push({ name: m[2], text: "" }); continue; }
    if (!closing) { if (depth === 0) { openAt = re.lastIndex; openName = m[2]; } depth++; }
    else if (--depth === 0) out.push({ name: openName, text: plain(content.slice(openAt, m.index)) });
    if (depth < 0) depth = 0;
  }
  return out;
}

const nice = (name: string) => name.replace(/^core\//, "").replace(/[-/]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** How the page is built, and where a section can go (top, after each top-level part, end). */
export async function pageInfo(bridge: Bridge, postId: number): Promise<PageInfo> {
  const map: any = await bridge.map({ post: postId, view: "draft" });
  const post: any = await bridge.post(postId, "draft").catch(() => null);
  const content = String(post?.content ?? "");

  if (map?.builders?.elementor) {
    const profile: any = await bridge.siteProfile().catch(() => null);
    const top = (Array.isArray(map.elementor_outline) ? map.elementor_outline : []).filter((n: any) => Number(n.depth) === 0);
    const places: Place[] = [{ value: "root:0", label: "Top of the page" }];
    top.forEach((n: any, i: number) => {
      const child = (map.elementor_outline as any[]).find((x) => x.text && isInside(map.elementor_outline, x, n.id));
      places.push({ value: `root:${i + 1}`, label: `After: ${plain(child?.text || n.text, 40) || `section ${i + 1}`}` });
    });
    if (places.length > 1) places[places.length - 1].label += " (end of the page)";
    return { builder: "elementor", why: "Elementor page", places, containers: (profile?.builders?.elementor?.containers ?? profile?.containers) !== false };
  }
  if (/<!--\s+wp:divi\//.test(content)) {
    return { builder: null, why: "Divi 5 page", places: [], unsupported: "This page is built with Divi 5. Adding gallery sections to Divi 5 pages is coming next; Divi 4 pages work today." };
  }
  const divi = (Array.isArray(map?.divi_outline) ? map.divi_outline : []).filter((n: any) => n.module === "et_pb_section" && !String(n.path).includes("."));
  if (divi.length || /\[et_pb_section/.test(content)) {
    const places: Place[] = [{ value: "0", label: "Top of the page" }];
    divi.forEach((_: any, i: number) => {
      const first = (map.divi_outline as any[]).find((x) => String(x.path).startsWith(`${i}.`) && !x.layout);
      places.push({ value: String(i + 1), label: `After: section ${i + 1}${first ? ` (${first.label})` : ""}` });
    });
    if (places.length > 1) places[places.length - 1].label += ", end of the page";
    return { builder: "divi", why: "Divi page", places };
  }
  if (!content.trim() || /<!--\s+wp:/.test(content)) {
    const blocks = topBlocks(content);
    const places: Place[] = [{ value: ":0", label: "Top of the page" }];
    blocks.forEach((b, i) => places.push({ value: `:${i + 1}`, label: `After: ${b.text ? b.text.slice(0, 40) : nice(b.name)}` }));
    if (places.length > 1) places[places.length - 1].label += " (end of the page)";
    return { builder: "blocks", why: "block editor page", places };
  }
  return { builder: "html", why: "classic editor page", places: [{ value: "start", label: "Top of the page" }, { value: "end", label: "End of the page" }] };
}

function isInside(outline: any[], node: any, ancestorId: string): boolean {
  let cur = node;
  for (let i = 0; i < 12 && cur; i++) {
    if (cur.parent === ancestorId) return true;
    cur = outline.find((x) => x.id === cur.parent);
  }
  return false;
}

export class SectionError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/** Static checks before anything is written: the same library rules every component passes. */
function lint(s: SectionDef) {
  const r = merge(lintCss(coreCss()), lintCss(s.css), lintHtml(s.html));
  if (r.errors.length) throw new SectionError(`The section "${s.name}" did not pass the library checks: ${r.errors.join(" ")}`, 500);
}

/** The section's markup wrapped the way each builder holds it. */
function wrap(s: SectionDef, info: PageInfo, currentContent: string, place: string): { kind: string; target: string; value: unknown } {
  switch (info.builder) {
    case "elementor": {
      const widget = { elType: "widget", widgetType: "text-editor", settings: { editor: s.html }, elements: [] };
      const node = info.containers === false
        ? { elType: "section", settings: { layout: "full_width", gap: "no", css_classes: "lcs-host" }, elements: [{ elType: "column", settings: {}, elements: [widget] }] }
        : { elType: "container", settings: { content_width: "full", flex_direction: "column", css_classes: "lcs-host" }, elements: [widget] };
      return { kind: "el.insert", target: place, value: JSON.stringify(node) };
    }
    case "blocks":
      return {
        kind: "block.insert", target: place,
        value: `<!-- wp:group {"align":"full","className":"lcs-host","layout":{"type":"default"}} -->\n<div class="wp-block-group alignfull lcs-host"><!-- wp:html -->\n${s.html}\n<!-- /wp:html --></div>\n<!-- /wp:group -->\n`,
      };
    case "divi":
      return { kind: "divi.insert", target: place, value: s.html };
    case "html": {
      const piece = `<div class="lcs-host">${s.html}</div>`;
      return { kind: "post.field", target: "content", value: place === "start" ? `${piece}\n\n${currentContent}` : `${currentContent.replace(/\s+$/, "")}\n\n${piece}\n` };
    }
    default:
      throw new SectionError(info.unsupported ?? "Sections cannot be added to this page.");
  }
}

/** Add a section as a draft. Returns the section change and the CSS changes (empty when the CSS was already there). */
export async function addSection(bridge: Bridge, a: { id: string; postId: number; place?: string; ref?: string }) {
  const s = getSection(a.id);
  if (!s) throw new SectionError(`Unknown section "${a.id}".`, 404);
  if (!a.postId) throw new SectionError("Open the page you want to add the section to first.");
  lint(s);
  const info = await pageInfo(bridge, a.postId);
  if (!info.builder) throw new SectionError(info.unsupported ?? "Sections cannot be added to this page.");
  const place = a.place && info.places.some((p) => p.value === a.place) ? a.place : info.places[info.places.length - 1].value;
  const current = info.builder === "html" ? String((await bridge.post(a.postId, "draft"))?.content ?? "") : "";

  // 1) the look first (the plugin replaces a block with the same name, so writing it again is harmless)
  const cssChanges: any[] = [];
  for (const b of [{ id: CORE_ID, label: "Livecrafts sections: design system", css: coreCss() }, { id: `lcs-${s.id}`, label: `Livecrafts section: ${s.name}`, css: s.css }]) {
    const r: any = await bridge.makeChange({ kind: "css.block", target: b.id, value: b.css, label: b.label, ref: a.ref, source: "widget" });
    if (r?.ok === false) throw new SectionError(`Could not save the section's CSS: ${r.error ?? r.message ?? "refused"}. Nothing was added.`, 502);
    if (r?.change && !r?.unchanged) cssChanges.push(r.change);
  }
  // 2) the section itself
  const w = wrap(s, info, current, place);
  const r: any = await bridge.makeChange({ kind: w.kind, post: a.postId, target: w.target, value: w.value, label: `Section: ${s.name}`, ref: a.ref, source: "widget" });
  if (r?.ok === false) throw new SectionError(r.error ?? r.message ?? "The site refused the section.", 502);
  return { ok: true, section: s.id, name: s.name, builder: info.builder, place, change: r.change ?? null, cssChanges };
}

/** A standalone page that shows one section the way it will look on this site (brand colour and fonts). */
export function previewDocument(id: string, look: { brand?: string; heading?: string; body?: string; fontsHref?: string }) {
  const s = getSection(id);
  if (!s) throw new SectionError(`Unknown section "${id}".`, 404);
  const safeFont = (f?: string) => (f && /^[\w\s,'"-]{1,80}$/.test(f) ? f : "");
  const brand = look.brand && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(look.brand) ? look.brand : "";
  const body = safeFont(look.body), heading = safeFont(look.heading);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${
    look.fontsHref ? `<link rel="stylesheet" href="${look.fontsHref.replace(/"/g, "")}">` : ""
  }<style>html,body{margin:0;background:#fff;color:#14171f}body{font-family:${body ? `${body}, ` : ""}system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px}h2,h3{font-family:${heading ? `${heading}, ` : ""}inherit}a{color:inherit}${
    brand ? `:root{--lc-brand:${brand}}` : ""
  }</style><style>${coreCss()}</style><style>${s.css}</style></head><body>${s.html}</body></html>`;
}

/** The site's look for previews: the Elementor kit's colours and fonts, else the theme palette (theme.json); empty when neither. */
export async function siteLook(bridge: Bridge): Promise<{ brand?: string; heading?: string; body?: string; fontsHref?: string }> {
  const p: any = await bridge.siteProfile().catch(() => null);
  if (!p) return {};
  const el = p.builders?.elementor ?? {};
  const kitColors: any[] = Array.isArray(el.colors) ? el.colors : [];
  const themeColors: any[] = Array.isArray(p.brand?.colors) ? p.brand.colors : [];
  const hexOf = (c: any) => { const v = String(c?.value ?? c?.color ?? "").trim(); return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : undefined; };
  // First id that matches wins, in the order asked (accent before primary), not the order the site lists them.
  const byId = (rows: any[], ...ids: string[]) => {
    for (const id of ids) {
      const hit = rows.find((c) => String(c.id ?? c.slug ?? "").toLowerCase() === id || String(c.title ?? c.name ?? "").toLowerCase() === id);
      if (hexOf(hit)) return hexOf(hit);
    }
    return undefined;
  };
  const brand = byId(kitColors, "accent", "primary") ?? byId(themeColors, "primary", "accent", "brand", "vivid-cyan-blue") ?? hexOf(kitColors[0]);
  const kitFonts: any[] = Array.isArray(el.fonts) ? el.fonts : [];
  const famOf = (f: any) => String(f?.family ?? "").split(",")[0].replace(/["']/g, "").trim() || undefined;
  const heading = famOf(kitFonts.find((f) => f.id === "primary")) ?? famOf(p.brand?.fonts?.[0]);
  const body = famOf(kitFonts.find((f) => f.id === "text")) ?? famOf(kitFonts.find((f) => f.id === "secondary")) ?? famOf(p.brand?.fonts?.[1]) ?? heading;
  // Google Fonts only for real family names (a theme.json "var(--...)" or a system stack is left to the fallback).
  const families = [...new Set([heading, body].filter((f): f is string => !!f && /^[A-Za-z][A-Za-z0-9 ]{1,40}$/.test(f) && !/^(system-ui|sans-serif|serif|inherit|arial|helvetica)$/i.test(f)))];
  return {
    brand, heading, body,
    fontsHref: families.length ? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600;700`).join("&")}&display=swap` : undefined,
  };
}
