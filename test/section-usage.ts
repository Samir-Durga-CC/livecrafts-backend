/** The Section Gallery's counter: old adds imported once from the log, new adds counted, totals per section and site. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-su-"));
fs.mkdirSync(path.join(process.env.LC_DATA_DIR, "logs"));
fs.writeFileSync(path.join(process.env.LC_DATA_DIR, "logs", "2026-10-26.jsonl"), [
  { at: "2026-10-26T09:51:06.693Z", level: "info", msg: "section added: hero-band", site: "site_a", post: 5, place: ":1", builder: "blocks" },
  { at: "2026-10-26T09:52:00.000Z", level: "info", msg: "something else", site: "site_a" },
  { at: "2026-10-26T09:53:00.000Z", level: "info", msg: "section added: hero-split", site: "site_a", post: 5, place: "end", builder: "theme" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const { readSectionUses, recordSectionUse, sectionUsageReport } = await import("../src/sections/usage.js");
const { SECTIONS } = await import("../src/sections/library.js");

assert.equal(readSectionUses().length, 2, "the two adds logged before the counter are imported");
assert.equal(readSectionUses().length, 2, "imported once only");
recordSectionUse({ site: "site_b", section: "hero-split", post: 9, place: "end", builder: "elementor", user: "Dhara" });
recordSectionUse({ site: "site_b", section: "hero-split", post: 9, place: "root:0", builder: "elementor" });
const r = sectionUsageReport(readSectionUses(), [{ id: "site_a", name: "Aeromatic", url: "https://a.test" }, { id: "site_b", name: "Troikaa", url: "https://b.test" }]);
assert.deepEqual(r.totals, { adds: 4, websites: 2, sectionsUsed: 2, sections: SECTIONS.length, since: "2026-10-26T09:51:06.693Z" });
const hs = r.sections[0];
assert.equal(hs.id, "hero-split"); assert.equal(hs.count, 3); assert.equal(hs.siteCount, 2);
assert.deepEqual(hs.sites.map((s) => [s.name, s.count]), [["Troikaa", 2], ["Aeromatic", 1]]);
assert.equal(r.sections.length, SECTIONS.length, "every gallery section is listed, used or not");
assert.equal(r.sections.filter((s) => s.count === 0).length, SECTIONS.length - 2);
assert.deepEqual(r.websites.map((w) => [w.name, w.count, w.sections]), [["Troikaa", 2, 1], ["Aeromatic", 2, 2]]);
console.log("section usage: all checks passed");
