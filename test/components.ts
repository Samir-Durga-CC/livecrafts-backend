/**
 * The assistant's component tools end to end (scripted model, fake Livecrafts 0.12 site): site_profile, find_components,
 * place_component (library + site), content errors, and the zero-token "undo" in English and Hindi.
 * Run:  node --import tsx test/components.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-comp-"));
process.env.LC_VERIFY_CHANGES = "0";
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { quickCommand } = await import("../src/quick.js");
const { call, say, mockModel } = await import("./mockModel.js");
const { startFakeSite } = await import("./fakeSite.js");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };

const fake = await startFakeSite();
const wp = fake.s;
const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const site = sites.put({ id: "site_comp", name: "Aero", url: fake.url, username: "admin", appPassword: "x y z", createdAt: new Date().toISOString() });

async function runAll(runner: any, jobId: string) {
  for (;;) {
    const j = await runner.waitUntilSettled(jobId);
    if (j.status !== "waiting_approval") return j;
    for (const p of j.pending) runner.respond(jobId, p.approvalId, true);
  }
}

console.log("\n1) quick commands");
{
  for (const t of ["undo", "Revert that", "please undo the last change", "go back", "wapas kar do", "वापस कर दो", "पहले जैसा कर दो", "undo everything", "सब वापस कर दो"]) assert.ok(quickCommand(t), t);
  for (const t of ["revert the header colour to blue", "undo the footer link and make it red", "make the title bigger", "what is a revert?", "", "वापस जाओ और हेडर का रंग नीला करो"]) assert.equal(quickCommand(t), null, t);
  assert.equal(quickCommand("undo everything")?.all, true);
  ok("short undo phrases in English / Hindi / Hinglish are recognised; anything more specific goes to the model");
}

console.log("\n2) find -> place (library) -> undo, without a model for the undo");
{
  let step = 0, modelCalls = 0, findResult: any, placeResult: any, profile: any;
  const model = mockModel(async ({ prompt }: any) => {
    modelCalls++;
    const results = prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result");
    const last = (name: string) => results.filter((r: any) => r.toolName === name).at(-1)?.output?.value;
    step++;
    if (step === 1) return call("site_profile", {});
    if (step === 2) { profile = last("site_profile"); return call("find_components", { query: "add a testimonial section" }); }
    if (step === 3) { findResult = last("find_components"); return call("place_component", { source: "library", id: "testimonials", brand: "#1d4ed8", content: { title: "Kind words", items: [{ quote: "They fixed our site in a day.", name: "Maria", role: "Owner" }] }, reason: "Add testimonials" }); }
    if (step === 4) { placeResult = last("place_component"); return say("Added the testimonials section as a draft."); }
    return say("ok");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null }));
  const job = runner.create(site.id, "add a testimonials section", undefined, [], { approvalMode: "request" });
  const done = await runAll(runner, job.id);
  assert.equal(done.status, "completed");

  assert.equal(profile.ok, true); assert.equal(profile.elementor.testimonialWidget, true); assert.equal(profile.forms[0].shortcode, '[contact-form-7 id="5"]');
  ok("site_profile reports the builder, widgets, global colours and the site's forms");
  assert.equal(findResult.pageBuilder, "elementor");
  assert.equal(findResult.results[0].source, "site"); assert.equal(findResult.results[0].id, "el-section:5:3ac5722");
  assert.ok(findResult.results.some((r: any) => r.source === "library" && r.id === "testimonials"));
  assert.match(findResult.beforeYouBuild, /section-design/);
  ok("find_components ranks the site's own section first, then the library, and reminds about the skills");

  assert.equal(placeResult.ok, true, JSON.stringify(placeResult).slice(0, 300));
  const css = wp.changes.filter((c) => c.kind === "css.block").map((c) => c.target).sort();
  assert.deepEqual(css, ["lc-c-testimonials", "lc-core", "lc-tokens"]);
  const insert = wp.changes.find((c) => c.kind === "el.insert")!;
  assert.ok(insert); const node = JSON.parse(String(insert.payload.after));
  assert.equal(node.elType, "container"); assert.match(node.settings.css_classes, /lc-testimonials/);
  assert.ok(JSON.stringify(node).includes("They fixed our site in a day."));
  assert.equal(placeResult.placeholders, false); assert.equal(insert.target, "root:end");
  ok("place_component wrote the core CSS, the component CSS, the brand tokens and the Elementor section (4 drafts)");
  assert.equal(done.changes.length, 4);
  ok("all four drafts are in the Changes ledger of the chat (each can be reverted)");

  const callsBefore = modelCalls;
  runner.continue(job.id, "undo");
  const after: any = await runner.waitUntilSettled(job.id);
  assert.equal(modelCalls, callsBefore, "undo must not call the model");
  assert.equal(wp.changes.filter((c) => c.status === "draft" && ["css.block", "el.insert"].includes(c.kind)).length, 0);
  assert.ok(after.changes.every((c: any) => c.revertedAt));
  assert.match(after.result, /4 changes reverted/);
  ok("\"undo\" reverted all four from the ledger with ZERO model calls");

  runner.continue(job.id, "undo");
  assert.match(((await runner.waitUntilSettled(job.id)) as any).result, /nothing to undo/i);
  ok("a second undo says there is nothing to undo");
}

console.log("\n2b) template library: find -> usage -> place (fit auto, no browser) -> proof");
{
  let step = 0, findResult: any, getResult: any, placeResult: any, badResult: any, usage: any;
  const model = mockModel(async ({ prompt }: any) => {
    const results = prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result");
    const last = (name: string) => results.filter((r: any) => r.toolName === name).at(-1)?.output?.value;
    step++;
    if (step === 1) return call("find_components", { query: "add an FAQ with questions" });
    if (step === 2) { findResult = last("find_components"); return call("get_component", { source: "template", id: "faq" }); }
    if (step === 3) { getResult = last("get_component"); return call("place_component", { source: "template", id: "faq", attrs: { heading: "Questions", bogus: "x" }, reason: "FAQ" }); }
    if (step === 4) { badResult = last("place_component"); return call("place_component", { source: "template", id: "faq", attrs: { heading: "Questions" }, items: [{ title: "Do you ship?", text: "Yes, worldwide." }], fit: { max: "1140px", brand: "#0f766e" }, reason: "FAQ" }); }
    if (step === 5) { placeResult = last("place_component"); return call("template_usage", {}); }
    if (step === 6) { usage = last("template_usage"); return say("Added the FAQ template as a draft."); }
    return say("ok");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null }));
  const job = runner.create(site.id, "add an FAQ", undefined, [], { approvalMode: "request" });
  const done = await runAll(runner, job.id);
  assert.equal(done.status, "completed");

  const tpl = findResult.results.find((r: any) => r.source === "template");
  assert.equal(tpl.id, "faq"); assert.match(findResult.templateRule, /prefer it/);
  ok("find_components lists the matching template (FAQ for 'questions') with a rule to prefer it");
  assert.equal(getResult.takesListRows, true); assert.equal(getResult.rowFields, "title, text");
  ok("get_component shows the template's attributes and row fields");
  assert.equal(badResult.ok, false); assert.match(badResult.error, /no attribute "bogus"/);
  ok("an unknown attribute is refused with the list of valid ones (nothing written)");

  assert.equal(placeResult.ok, true, JSON.stringify(placeResult).slice(0, 300));
  const insert = wp.changes.filter((c) => c.kind === "el.insert").at(-1)!;
  const node = JSON.parse(String(insert.payload.after));
  assert.equal(node.elements[0].widgetType, "shortcode");
  assert.equal(node.elements[0].settings.shortcode, '[ai_faq heading="Questions" max="1140px" brand="#0f766e"][ai_item title="Do you ship?" text="Yes, worldwide."][/ai_faq]');
  assert.ok(wp.changes.some((c) => c.kind === "css.block" && c.target === "lc-tpl"));
  ok("the section is ONE shortcode in an Elementor container (+ the wrapper CSS), with the explicit fit inside it");
  assert.equal(placeResult.usedTemplate.id, "faq"); assert.match(placeResult.usedTemplate.seeIt, /lc_templates=1$/);
  ok("the result says which template was used and where to see it outlined (?lc_templates=1)");
  assert.equal(usage.active, true); assert.equal(usage.used[0].template, "faq"); assert.equal(usage.used[0].usedOn[0].page, "Home");
  ok("template_usage answers which templates are used on which pages");
}

console.log("\n2b2) template guards: own section only, real content only, never a hand-written shortcode");
{
  let step = 0; const out: any[] = [];
  const model = mockModel(async ({ prompt }: any) => {
    const results = prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result");
    const last = (name: string) => results.filter((r: any) => r.toolName === name).at(-1)?.output?.value;
    step++;
    if (step === 1) return call("place_component", { source: "template", id: "faq", position: "9795140:0", attrs: { heading: "Questions" }, items: [{ title: "Q", text: "A" }], reason: "x" });
    if (step === 2) { out.push(last("place_component")); return call("place_component", { source: "template", id: "faq", attrs: { heading: "Questions" }, items: [{ title: "Do you ship?", text: "Placeholder answer" }], reason: "x" }); }
    if (step === 3) { out.push(last("place_component")); return call("make_change", { kind: "el.insert", target: "root:end", value: JSON.stringify({ elType: "container", elements: [{ elType: "widget", widgetType: "shortcode", settings: { shortcode: "[ai_faq heading=\"x\"]" } }] }), reason: "x" }); }
    if (step === 4) { out.push(last("make_change")); return say("done"); }
    return say("ok");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null }));
  const job = runner.create(site.id, "add faq", undefined, [], { approvalMode: "request" });
  await runAll(runner, job.id);
  assert.match(out[0].error, /section of its own/); ok("a template inside another section's container is refused");
  assert.match(out[1].error, /sample text/); ok("sample / placeholder content is refused: the agent must ask for real content");
  assert.match(out[2].error, /not written by hand/); ok("a hand-written [ai_...] shortcode is refused");
}

console.log("\n2c) a template wins over the native library component it replaces");
{
  wp.tplExtra = true;
  let findResult: any, placeResult: any, step = 0;
  const model = mockModel(async ({ prompt }: any) => {
    const results = prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result");
    const last = (name: string) => results.filter((r: any) => r.toolName === name).at(-1)?.output?.value;
    step++;
    if (step === 1) return call("find_components", { query: "add a testimonial section" });
    if (step === 2) { findResult = last("find_components"); return call("place_component", { source: "library", id: "testimonials", reason: "x" }); }
    if (step === 3) { placeResult = last("place_component"); return say("ok"); }
    return say("ok");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null }));
  const before = wp.changes.length;
  const job = runner.create(site.id, "add testimonials", undefined, [], { approvalMode: "request" });
  await runAll(runner, job.id);
  assert.ok(findResult.results.some((r: any) => r.source === "template" && r.id === "testimonials"));
  assert.ok(!findResult.results.some((r: any) => r.source === "library"));
  assert.equal(placeResult.ok, false); assert.match(placeResult.error, /source "template" id "testimonials"/);
  assert.equal(wp.changes.length, before);
  wp.tplExtra = false;
  ok("find_components hides the library duplicate; placing it anyway is refused with the template to use (nothing written)");
}

console.log("\n3) Hindi undo, wording and reply language");
{
  let step = 0, modelCalls = 0;
  const model = mockModel(async () => { modelCalls++; step++; return step === 1 ? call("place_component", { source: "library", id: "contact", content: { title: "संपर्क करें", details: [{ kind: "email", value: "hi@acme.test" }] }, reason: "x" }) : say("हो गया।"); });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null }));
  const job = runner.create(site.id, "संपर्क सेक्शन जोड़ो", undefined, [], { approvalMode: "request" });
  await runAll(runner, job.id);
  const n = modelCalls;
  runner.continue(job.id, "वापस कर दो");
  const j: any = await runner.waitUntilSettled(job.id);
  assert.equal(modelCalls, n);
  assert.match(j.result, /बदलाव वापस कर दिए/);
  ok("a Hindi voice command reverts from the ledger and answers in Hindi, with no model call");
}

console.log("\n4) errors are explained, nothing half-written");
{
  let step = 0, out: any;
  const before = wp.changes.length;
  const model = mockModel(async ({ prompt }: any) => {
    step++;
    const r = prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result").at(-1);
    if (step === 1) return call("place_component", { source: "library", id: "testimonials", content: { title: "T", items: [{ quote: "x".repeat(600), name: "n" }] }, reason: "x" });
    if (step === 2) { out = r?.output?.value; return call("place_component", { source: "library", id: "pricing", reason: "x" }); }
    return say("done");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null }));
  const job = runner.create(site.id, "x", undefined, [], { approvalMode: "auto" });
  const j: any = await runner.waitUntilSettled(job.id);
  assert.equal(out.ok, false); assert.match(out.error, /too long/);
  const second = j.messages.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result").at(-1).output.value;
  assert.match(second.error, /Unknown library component/);
  assert.equal(wp.changes.length, before, "nothing was written");
  ok("too long content and an unknown component are refused with a clear message and write nothing");
}

fake.close();
console.log(`\n${passed} checks passed.`);
process.exit(0);
