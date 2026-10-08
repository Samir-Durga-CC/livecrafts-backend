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
  assert.equal(node.elType, "container"); assert.match(node.settings._css_classes, /lc-testimonials/);
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
