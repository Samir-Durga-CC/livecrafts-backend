import { nestingOk, type ElNode } from "./elementor.js";

/**
 * Static checks every library component passes before it is placed on a site - the same things a code reviewer looks
 * for. They run on the CSS, the markup / block markup and the Elementor tree. Errors block the placement; warnings go
 * back to the model and the person. (The real-browser checks - overflow, overlap, covered text - are in check.ts.)
 */
export interface Lint { errors: string[]; warnings: string[] }

const decls = (css: string) => {
  const out: Array<{ prop: string; value: string }> = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of plain.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?:;|(?=}))/gi)) out.push({ prop: m[1].toLowerCase(), value: m[2].trim() });
  return out;
};

/** The plugin's own CSS rules (css.php) plus the library's rules against overlay and overflow. */
export function lintCss(css: string): Lint {
  const errors: string[] = [], warnings: string[] = [];
  if (css.length > 30_000) errors.push("CSS is longer than the 30 000 characters one Additional CSS block may have.");
  if (css.includes("<")) errors.push('CSS contains "<".');
  if (/!\s*important/i.test(css)) errors.push("CSS uses !important - make the selector more specific instead.");
  if (/@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) errors.push("CSS uses @import, expression(), javascript: or behavior.");
  if (/livecrafts:/i.test(css)) errors.push("CSS contains a Livecrafts block marker.");
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  for (const ch of plain) { if (ch === "{") depth++; if (ch === "}" && --depth < 0) break; }
  if (depth !== 0) errors.push("CSS braces { } do not match.");

  for (const { prop, value } of decls(css)) {
    if (prop === "position" && /^(absolute|fixed|sticky)$/i.test(value)) errors.push(`position: ${value} can make the component overlay the page.`);
    if (prop === "float" && !/^none$/i.test(value)) errors.push(`float: ${value} breaks the layout of what follows.`);
    if (prop === "z-index" && !/^(0|-?auto|auto)$/i.test(value)) errors.push(`z-index: ${value} - the component is its own stacking context, a z-index is never needed.`);
    if (/^(width|min-width|max-width|height|min-height|left|right|top|bottom|inset)/.test(prop) && /\d(vw|vmin|vmax)\b/.test(value)) errors.push(`${prop}: ${value} - viewport units make the component wider than its container.`);
    if (/^(min-)?width$/.test(prop) && /^\d{3,}(\.\d+)?px$/.test(value)) errors.push(`${prop}: ${value} - a fixed pixel width does not fit small screens. Use %, rem with min(), or minmax().`);
    if (/^margin/.test(prop) && /(^|[\s(,])-\d/.test(value)) errors.push(`${prop}: ${value} - negative margins pull the component over its neighbours.`);
    if (prop === "overflow" && /^hidden$/i.test(value)) warnings.push("overflow: hidden can clip content (shadows, focus rings, long words).");
  }
  return { errors, warnings };
}

const FORBIDDEN_TAGS = /<(script|style|iframe|object|embed|link|meta|form|base)\b/i;

/** Plain HTML (or block markup: block comments are ignored). */
export function lintHtml(markup: string): Lint {
  const errors: string[] = [], warnings: string[] = [];
  const html = markup.replace(/<!--[\s\S]*?-->/g, "");
  if (FORBIDDEN_TAGS.test(html)) errors.push("The markup contains a script, style, iframe, object, embed, link, meta, form or base tag.");
  if (/\son[a-z]+\s*=/i.test(html)) errors.push("The markup contains an inline event handler (onclick ...).");
  if (/javascript:/i.test(html)) errors.push("The markup contains a javascript: address.");
  if (/\sstyle\s*=/i.test(html)) errors.push("The markup contains an inline style attribute. Styling belongs in the CSS block.");
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\salt\s*=/.test(m[0])) errors.push("An image has no alt attribute (use alt=\"\" for a decorative image).");
  for (const m of html.matchAll(/<a\b[^>]*target\s*=\s*["']_blank["'][^>]*>/gi)) if (!/rel\s*=\s*["'][^"']*noopener/.test(m[0])) errors.push('A link with target="_blank" needs rel="noopener".');
  if ((html.match(/<h1\b/gi) ?? []).length) errors.push("A section must not contain an h1 (the page has one).");
  const ids = [...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`The id "${dup}" appears twice.`);
  for (const m of html.matchAll(/<a\b[^>]*>\s*<\/a>/gi)) errors.push("A link has no text: " + m[0].slice(0, 60));
  if (/data-lc-placeholder/.test(html)) warnings.push("Contains sample text: replace it with the real content before the page is deployed.");
  return { errors, warnings };
}

const ALLOWED_WIDGETS = new Set(["heading", "text-editor", "image", "button", "shortcode"]);

/** The Elementor tree: nesting, only free widgets, no raw-code widgets. */
export function lintElementor(node: ElNode): Lint {
  const errors: string[] = [];
  if (!nestingOk(node)) errors.push("The Elementor tree breaks Elementor's nesting rules (containers hold containers and widgets; widgets hold nothing).");
  const walk = (n: ElNode, depth: number) => {
    if (depth > 8) errors.push("The Elementor tree is nested too deeply.");
    if (n.elType === "widget" && !ALLOWED_WIDGETS.has(String(n.widgetType))) errors.push(`The widget "${n.widgetType}" is not one of the free widgets the library uses.`);
    for (const k of n.elements) walk(k, depth + 1);
  };
  walk(node, 0);
  return { errors, warnings: [] };
}

export const merge = (...l: Lint[]): Lint => ({ errors: l.flatMap((x) => x.errors), warnings: l.flatMap((x) => x.warnings) });
