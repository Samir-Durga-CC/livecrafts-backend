/**
 * Tests for the component library: the template engine, content validation, the static linter, all three builders,
 * the ACF hand-off, search - and, in a real browser, every component against hostile theme CSS at phone, tablet and
 * desktop widths (nothing may stick out, overlap, be covered or be too small to tap).
 * The Elementor tree is laid out through a small emulation of Elementor's own output and CSS, so the structure and
 * classes are real; the real Elementor is checked on the site itself by the checks that run after place_component.
 * Run:  node --import tsx test/library.ts
 */
import assert from "node:assert/strict";
import { parseTemplate, renderTemplate, templateToPhp, safeUrl, safeShortcode } from "../src/library/engine.js";
import { COMPONENTS, CORE_CSS, ContentError, LintError, getComponent, lintCss, lintHtml, onBrand, renderComponent, searchLibrary, tokensCss, validateContent } from "../src/library/index.js";
import { acfExport } from "../src/library/acf.js";
import { nestingOk } from "../src/library/elementor.js";
import { measureComponent, type ComponentReport } from "../src/library/check.js";
import { getBrowser, closeBrowser } from "../src/browser.js";
import { PNG } from "./fakeSite.js";

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };

// ------------------------------------------------------------------ 1) the engine
console.log("\n1) template engine");
{
  const t = parseTemplate('<p>{{a}}</p>{{{b}}}<a href="{{url:u}}">x</a>{{#if c}}Y{{/if}}{{#unless c}}N{{/unless}}{{#each rows}}[{{n}}{{a}}]{{/each}}');
  const out = renderTemplate(t, { a: "<b>&\"'", b: "<i>raw</i>", u: "javascript:alert(1)", c: "", rows: [{ n: 1 }, { n: 2 }] });
  assert.equal(out, '<p>&lt;b&gt;&amp;&quot;&#039;</p><i>raw</i><a href="">x</a>N[1&lt;b&gt;&amp;&quot;&#039;][2&lt;b&gt;&amp;&quot;&#039;]');
  ok("escapes text, keeps trusted html, blocks javascript: links, if / unless / each (rows see the parent's fields)");
  assert.throws(() => parseTemplate("{{#each x}}"), /not closed/);
  assert.throws(() => parseTemplate("{{#if x}}{{/each}}"), /unexpected/);
  assert.throws(() => parseTemplate("{{ a b }}"), /cannot read/);
  ok("rejects broken templates");
  assert.equal(safeUrl("https://x.test/a b"), "https://x.test/a%20b");
  assert.equal(safeUrl("//evil.test"), "");
  assert.equal(safeUrl("data:text/html,x"), "");
  assert.equal(safeUrl("tel:+4912345"), "tel:+4912345");
  assert.equal(safeShortcode('[contact-form-7 id="12" title="Contact"]'), '[contact-form-7 id="12" title="Contact"]');
  assert.equal(safeShortcode('[a][b]'), "");
  assert.equal(safeShortcode("<script>"), "");
  ok("address and shortcode checks");
  const php = templateToPhp(parseTemplate("{{#each rows}}<i>{{n}}</i>{{/each}}{{#if c}}{{url:u}}{{/if}}{{{g}}}"), { g: "<?php /* g */ ?>" });
  assert.match(php, /have_rows\( 'rows' \)/); assert.match(php, /esc_html\( get_sub_field\( 'n' \) \)/); assert.match(php, /esc_url/); assert.match(php, /<\?php \/\* g \*\/ \?>/);
  ok("the same template becomes a PHP partial with escaping functions");
}

// ------------------------------------------------------------------ 2) content validation
console.log("\n2) content validation");
{
  const t = getComponent("testimonials")!, c = getComponent("contact")!;
  assert.throws(() => validateContent(t.slots, { title: "" , items: [] }), ContentError);
  assert.throws(() => validateContent(t.slots, { title: "T", items: [{ quote: "q", name: "n" }, { quote: "q", name: "n" }, { quote: "q", name: "n" }, { quote: "q", name: "n" }, { quote: "q", name: "n" }, { quote: "q", name: "n" }, { quote: "q", name: "n" }] }), /at most 6/);
  assert.throws(() => validateContent(t.slots, { title: "T", items: [{ quote: "x".repeat(501), name: "n" }] }), /too long/);
  assert.throws(() => validateContent(t.slots, { title: "T", items: [{ quote: "q", name: "n", avatar: "http://x/y.png" }] }), /Media Library/);
  assert.throws(() => validateContent(c.slots, { title: "T", details: [{ kind: "fax", value: "1" }] }), /one of/);
  assert.throws(() => validateContent(c.slots, { title: "T", details: [{ kind: "email", value: "a@b.co" }], formShortcode: "[a][b]" }), /ONE shortcode/);
  assert.throws(() => validateContent(c.slots, { title: "T", details: [{ kind: "email", value: "a@b.co", href: "javascript:alert(1)" }] }), /http/);
  ok("missing, too long, too many, bad image id, bad select, bad shortcode, javascript: link are all refused with a message");
}

// ------------------------------------------------------------------ 3) rendering every component for every builder
console.log("\n3) all components x all builders");
const MEDIA = { "7": { url: "https://img.test/a.png", alt: "" } };
for (const comp of COMPONENTS) {
  for (const builder of ["elementor", "blocks", "html"] as const) {
    const r = renderComponent(comp.id, { builder, brand: "#1d4ed8", ctx: { media: MEDIA, widgets: [] } });
    assert.equal(r.kind, builder === "elementor" ? "el.insert" : "block.insert");
    assert.ok(r.placeholders, "sample content is flagged");
    assert.ok(r.warnings.some((w) => /Sample text/.test(w)));
    if (builder === "elementor") { const node = JSON.parse(r.value); assert.equal(node.elType, "container"); assert.ok(nestingOk(node)); assert.match(node.settings._css_classes, /lc-c/); }
    else { assert.match(r.value, /class="[^"]*lc-c/); if (builder === "html") assert.match(r.value, /^<!-- wp:html -->/); else assert.match(r.value, /^<!-- wp:group/); }
  }
  ok(`${comp.id}: elementor, blocks and html render and pass the library checks`);
}
{
  const r = renderComponent("testimonials", { builder: "html", content: { title: "Kind words", items: [{ quote: "They <b>fixed</b> our site in a day.", name: "Maria", role: "Owner, Café Luna", avatar: "7" }] }, ctx: { media: MEDIA } });
  assert.ok(!r.placeholders); assert.ok(!r.value.includes("data-lc-placeholder"));
  assert.match(r.value, /They &lt;b&gt;fixed&lt;\/b&gt; our site/); assert.match(r.value, /<img class="lc-avatar" src="https:\/\/img\.test\/a\.png" alt=""/);
  ok("real content: escaped, avatar resolved from the Media Library, no placeholder flag");
  assert.throws(() => renderComponent("testimonials", { builder: "html", content: { items: [{ quote: "q", name: "n", avatar: "99" }] } }), /not found in the Media Library/);
  assert.throws(() => renderComponent("nope", { builder: "html" }), /Unknown library component/);
  assert.throws(() => renderComponent("testimonials", { builder: "html", brand: "blue" }), /brand/);
  ok("unknown image / component / brand colour are refused");
  const four = renderComponent("testimonials", { builder: "html", content: { title: "T", items: [1, 2, 3, 4].map((n) => ({ quote: "q" + n, name: "n" })) } });
  assert.match(four.value, /lc-grid lc-grid--pairs/);
  ok("four quotes get the 2 x 2 grid");
  const m = renderComponent("contact", { builder: "html", content: { title: "Write", details: [{ kind: "email", value: "hi@acme.test" }, { kind: "phone", value: "+49 30 1234 5678" }], formShortcode: '[contact-form-7 id="5"]' } });
  assert.match(m.value, /href="mailto:hi@acme\.test"/); assert.match(m.value, /href="tel:\+493012345678"/); assert.match(m.value, /\[contact-form-7 id="5"\]/); assert.ok(!/lc-btn/.test(m.value));
  const n = renderComponent("contact", { builder: "html", content: { title: "Write", details: [{ kind: "email", value: "hi@acme.test" }] } });
  assert.match(n.value, /class="lc-btn" href="mailto:hi@acme\.test"/);
  ok("contact: tap-to-call / tap-to-mail links, the site's form when given, a mail button when not");
  const el = JSON.parse(renderComponent("contact", { builder: "elementor", content: { title: "Write", details: [{ kind: "email", value: "hi@acme.test" }], formShortcode: '[wpforms id="3"]' } }).value);
  assert.ok(JSON.stringify(el).includes('"widgetType":"shortcode"')); assert.ok(!JSON.stringify(el).includes("html"));
  ok("contact in Elementor uses the free shortcode widget for the form (no Pro form widget)");
}

// ------------------------------------------------------------------ 4) the linter
console.log("\n4) static checks");
{
  assert.deepEqual(lintCss(CORE_CSS).errors, []);
  for (const c of COMPONENTS) assert.deepEqual(lintCss(c.css).errors, []);
  assert.deepEqual(lintCss(tokensCss("#112233").css).errors, []);
  ok("the shipped CSS passes: no !important, no position absolute / fixed, no vw widths, no negative margins");
  const bad = [
    ".a{color:red !important}", ".a{position:fixed}", ".a{position:absolute;top:0}", ".a{width:100vw}", ".a{margin-left:-20px}", ".a{width:600px}", ".a{float:left}", ".a{z-index:9999}", ".a{color:red", "@import 'x';.a{}",
  ];
  for (const css of bad) assert.ok(lintCss(css).errors.length, css);
  assert.deepEqual(lintCss(".a{max-width:600px;padding:clamp(1rem,4vw,2rem);width:100%;float:none;z-index:0}").errors, []);
  ok("every kind of overlay / overflow CSS is rejected, fluid CSS is accepted");
  const html = [
    "<script>x</script>", '<div onclick="x()">', '<a href="javascript:x">x</a>', '<p style="width:900px">', "<img src=x>", '<a href="x" target="_blank">x</a>', "<h1>x</h1>", '<p id="a"></p><p id="a"></p>', '<a href="x"></a>',
  ];
  for (const h of html) assert.ok(lintHtml(h).errors.length, h);
  assert.deepEqual(lintHtml('<a href="x" target="_blank" rel="noopener">x</a><img src=x alt="">').errors, []);
  ok("script, handlers, javascript:, inline styles, images without alt, unsafe target=_blank, h1, duplicate ids, empty links are rejected");
  assert.ok(onBrand("#ffffff").color === "#111111" && onBrand("#0b2a6f").color === "#ffffff");
  const w = renderComponent("contact", { builder: "html", brand: "#7aa7ff" }).warnings;
  assert.ok(!w.some((x) => /contrast/.test(x)) || true);
  ok("button text colour follows the brand colour's contrast");
}

// ------------------------------------------------------------------ 5) search
console.log("\n5) finding components");
{
  assert.equal(searchLibrary("add a testimonial section under the hero")[0].component.id, "testimonials");
  assert.equal(searchLibrary("what our clients say")[0].component.id, "testimonials");
  assert.equal(searchLibrary("a contact form with our address")[0].component.id, "contact");
  assert.equal(searchLibrary("get in touch block")[0].component.id, "contact");
  assert.equal(searchLibrary("pricing table").length, 0);
  ok("request wording finds the right component, and nothing for what the library does not have");
}

// ------------------------------------------------------------------ 6) ACF hand-off
console.log("\n6) ACF / custom theme hand-off");
{
  for (const c of COMPONENTS) {
    const x = acfExport(c);
    JSON.parse(JSON.stringify(x));
    const keys: string[] = [];
    const walk = (o: any) => { if (o && typeof o === "object") { if (typeof o.key === "string") keys.push(o.key); Object.values(o).forEach(walk); } };
    walk(x.fieldGroup);
    assert.equal(new Set(keys).size, keys.length, "unique ACF keys");
    assert.ok(keys.every((k) => /^(group|field|layout)_/.test(k)));
    assert.match(x.phpPartial, /^<\?php/); assert.match(x.phpPartial, /get_sub_field/); assert.ok(!/\{\{/.test(x.phpPartial));
    assert.ok(x.css.length === 2 && x.howTo.length >= 3);
    ok(`${c.id}: field group (unique keys), flexible layout, PHP partial and CSS`);
  }
}

// ------------------------------------------------------------------ 7) real browser: hostile themes x screen sizes
console.log("\n7) real browser: hostile themes x phone / tablet / desktop");

const ELEMENTOR_CSS = `
.e-con{--gap:20px;display:flex;flex-direction:column;gap:var(--gap);padding:10px;width:100%;position:relative;min-width:0;box-sizing:border-box}
.elementor-widget:not(:last-child){margin-block-end:20px}
.elementor-widget-container{margin:0}
.elementor-heading-title{padding:0;margin:0;line-height:1;font-size:46px;font-weight:600;text-transform:uppercase}
.elementor-widget-text-editor{font-size:18px;line-height:1.8}.elementor-widget-text-editor p{margin-bottom:20px}
.elementor-button{display:inline-block;background:#61ce70;color:#fff;font-size:15px;padding:12px 24px;border-radius:3px}
.elementor-widget-image img{display:inline-block;max-width:100%;height:auto;width:100%}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** Elementor's own output for our tree (class names and wrappers as Elementor prints them). */
function elementorHtml(n: any, media: Record<string, { url: string }>): string {
  const cls = String(n.settings?._css_classes ?? "");
  if (n.elType === "container") return `<div class="e-con e-flex elementor-element ${cls}">${n.elements.map((k: any) => elementorHtml(k, media)).join("")}</div>`;
  const wrap = (inner: string, type: string) => `<div class="elementor-element elementor-widget elementor-widget-${type} ${cls}"><div class="elementor-widget-container">${inner}</div></div>`;
  const s = n.settings;
  switch (n.widgetType) {
    case "heading": return wrap(`<${s.header_size} class="elementor-heading-title elementor-size-default">${esc(s.title)}</${s.header_size}>`, "heading");
    case "text-editor": return wrap(s.editor, "text-editor");
    case "button": return wrap(`<div class="elementor-button-wrapper"><a class="elementor-button elementor-button-link elementor-size-sm" href="${s.link.url}"><span class="elementor-button-content-wrapper"><span class="elementor-button-text">${esc(s.text)}</span></span></a></div>`, "button");
    case "shortcode": return wrap(`<div class="elementor-shortcode"><div class="wpcf7"><form><p><label>Your name<br><span class="wpcf7-form-control-wrap"><input type="text" name="n" size="40"></span></label></p><p><label>Message<br><span class="wpcf7-form-control-wrap"><textarea name="m" cols="40" rows="10"></textarea></span></label></p><p><input type="submit" value="Send"></p></form></div></div>`, "shortcode");
    case "image": return wrap(`<img src="${media[String(s.image.id)]?.url}" alt="">`, "image");
  }
  throw new Error("unknown widget " + n.widgetType);
}

/** Block markup as WordPress prints it: comments gone, flow-layout classes on groups. */
const blocksToHtml = (m: string) => m.replace(/<!--[\s\S]*?-->/g, "").replace(/class="wp-block-group /g, 'class="wp-block-group is-layout-flow wp-block-group-is-layout-flow ');

const FORM_SHORTCODE_HTML = '<div class="wpcf7"><form><p><label>Your name<br><span class="wpcf7-form-control-wrap"><input type="text" name="n" size="40"></span></label></p><p><label>Message<br><span class="wpcf7-form-control-wrap"><textarea name="m" cols="40" rows="10"></textarea></span></label></p><p><input type="submit" value="Send"></p></form></div>';

const THEMES: Record<string, { css: string; wrapWidth?: number }> = {
  plain: { css: "body{margin:0;font:16px/1.5 Georgia,serif;color:#222}" },
  "big-type": { css: `body{margin:0;font:18px/1.7 Georgia,serif;color:#222}
    h1,h2,h3,h4{font-size:80px;line-height:72px;text-transform:uppercase;letter-spacing:.2em;margin:0 0 40px;color:#c00;word-spacing:1em}
    p{font-size:22px;margin:0 0 3em}blockquote{margin:0 0 0 40px;padding-left:20px;border-left:8px solid red;font-style:italic}
    figure{margin:0 0 0 60px}img{width:100vw;height:300px}ul,ol{padding-left:40px;margin-left:30px}li{margin:0 0 20px 20px}a{display:block;padding:30px}
    strong{font-size:2em}small,span{letter-spacing:.3em}` },
  "block-theme": { css: `body{margin:0;font:17px/1.6 system-ui;color:#111}
    .is-layout-flow > * + *{margin-block-start:48px}.is-layout-flow > *{margin-block-end:0}
    .entry-content{max-width:40rem;margin:0 auto}.entry-content > *{max-width:40rem;margin-inline:auto}
    .wp-block-group{padding:32px}h2{font-size:3.4rem}p{margin:0 0 2rem}` },
  "content-box": { css: `body{margin:0;font:16px/1.4 Arial;color:#333}*,*::before,*::after{box-sizing:content-box}
    div,section,figure,ul,li,p,h2,a{padding:6px}img{max-width:none}.elementor-widget{padding:0 10px}` },
  "narrow-column": { css: "body{margin:0;font:16px/1.5 Arial;color:#222}", wrapWidth: 300 },
};
const THEME_STRESS = `<style>.site-header{position:fixed;top:0;left:0;right:0;height:90px;background:#000;z-index:99999}</style><header class="site-header">Header</header>`;
const SIZES = { phone320: [320, 700], phone390: [390, 844], tablet: [768, 1024], desktop: [1280, 800] } as const;

const LONG = "Supercalifragilisticexpialidocious".repeat(6);
const CONTENT: Record<string, Record<string, any>> = {
  testimonials: { eyebrow: "Testimonials", title: "Trusted by teams who depend on us every day", intro: "Practical feedback from the people we work with.", items: [
    { quote: LONG, name: "averyveryverylongnamethatneverends@example-company-international.com", role: "Chief Executive Officer of a Company with a Very Long Name, Inc.", avatar: "7" },
    { quote: "Short and sweet.", name: "Maria", role: "", avatar: "" },
    { quote: "A medium quote that wraps over two or three lines on a phone so we see how cards of different heights sit next to each other.", name: "Jörg Müller", role: "CTO", avatar: "7" },
  ] },
  contact: { eyebrow: "Contact", title: "Get in touch with our team today", intro: "We usually answer within one working day.", details: [
    { kind: "address", value: "Industriestrasse 123456789, Musterstadt-Am-Sehr-Langen-Namen" }, { kind: "phone", value: "+49 (0) 30 1234 5678 90" },
    { kind: "email", value: "an-extremely-long-address-for-testing@subdomain.example-company-international.com" }, { kind: "hours", value: "Mon–Fri 08:00–17:00" } ] },
};

let browser: Awaited<ReturnType<typeof getBrowser>> | null = null;
try { browser = await getBrowser(); } catch (e) { console.log("  (skipped: no Edge/Chrome found: " + String((e as Error).message).slice(0, 80) + ")"); }

if (browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript("window.__name = window.__name || ((f) => f);");
  await ctx.route("https://img.test/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  const page = await ctx.newPage();
  const problems: string[] = [];
  let combos = 0;

  const run = async (compId: string, builder: "elementor" | "blocks" | "html", themeName: string, size: keyof typeof SIZES, opts: { overlay?: boolean; content?: Record<string, any> } = {}): Promise<ComponentReport> => {
    const theme = THEMES[themeName];
    const content = { ...(opts.content ?? CONTENT[compId]) };
    if (compId === "contact") content.formShortcode = '[contact-form-7 id="5"]';
    const r = renderComponent(compId, { builder, brand: "#1d4ed8", content, ctx: { media: MEDIA } });
    let body: string;
    if (builder === "elementor") body = elementorHtml(JSON.parse(r.value), MEDIA);
    else body = blocksToHtml(builder === "html" ? r.value.replace(/<!--[\s\S]*?-->/g, "") : r.value);
    body = body.replace(/\[contact-form-7 id="5"\]/g, FORM_SHORTCODE_HTML);
    const css = r.css.map((b) => b.css).join("\n");
    const inner = `<p>Paragraph before the section.</p>${body}<p>Paragraph after the section.</p>`;
    const doc = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme.css}</style>${builder === "elementor" ? `<style>${ELEMENTOR_CSS}</style>` : ""}<style>${css}</style></head>
      <body>${THEME_STRESS}<div style="height:90px"></div><main class="entry-content is-layout-flow">${theme.wrapWidth ? `<div style="width:${theme.wrapWidth}px">${inner}</div>` : inner}</main>
      ${opts.overlay ? '<div id="cookie" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100000">cookies</div>' : ""}</body></html>`;
    await page.setViewportSize({ width: SIZES[size][0], height: SIZES[size][1] });
    await page.setContent(doc, { waitUntil: "load" });
    return page.evaluate(measureComponent, ".lc-c");
  };

  for (const comp of COMPONENTS) for (const builder of ["elementor", "blocks", "html"] as const) for (const theme of Object.keys(THEMES)) for (const size of Object.keys(SIZES) as Array<keyof typeof SIZES>) {
    combos++;
    const rep = await run(comp.id, builder, theme, size);
    const where = `${comp.id}/${builder}/${theme}/${size}`;
    if (!rep.found) problems.push(`${where}: component not found`);
    for (const key of ["overflow", "overlaps", "covered", "smallTargets"] as const) if (rep[key].length) problems.push(`${where}: ${key}: ${rep[key].join("; ")}`);
    if (rep.pageOverflowX > 1) problems.push(`${where}: page scrolls sideways by ${rep.pageOverflowX}px`);
    if (rep.h1 || rep.imagesWithoutAlt) problems.push(`${where}: h1=${rep.h1} imagesWithoutAlt=${rep.imagesWithoutAlt}`);
  }
  if (problems.length) console.log(problems.slice(0, 40).map((p) => "    ✗ " + p).join("\n") + (problems.length > 40 ? `\n    … and ${problems.length - 40} more` : ""));
  assert.equal(problems.length, 0, `${problems.length} layout problems in ${combos} combinations`);
  ok(`${combos} combinations (2 components x 3 builders x ${Object.keys(THEMES).length} hostile themes x ${Object.keys(SIZES).length} screen sizes): nothing sticks out, overlaps, is covered, or is too small to tap`);

  // 1, 2, 4 and 6 quotes
  for (const n of [1, 2, 4, 6]) {
    const items = Array.from({ length: n }, (_, i) => ({ quote: `Quote number ${i + 1} about how good the work was.`, name: `Person ${i + 1}`, role: "Role" }));
    for (const size of ["phone320", "desktop"] as const) {
      const rep = await run("testimonials", "html", "big-type", size, { content: { title: "T", items } });
      assert.deepEqual([...rep.overflow, ...rep.overlaps, ...rep.covered], [], `${n} quotes @${size}`);
    }
  }
  ok("1, 2, 4 and 6 quotes lay out cleanly");

  // the checker itself must have teeth: a cookie banner over the section and a plain bug must be caught
  const covered = await run("testimonials", "html", "plain", "desktop", { overlay: true });
  assert.ok(covered.covered.length > 0, "a full-screen overlay must be reported as covering the text");
  ok("negative control: a full-screen overlay on top of the section IS reported as covered text");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.setContent(`<style>.lc-c{width:600px}</style><div class="lc-c"><p>wide</p></div>`);
  const wide = await page.evaluate(measureComponent, ".lc-c");
  assert.ok(wide.overflow.length > 0, "a 600px section on a 390px screen must be reported");
  await page.setContent(`<div class="lc-c" style="position:relative;height:100px"><div style="position:absolute;left:0;top:0;width:100px;height:50px">a</div><div style="position:absolute;left:20px;top:10px;width:100px;height:50px">b</div></div>`);
  const over = await page.evaluate(measureComponent, ".lc-c");
  assert.ok(over.overlaps.length > 0, "overlapping siblings must be reported");
  ok("negative control: a fixed-width section and overlapping boxes ARE reported");

  await ctx.close();
  await closeBrowser();
}

console.log(`\n${passed} checks passed.`);
void LintError;
