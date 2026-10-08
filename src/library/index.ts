import { parseTemplate, renderTemplate } from "./engine.js";
import { CORE_CSS, CORE_CSS_ID } from "./core-css.js";
import { lintCss, lintElementor, lintHtml, merge, type Lint } from "./lint.js";
import { ContentError, validateContent, type Builder, type BuildContext, type Content, type CssBlock, type LibraryComponent, type Rendered, type Slot } from "./types.js";
import { contact } from "./components/contact.js";
import { testimonials } from "./components/testimonials.js";

export * from "./types.js";
export { CORE_CSS, CORE_CSS_ID } from "./core-css.js";
export { lintCss, lintHtml, lintElementor } from "./lint.js";

/** The Livecrafts component library. Add a file in ./components and list it here: nothing else changes. */
export const COMPONENTS: LibraryComponent[] = [testimonials, contact];

export const getComponent = (id: string) => COMPONENTS.find((c) => c.id === id);

/** Words people use for a component that are not in its keywords (the match is on whole words or phrases). */
const SYNONYMS: Record<string, string[]> = {
  testimonials: ["feedback", "customers", "clients", "reviews", "stories", "social proof", "trust"],
  contact: ["reach", "enquire", "enquiry", "inquire", "inquiry", "email us", "call", "visit", "map", "location"],
};

export interface LibraryMatch { component: LibraryComponent; score: number }

/** Rank library components for a request such as "add a testimonial section" or "contact form with address". */
export function searchLibrary(query: string): LibraryMatch[] {
  const q = " " + query.toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  const words = new Set(q.trim().split(" ").filter((w) => w.length > 2));
  const out: LibraryMatch[] = [];
  for (const c of COMPONENTS) {
    let score = 0;
    if (q.includes(" " + c.id + " ") || q.includes(" " + c.name.toLowerCase() + " ")) score += 10;
    for (const k of [...c.keywords, ...(SYNONYMS[c.id] ?? [])]) {
      const kw = k.toLowerCase();
      if (q.includes(" " + kw + " ") || q.includes(" " + kw + "s ") || q.includes(" " + kw.replace(/s$/, "") + " ")) score += kw.includes(" ") ? 6 : 4;
      else if (words.has(kw)) score += 3;
    }
    if (score) out.push({ component: c, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface RenderOptions {
  builder: Builder;
  /** What the person wants shown. Fields left out fall back to the sample text (reported as placeholders). */
  content?: Content;
  /** Elementor widgets of the site + the Media Library images the content refers to. */
  ctx?: Partial<BuildContext>;
  /** The site's brand colour (#rrggbb): filled buttons and accents. Without it the component is neutral and always legible. */
  brand?: string;
}

export interface RenderedComponent extends Rendered { content: Content; component: string }

const hex = (h: string) => { const v = h.replace("#", ""); const f = v.length === 3 ? v.split("").map((x) => x + x).join("") : v; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
const lum = (h: string) => { const [r, g, b] = hex(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Text colour for a filled button in the brand colour: whichever of white / near-black reads better. */
export function onBrand(brand: string): { color: string; ratio: number } {
  const white = contrast(brand, "#ffffff"), dark = contrast(brand, "#111111");
  return white >= dark ? { color: "#ffffff", ratio: white } : { color: "#111111", ratio: dark };
}

/** Site-wide design tokens as a CSS block (only :root custom properties). */
export function tokensCss(brand: string): CssBlock {
  const { color } = onBrand(brand);
  return { id: "lc-tokens", label: "Livecrafts components: brand colour", css: `/* Livecrafts component tokens */\n:root {\n  --lc-brand: ${brand};\n  --lc-on-brand: ${color};\n}\n` };
}

/** Attachment ids a content refers to (so the caller can look them up before rendering). */
export function imageIds(comp: LibraryComponent, content: Content): number[] {
  const ids = new Set<number>();
  const walk = (slots: Slot[], row: Content) => {
    for (const s of slots) {
      if (s.type === "image" && /^\d+$/.test(String(row?.[s.name] ?? ""))) ids.add(Number(row[s.name]));
      if (s.type === "list" && Array.isArray(row?.[s.name])) for (const r of row[s.name]) walk(s.fields ?? [], r);
    }
  };
  walk(comp.slots, content);
  return [...ids];
}

function withImageUrls(slots: Slot[], row: Content, media: BuildContext["media"]): Content {
  const out: Content = { ...row };
  for (const s of slots) {
    if (s.type === "image") {
      const id = String(row[s.name] ?? "");
      if (id && !media[id]) throw new ContentError(`${s.name}: image ${id} was not found in the Media Library.`);
      out[s.name] = id ? media[id].url : "";
    }
    if (s.type === "list" && Array.isArray(row[s.name])) out[s.name] = row[s.name].map((r: Content) => withImageUrls(s.fields ?? [], r, media));
  }
  return out;
}

export class LintError extends Error { constructor(public lint: Lint, what: string) { super(`The ${what} did not pass the library checks: ${lint.errors.join(" ")}`); } }

/** Validate the content, render it for one builder, and run every static check. Throws ContentError / LintError. */
export function renderComponent(id: string, opts: RenderOptions): RenderedComponent {
  const comp = getComponent(id);
  if (!comp) throw new ContentError(`Unknown library component "${id}". Available: ${COMPONENTS.map((c) => c.id).join(", ")}.`);
  const sample = comp.sample();
  const supplied = Object.fromEntries(Object.entries(opts.content ?? {}).filter(([, v]) => v !== undefined && v !== null));
  const merged = { ...sample, ...supplied };
  const clean = validateContent(comp.slots, merged);
  const ctx: BuildContext = { widgets: opts.ctx?.widgets ?? [], media: opts.ctx?.media ?? {} };
  const placeholders = comp.isPlaceholder(clean);
  const prepared = { ...comp.prepare(clean), placeholderAttr: placeholders ? ' data-lc-placeholder="true"' : "" };
  const withUrls = withImageUrls(comp.slots, prepared, ctx.media); // also proves every image id exists
  const css: CssBlock[] = [
    { id: CORE_CSS_ID, label: "Livecrafts components: core", css: CORE_CSS },
    { id: `lc-c-${comp.id}`, label: `Livecrafts component: ${comp.name}`, css: comp.css },
  ];
  if (opts.brand) {
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(opts.brand)) throw new ContentError("brand must be a colour like #1d4ed8.");
    css.push(tokensCss(opts.brand));
  }
  const cssLint = merge(...css.map((b) => lintCss(b.css)));
  if (cssLint.errors.length) throw new LintError(cssLint, "CSS");

  const warnings: string[] = [...cssLint.warnings];
  if (opts.brand) {
    const r = onBrand(opts.brand);
    if (r.ratio < 4.5) warnings.push(`The brand colour ${opts.brand} gives button text only ${r.ratio.toFixed(1)}:1 contrast (4.5:1 is needed). Use a darker or lighter brand colour for buttons.`);
  }
  if (placeholders) warnings.push("Sample text is still in this section. Ask the person for the real content (never invent customer quotes) before it is deployed.");

  let value: string, kind: Rendered["kind"], lint: Lint;
  if (opts.builder === "elementor") {
    const node = comp.elementor(prepared, ctx);
    lint = lintElementor(node as any);
    value = JSON.stringify(node);
    kind = "el.insert";
  } else {
    const data = withUrls;
    const tpl = opts.builder === "blocks" ? comp.blocks : comp.html;
    const markup = renderTemplate(parseTemplate(tpl), data);
    lint = lintHtml(markup);
    value = opts.builder === "html" ? `<!-- wp:html -->\n${markup.trim()}\n<!-- /wp:html -->\n` : markup;
    kind = "block.insert";
  }
  if (lint.errors.length) throw new LintError(lint, "markup");
  warnings.push(...lint.warnings);
  return { builder: opts.builder, kind, value, css, placeholders, warnings: [...new Set(warnings)], content: clean, component: comp.id };
}
