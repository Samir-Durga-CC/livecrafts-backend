/**
 * The change checker in a REAL headless browser (Edge/Chrome on this machine) against the fake site:
 * draft view through a preview token, text present in the draft and absent for visitors, element styles,
 * health, text diff and screenshot diff. Skips itself when no browser is installed.
 *   node --import tsx test/verify-browser.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-vb-"));
const { Verifier } = await import("../src/verify.js");
const { closeBrowser, auditPage } = await import("../src/browser.js");
const { htmlToText } = await import("../src/bridge.js");
const { startFakeSite } = await import("./fakeSite.js");

const fake = await startFakeSite();
let passed = 0;
const ok = (n: string) => { passed++; console.log("  ✓ " + n); };
const token = async () => (await (await fetch(fake.url + "/wp-json/livecrafts/v1/preview-token", { method: "POST" })).json()).token as string;

try {
  await auditPage(fake.url, {});
} catch (e) {
  if (/No browser available/.test(String((e as Error).message))) { console.log("  - skipped: no Edge/Chrome on this machine"); process.exit(0); }
  throw e;
}

console.log("\nchange checker in a real browser");
const v = new Verifier({ siteUrl: fake.url, previewToken: token, liveText: async (u) => htmlToText(await (await fetch(u)).text()) });
const url = fake.url + "/";
const before = await v.before(url);
assert.ok(before && before.shot && before.lines.includes("Old Title")); ok("before: the draft page's text and a screenshot");

// make a draft change the way the plugin would
const r = await (await fetch(fake.url + "/wp-json/livecrafts/v1/changes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "acf.field", target: "field_hero_title", value: "A Much Longer Hero Title For The Check" }) })).json() as any;
const res = await v.after(url, { ...r.change, payload: { ...r.change.payload, type: "text" } }, before);
const by = (n: string) => res.checks.find((c) => c.name === n);
assert.equal(by("draft text")?.ok, true); ok("draft view (preview token) shows the new text");
assert.equal(by("live")?.ok, true); ok("visitors do not see it yet");
assert.equal(by("loads (desktop)")?.ok, true); ok("the page loads (HTTP 200)");
assert.match(by("text diff")?.detail ?? "", /added: 1.*removed: 1/); ok("text diff: one line replaced");
assert.match(by("visual diff")?.detail ?? "", /% of the page looks different|looks the same/); ok("screenshot diff computed: " + by("visual diff")?.detail.slice(0, 70));
assert.equal(res.passed, true); ok("all checks passed");

const style = await v.after(url, { kind: "css.rule", target: "rule-x", object: { id: 5 }, payload: { selector: "h1.hero", media: "", after: { color: "#0b3d91" } } }, null);
const sc = style.checks.find((c) => c.name === "style color")!;
assert.equal(sc.ok, false); assert.match(sc.detail, /rgb\(11, 61, 145\)/); ok("a style that is not applied is caught with the computed values (" + sc.detail.slice(0, 50) + "…)");
const missing = await v.after(url, { kind: "block.text", target: "9", object: { id: 5 }, payload: { after: "x" } }, null);
assert.equal(missing.checks.find((c) => c.name === "element")?.ok, false); ok("a missing element is reported");

await closeBrowser(); fake.close();
console.log(`\nALL GOOD: ${passed} checks passed.\n`);
process.exit(0);
