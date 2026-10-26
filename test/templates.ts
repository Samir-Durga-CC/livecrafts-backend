/**
 * Template library logic (pure): shortcode building, escaping, fit from the measured site, placement per builder.
 * Run:  node --import tsx test/templates.ts
 */
import assert from "node:assert/strict";
import { TemplateError, buildShortcode, cleanFit, fitFromDesign, placeShortcode, templateRules, type TemplateEntry } from "../src/library/templates.js";

let passed = 0;
const ok = (n: string) => { passed++; console.log("  ✓ " + n); };
const hero: TemplateEntry = { id: "hero", shortcode: "ai_hero", title: "hero", params: "", example: "", attributes: ["heading", "text", "primary_label"], defaults: {}, list: false, item_fields: "" };
const faq: TemplateEntry = { id: "faq", shortcode: "ai_faq", title: "faq", params: "", example: "", attributes: ["heading"], defaults: {}, list: true, item_fields: "title, text" };

console.log("\n1) shortcodes");
{
  const { code } = buildShortcode(hero, { attrs: { heading: 'Say "hi" [now]', text: "line\nbreak" }, fit: { max: "1140px" } });
  assert.equal(code, '[ai_hero heading="Say ”hi” (now)" text="line break" max="1140px"]');
  ok("quotes, brackets and line breaks cannot break out of the shortcode");
  const f = buildShortcode(faq, { attrs: { heading: "Q" }, items: [{ title: "A?", text: "Yes." }, { title: "B?", text: "No." }] });
  assert.equal(f.code, '[ai_faq heading="Q"][ai_item title="A?" text="Yes."][ai_item title="B?" text="No."][/ai_faq]');
  ok("list templates take rows as attributes (nothing a page builder can wrap in <p>)");
  assert.throws(() => buildShortcode(hero, { attrs: { nope: "x" } }), TemplateError);
  assert.throws(() => buildShortcode(hero, { items: [{ a: "b" }] }), /no list rows/);
  assert.throws(() => buildShortcode(faq, { items: Array.from({ length: 25 }, () => ({ title: "x" })) }), /at most 24/);
  assert.throws(() => buildShortcode(hero, { attrs: { heading: { x: 1 } as any } }), /plain text/);
  ok("unknown attributes, rows on a non-list template and object values are refused with a message");
}

console.log("\n2) fit values");
{
  const { fit, dropped } = cleanFit({ max: "1140px", brand: "#0f766e", py: "url(x)", radius: "8px;color:red", evil: "1", font: "Inter, sans-serif" });
  assert.deepEqual(fit, { max: "1140px", brand: "#0f766e", font: "Inter, sans-serif" });
  assert.equal(dropped.length, 3);
  ok("only plain colours / lengths / fonts pass; injection attempts are dropped and reported");
}

console.log("\n3) fit from the measured site");
{
  const r = fitFromDesign({
    containerMaxWidth: "1200px",
    layout: { sections: [{ width: 1280, height: 600, paddingTop: 96, paddingBottom: 96, contentWidth: 1140 }, { width: 1280, height: 500, paddingTop: 80, paddingBottom: 80, contentWidth: 1140 }, { width: 1280, height: 480, paddingTop: 96, paddingBottom: 96, contentWidth: 960 }], typicalContentWidth: 1140, typicalPaddingY: 96, typicalSectionHeight: 500 },
    button: { background: "rgb(15, 118, 110)", radius: "8px" }, pageBackground: "rgb(255, 255, 255)", pageColor: "rgb(17, 24, 39)",
  });
  assert.deepEqual(r.fit, { max: "1140px", py: "96px", py_sm: "58px", radius: "8px", brand: "#0f766e", surface: "#ffffff", ink: "#111827" });
  assert.ok(r.basis.some((b) => /median of 3 sections/.test(b)));
  ok("content width + padding come from the site's own sections (median), radius and brand from its buttons");
  const dark = fitFromDesign({ pageBackground: "rgb(20, 20, 20)", pageColor: "rgb(30, 30, 30)", button: { background: "rgb(120, 120, 120)", radius: "0px" } });
  assert.equal(dark.fit.surface, undefined);
  assert.equal(dark.fit.brand, undefined);
  assert.equal(dark.fit.radius, "0px");
  ok("unreadable background/text pairs and grey buttons are not copied");
  assert.deepEqual(fitFromDesign(null).fit, {});
  ok("no measurement = neutral defaults, said plainly");
}

console.log("\n4) placement per builder");
{
  const el = placeShortcode("[ai_hero]", "elementor", "hero");
  assert.equal(el.kind, "el.insert");
  const node: any = el.value;
  assert.equal(node.elType, "container");
  assert.equal(node.elements[0].widgetType, "shortcode");
  assert.equal(node.elements[0].settings.shortcode, "[ai_hero]");
  const bl = placeShortcode("[ai_hero]", "blocks", "hero");
  assert.equal(bl.kind, "block.insert");
  assert.equal(bl.value, "<!-- wp:shortcode -->\n[ai_hero]\n<!-- /wp:shortcode -->");
  assert.equal(placeShortcode("[ai_hero]", "html", "hero").kind, "block.insert");
  ok("Elementor: container + shortcode widget; blocks / classic: shortcode block");
}

console.log("\n6) the content rules a template expects");
{
  // Both of these went out on a real footer: "© © 2026 AEROMATIC LABS", and one column with three empty gaps.
  const footer: TemplateEntry = {
    id: "footer", shortcode: "ai_footer", title: "footer", params: "", example: "",
    attributes: ["logo_text", "copyright"], defaults: {}, list: true, item_fields: "label, url, group",
  };
  const doubled = buildShortcode(footer, { attrs: { copyright: "© 2026 Aeromatic Labs" } });
  assert.match(doubled.code, /copyright="2026 Aeromatic Labs"/);
  assert.match(doubled.warnings.join(" "), /prints © itself/);
  assert.match(buildShortcode(footer, { attrs: { copyright: "&copy; 2026 Acme" } }).code, /copyright="2026 Acme"/);
  assert.doesNotMatch(buildShortcode(footer, { attrs: { copyright: "2026 Acme" } }).warnings.join(" "), /prints ©/);
  ok("a © passed into the copyright is taken off, because the template prints one itself");

  const oneGroup = buildShortcode(footer, { items: [1, 2, 3, 4].map((n) => ({ label: `L${n}`, url: "/", group: "Company" })) });
  assert.match(oneGroup.warnings.join(" "), /one column per group/);
  const spread = buildShortcode(footer, { items: [{ label: "A", url: "/", group: "Company" }, { label: "B", url: "/", group: "Product" }, { label: "C", url: "/", group: "Legal" }] });
  assert.equal(spread.warnings.length, 0);
  assert.equal(buildShortcode(footer, { items: [{ label: "A", url: "/", group: "Company" }, { label: "B", url: "/", group: "Company" }] }).warnings.length, 0);
  ok("every row in one group is flagged: the template lays out one column per group");

  const rules = templateRules(footer).join(" ");
  assert.match(rules, /prints © itself/);
  assert.match(rules, /ONE COLUMN PER GROUP/);
  assert.equal(templateRules(hero).length, 0);
  ok("get_component states those rules for the templates they apply to, and nothing for the others");
}

console.log(`\n${passed} template checks passed`);
