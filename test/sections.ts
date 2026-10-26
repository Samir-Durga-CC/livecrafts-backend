/**
 * The Section Gallery: every section passes the library checks, and "Add to this page" writes the right draft for
 * each kind of page (Elementor, blocks, Divi 4, classic) - and refuses a Divi 5 page clearly - without a real site.
 */
import assert from "node:assert/strict";
import { SECTIONS, CATEGORIES } from "../src/sections/library.js";
import { addSection, catalogue, coreCss, pageInfo, previewDocument, siteLook } from "../src/sections/place.js";
import { lintCss, lintHtml } from "../src/library/lint.js";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ok  ${name}`); };

// 1) the library itself
assert.deepEqual(lintCss(coreCss()).errors, [], "design system CSS passes");
for (const s of SECTIONS) {
  assert.deepEqual(lintCss(s.css).errors, [], `${s.id}: CSS passes`);
  assert.deepEqual(lintHtml(s.html).errors, [], `${s.id}: markup passes`);
  assert.ok(!/[\[\]]/.test(s.html), `${s.id}: no [ or ] (Divi would read them as shortcodes)`);
  assert.ok(!/\n/.test(s.html), `${s.id}: one line (Elementor's text editor adds paragraphs at line breaks)`);
  assert.ok(CATEGORIES.some((c) => c.id === s.category), `${s.id}: known category`);
  assert.ok(previewDocument(s.id, { brand: "#0f766e" }).includes("--lc-brand:#0f766e"), `${s.id}: preview takes the brand colour`);
}
assert.equal(new Set(SECTIONS.map((s) => s.id)).size, SECTIONS.length, "ids are unique");
assert.equal(catalogue().sections.length, SECTIONS.length);
ok(`${SECTIONS.length} sections pass the library checks`);

// 2) a fake site: records every change it is asked to make
function fakeBridge(page: { map: any; content: string; containers?: boolean }) {
  const writes: any[] = [];
  return {
    writes,
    bridge: {
      map: async () => page.map,
      post: async () => ({ content: page.content }),
      siteProfile: async () => ({ builders: { elementor: { active: true, containers: page.containers !== false, colors: [{ id: "primary", title: "Primary", value: "#123456" }, { id: "accent", title: "Accent", value: "#e4572e" }], fonts: [{ id: "primary", title: "Primary", family: "Poppins" }, { id: "text", title: "Text", family: "Inter" }] } }, brand: { colors: [], fonts: [] } }),
      makeChange: async (c: any) => { writes.push(c); return { ok: true, change: { id: writes.length, kind: c.kind } }; },
    } as any,
  };
}

const el = fakeBridge({ map: { builders: { elementor: true }, elementor_outline: [
  { id: "a1", type: "container", elType: "container", parent: "", index: 0, depth: 0, text: "" },
  { id: "a2", type: "heading", elType: "widget", parent: "a1", index: 0, depth: 1, text: "Welcome to Aeromatic" },
] }, content: "" });
const info = await pageInfo(el.bridge, 7);
assert.equal(info.builder, "elementor");
assert.deepEqual(info.places.map((p) => p.value), ["root:0", "root:1"]);
assert.match(info.places[1].label, /Welcome to Aeromatic/);
const r = await addSection(el.bridge, { id: "hero-split", postId: 7, place: "root:0" });
assert.equal(r.builder, "elementor");
assert.deepEqual(el.writes.map((w) => w.kind), ["css.block", "css.block", "el.insert"]);
const node = JSON.parse(el.writes[2].value);
assert.equal(node.elType, "container");
assert.equal(node.elements[0].widgetType, "text-editor");
assert.equal(el.writes[2].target, "root:0");
ok("Elementor: CSS once + a container with a text editor, at the chosen place");

const old = fakeBridge({ map: { builders: { elementor: true }, elementor_outline: [] }, content: "", containers: false });
await addSection(old.bridge, { id: "cta-band", postId: 7 });
assert.equal(JSON.parse(old.writes[2].value).elType, "section", "sites without containers get section > column");
ok("Elementor without containers: section > column");

const blocks = fakeBridge({ map: { builders: {} }, content: "<!-- wp:heading -->\n<h2>About</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>Text</p>\n<!-- /wp:paragraph -->" });
const bi = await pageInfo(blocks.bridge, 3);
assert.equal(bi.builder, "blocks");
assert.deepEqual(bi.places.map((p) => p.value), [":0", ":1", ":2"]);
await addSection(blocks.bridge, { id: "features-grid", postId: 3, place: ":1" });
assert.equal(blocks.writes[2].kind, "block.insert");
assert.equal(blocks.writes[2].target, ":1");
assert.match(blocks.writes[2].value, /^<!-- wp:group \{"align":"full"/);
assert.match(blocks.writes[2].value, /<!-- wp:html -->/);
ok("Blocks: a full-width group holding a Custom HTML block, after the chosen block");

const divi = fakeBridge({ map: { builders: {}, divi_outline: [
  { path: "0", module: "et_pb_section", label: "Section", layout: true },
  { path: "0.0.0.0", module: "et_pb_text", label: "Text", layout: false },
] }, content: "[et_pb_section][et_pb_row][et_pb_column type=\"4_4\"][et_pb_text]Hi[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]" });
const di = await pageInfo(divi.bridge, 9);
assert.equal(di.builder, "divi");
await addSection(divi.bridge, { id: "hero-band", postId: 9, place: "1" });
assert.equal(divi.writes[2].kind, "divi.insert");
assert.equal(divi.writes[2].target, "1");
ok("Divi 4: divi.insert at the chosen section index");

const divi5 = fakeBridge({ map: { builders: {} }, content: "<!-- wp:divi/section -->x<!-- /wp:divi/section -->" });
await assert.rejects(addSection(divi5.bridge, { id: "hero-band", postId: 9 }), /Divi 5/);
assert.equal(divi5.writes.length, 0, "nothing is written on a page it cannot handle");
ok("Divi 5: refused with a clear message, nothing written");

const classic = fakeBridge({ map: { builders: {} }, content: "<p>Old classic page</p>" });
const ci = await pageInfo(classic.bridge, 4);
assert.equal(ci.builder, "html");
await addSection(classic.bridge, { id: "cta-split", postId: 4, place: "end" });
assert.equal(classic.writes[2].kind, "post.field");
assert.ok(String(classic.writes[2].value).startsWith("<p>Old classic page</p>"), "classic: existing content kept first");
assert.match(String(classic.writes[2].value), /lcs-cta-split/);
ok("Classic: added to the page content, existing content kept");

await assert.rejects(addSection(classic.bridge, { id: "nope", postId: 4 }), /Unknown section/);
await assert.rejects(addSection(classic.bridge, { id: "cta-split", postId: 0 }), /Open the page/);
ok("Unknown section or no page: refused");

const look = await siteLook(el.bridge);
assert.equal(look.brand, "#e4572e", "the Elementor kit accent is the brand colour");
assert.equal(look.heading, "Poppins"); assert.equal(look.body, "Inter");
assert.match(look.fontsHref ?? "", /family=Poppins.*family=Inter/);
const themeOnly = { siteProfile: async () => ({ builders: { elementor: { active: false } }, brand: { colors: [{ slug: "primary", name: "Primary", value: "#1d4ed8" }], fonts: [] } }) } as any;
assert.equal((await siteLook(themeOnly)).brand, "#1d4ed8", "a block theme's primary colour is used without Elementor");
ok("Previews take the site's brand colour and fonts (Elementor kit, or the theme palette)");

console.log(`sections: ${passed} checks passed`);
