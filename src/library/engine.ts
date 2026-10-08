/**
 * A tiny template engine with two back ends, so ONE template describes a component for every kind of theme:
 *   - renderTemplate()  -> HTML / block markup (what Livecrafts inserts into a page)
 *   - templateToPhp()   -> a PHP partial that reads the same fields from an ACF flexible-content layout
 *
 * Syntax
 *   {{name}}          text, HTML-escaped
 *   {{{name}}}        trusted HTML (only for fields the library itself builds)
 *   {{url:name}}      a link / image address (checked: http, https, mailto, tel, relative, #)
 *   {{shortcode:name}} a WordPress shortcode such as [contact-form-7 id="12"]
 *   {{#each name}}..{{/each}}      repeat for every row of a list
 *   {{#if name}}..{{/if}}          only when the field has a value
 *   {{#unless name}}..{{/unless}}  only when it has none
 */
export type Node =
  | { t: "text"; v: string }
  | { t: "var"; name: string; mode: "esc" | "raw" | "url" | "shortcode" }
  | { t: "each" | "if" | "unless"; name: string; kids: Node[] };

export function parseTemplate(tpl: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ kids: Node[]; close: string }> = [{ kids: root, close: "" }];
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf("{{", i);
    if (open < 0) { stack[stack.length - 1].kids.push({ t: "text", v: tpl.slice(i) }); break; }
    if (open > i) stack[stack.length - 1].kids.push({ t: "text", v: tpl.slice(i, open) });
    const triple = tpl.startsWith("{{{", open);
    const end = tpl.indexOf(triple ? "}}}" : "}}", open);
    if (end < 0) throw new Error("Template: unclosed {{ at " + open);
    const inner = tpl.slice(open + (triple ? 3 : 2), end).trim();
    i = end + (triple ? 3 : 2);
    const top = stack[stack.length - 1];
    let m: RegExpMatchArray | null;
    if (triple) top.kids.push({ t: "var", name: inner, mode: "raw" });
    else if ((m = inner.match(/^#(each|if|unless)\s+(\w+)$/))) {
      const node = { t: m[1] as "each" | "if" | "unless", name: m[2], kids: [] as Node[] };
      top.kids.push(node);
      stack.push({ kids: node.kids, close: m[1] });
    } else if ((m = inner.match(/^\/(each|if|unless)$/))) {
      if (top.close !== m[1]) throw new Error(`Template: unexpected {{/${m[1]}}}`);
      stack.pop();
    } else if ((m = inner.match(/^(url|shortcode):(\w+)$/))) top.kids.push({ t: "var", name: m[2], mode: m[1] as "url" | "shortcode" });
    else if (/^\w+$/.test(inner)) top.kids.push({ t: "var", name: inner, mode: "esc" });
    else throw new Error(`Template: cannot read {{${inner}}}`);
  }
  if (stack.length !== 1) throw new Error("Template: a {{#each}}, {{#if}} or {{#unless}} is not closed");
  return root;
}

export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/** Only addresses that cannot run script. Anything else becomes "" (the caller reports it). */
export function safeUrl(u: unknown): string {
  const s = String(u ?? "").trim();
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(s)) return s.replace(/[\u0000-\u001f\u007f\s]/g, (c) => encodeURIComponent(c));
  return "";
}

/** `[tag attr="x"]` only: a single shortcode, no nested markup. */
export function safeShortcode(s: unknown): string {
  const t = String(s ?? "").trim();
  return /^\[[a-z0-9_-]+(?:\s+[a-z0-9_-]+=(?:"[^"\][<>]*"|'[^'\][<>]*'|[\w.-]+))*\s*\]$/i.test(t) ? t : "";
}

type Ctx = Record<string, unknown>;
const lookup = (stack: Ctx[], name: string): unknown => {
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k] && Object.prototype.hasOwnProperty.call(stack[k], name)) return stack[k][name];
  return undefined;
};
const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : !!v);

export function renderTemplate(nodes: Node[], data: Ctx, stack: Ctx[] = [data]): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      const v = lookup(stack, n.name);
      out += n.mode === "raw" ? String(v ?? "") : n.mode === "url" ? escapeHtml(safeUrl(v)) : n.mode === "shortcode" ? safeShortcode(v) : escapeHtml(v);
    } else if (n.t === "if" || n.t === "unless") {
      if (truthy(lookup(stack, n.name)) === (n.t === "if")) out += renderTemplate(n.kids, data, stack);
    } else {
      const list = lookup(stack, n.name);
      if (Array.isArray(list)) for (const row of list) out += renderTemplate(n.kids, data, [...stack, row as Ctx]);
    }
  }
  return out;
}

/**
 * The same template as a PHP partial that reads ACF sub fields (flexible content / repeater rows).
 * `computed` maps a variable the library calculates (not an ACF field) to the PHP that calculates it.
 */
export function templateToPhp(nodes: Node[], computed: Record<string, string> = {}): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      if (n.name in computed) { out += computed[n.name]; continue; }
      const get = `get_sub_field( '${n.name}' )`;
      out += n.mode === "raw" ? `<?php echo wp_kses_post( ${get} ); ?>` : n.mode === "url" ? `<?php echo esc_url( ${get} ); ?>`
        : n.mode === "shortcode" ? `<?php echo do_shortcode( sanitize_text_field( ${get} ) ); ?>` : `<?php echo esc_html( ${get} ); ?>`;
    } else if (n.t === "if" || n.t === "unless") {
      out += `<?php if ( ${n.t === "if" ? "" : "! "}get_sub_field( '${n.name}' ) ) : ?>${templateToPhp(n.kids, computed)}<?php endif; ?>`;
    } else out += `<?php if ( have_rows( '${n.name}' ) ) : while ( have_rows( '${n.name}' ) ) : the_row(); ?>${templateToPhp(n.kids, computed)}<?php endwhile; endif; ?>`;
  }
  return out;
}
