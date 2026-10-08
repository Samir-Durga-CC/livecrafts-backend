/**
 * End-to-end tests WITHOUT an LLM key or a real WordPress site:
 *   - a fake site with the Livecrafts plugin 0.10 API (test/fakeSite.ts): drafts, history, revert, notes, tokens
 *   - a scripted model plays the assistant (it calls tools in a fixed order)
 *   - the real HTTP API, JobRunner, ToolLoopAgent, tools, Bridge and widget sign-in run against them
 * Run:  npm test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-test-"));
process.env.LC_VERIFY_CHANGES = "0"; // real-browser checks are tested separately with a fake browser below
delete process.env.LC_API_TOKEN;
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");
const { secrets } = await import("../src/secrets.js");
const { makeTools } = await import("../src/tools.js");
const { Bridge } = await import("../src/bridge.js");
const { readUsage } = await import("../src/usage.js");
const { Verifier, expectationOf } = await import("../src/verify.js");
const { verifyWidgetToken } = await import("../src/auth.js");
const { call, say, scripted, mockModel } = await import("./mockModel.js");
const { startFakeSite } = await import("./fakeSite.js");

const fake = await startFakeSite();
const wp = fake.s;
const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const files = new FileStore();
let model: any = scripted([() => say("ok")]);
const runner = new JobRunner(jobs, sites, buildAgent(files, { model: { get provider() { return model.provider; }, get modelId() { return model.modelId; }, get specificationVersion() { return model.specificationVersion; }, get supportedUrls() { return model.supportedUrls; }, doGenerate: (o: any) => model.doGenerate(o), doStream: (o: any) => model.doStream(o) } as any, hostinger: null, browser: null }));
const runnerWith = (m: any, extra: any = {}) => new JobRunner(jobs, sites, buildAgent(files, { model: m, hostinger: null, browser: null, ...extra }));
const app = createApp(runner, sites, files);
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const api = `http://127.0.0.1:${(app.address() as any).port}`;
const http = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(api + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
async function settle(r: any, id: string, approve = true) {
  for (;;) {
    const j = await r.waitUntilSettled(id);
    if (j.status !== "waiting_approval" || !approve) return j;
    for (const p of j.pending) r.respond(id, p.approvalId, true);
  }
}

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };

// ------------------------------------------------------------------ 1) connecting a site
console.log("\n1) connect a site: credentials checked, the widget signing secret fetched");
const added = await http("POST", "/sites", { name: "Aero", url: fake.url, username: "admin", appPassword: "abcd efgh" });
assert.equal(added.status, 201); const site = sites.get(added.body.id)!;
ok("site saved after a successful ping");
assert.equal(secrets.siteSecret(site.id), wp.secret); assert.equal(added.body.widgetNote, null);
ok("the site's secret (for widget tokens) was fetched with the Application Password and stored on the backend");
assert.ok(!JSON.stringify(added.body).includes(wp.secret) && !JSON.stringify(added.body).includes("abcd")); ok("neither the secret nor the password is sent back");

// ------------------------------------------------------------------ 2) approve -> draft change
console.log("\n2) every change is a draft: approve → the plugin stores it as a draft, the live site stays");
{
  model = scripted([
    () => call("get_page_map", {}),
    () => call("make_change", { kind: "acf.field", target: "field_hero_title", value: "New Title", reason: "Change the hero title as requested" }),
    () => say("Changed the hero title to New Title (draft)."),
  ]);
  const job = runner.create(site.id, "change the hero title to New Title", undefined, [], { approvalMode: "every", pageUrl: fake.url + "/" });
  const paused = await runner.waitUntilSettled(job.id);
  assert.equal(paused.status, "waiting_approval"); assert.equal(wp.changes.length, 0); ok("paused for approval; nothing written before the yes");
  // a restarted server continues from the saved job
  const restarted = runnerWith(scripted([() => say("Changed the hero title to New Title (draft).")]));
  restarted.respond(job.id, paused.pending[0].approvalId, true);
  const done = await restarted.waitUntilSettled(job.id);
  assert.equal(done.status, "completed"); ok("continued after a 'restart' and completed");
  assert.equal(wp.changes.length, 1); assert.equal(wp.changes[0].status, "draft"); assert.equal(wp.live.field_hero_title, "Old Title");
  ok("exactly one DRAFT change in the site history; the live value is untouched");
  assert.equal(wp.changes[0].source, "assistant"); assert.equal(wp.changes[0].ref, `${job.id}#1`); ok("credited to the assistant, with the chat + request reference");
  assert.equal(done.changes![0].pluginId, wp.changes[0].id); assert.equal(done.changes![0].id, "lc_" + wp.changes[0].id); ok("the chat keeps a pointer to the site history entry");
  assert.ok(!fake.page(false).includes("New Title") && fake.page(true).includes("New Title")); ok("visitors see the live page, the preview shows the draft");
}

// ------------------------------------------------------------------ 3) widget sign-in + actor
console.log("\n3) the widget signs in per person; changes are credited to that person");
{
  const token = fake.widgetToken(7);
  const v = verifyWidgetToken(token, sites.list());
  assert.equal(v?.site.id, site.id); assert.equal(v?.user.login, "editor7"); ok("a token signed by the site verifies with its secret");
  assert.equal(verifyWidgetToken(token.slice(0, -2) + "xx", sites.list()), null); ok("a tampered token is refused");
  assert.equal(verifyWidgetToken(fake.widgetToken(7, { exp: Math.floor(Date.now() / 1000) - 5 }), sites.list()), null); ok("an expired token is refused");
  assert.equal(verifyWidgetToken(fake.widgetToken(7, { secret: "0".repeat(64) }), sites.list()), null); ok("a token signed with another secret is refused");
  assert.equal(verifyWidgetToken(fake.widgetToken(7, { site: "https://other.example" }), sites.list()), null); ok("a token for a site that is not connected is refused");

  const H = { "X-Livecrafts-Widget": token };
  assert.equal((await http("GET", "/integrations", undefined, H)).status, 403); ok("the widget cannot reach admin routes (integrations, keys)");
  const BAD = { "X-Livecrafts-Widget": token + "x" };
  assert.equal((await http("GET", "/sites", undefined, BAD)).status, 200); ok("no sign-in: a bad / expired / missing widget token still lets the chat work (unnamed)");
  assert.equal((await http("GET", "/integrations", undefined, BAD)).status, 403); ok("...but it still cannot reach admin routes (integrations, keys)");
  const other = sites.put({ id: "site_other", name: "Other", url: "https://other.example", username: "a", appPassword: "b", createdAt: new Date().toISOString() });
  const listed = await http("GET", "/sites", undefined, H);
  assert.deepEqual(listed.body.map((x: any) => x.id), [site.id]); ok("the widget sees only its own site");
  assert.equal((await http("POST", "/jobs", { siteId: other.id, prompt: "x" }, H)).status, 404); ok("it cannot start a chat on another site");
  sites.delete(other.id);

  model = scripted([() => call("make_change", { kind: "el.setting", target: "abc123:title", value: "Hello from Editor 7", reason: "New heading" }), () => say("Done.")]);
  const created = await http("POST", "/jobs", { siteId: site.id, prompt: "change the heading", approvalMode: "auto", pageUrl: fake.url + "/" }, H);
  assert.equal(created.status, 201);
  const done = await runner.waitUntilSettled(created.body.id);
  assert.equal(done.status, "completed");
  const c = wp.changes.at(-1)!;
  assert.equal(c.user.login, "editor7"); assert.ok(wp.seenActors.includes(token)); ok("the plugin received the person's token and credited the change to them (not the backend's account)");
  assert.deepEqual(done.actor, { name: "Editor 7", login: "editor7" }); ok("the chat records who is talking");
  const seen = await http("GET", `/jobs/${created.body.id}`, undefined, H);
  assert.equal(seen.status, 200); ok("the widget can follow its own chat");
}

// ------------------------------------------------------------------ 4) site context
console.log("\n4) the assistant starts informed: drafts, outside changes, notes");
{
  wp.notes.site = "Brand colours: #0B3D91 / #FFB400.";
  wp.notes.page = "Hero title = ACF field hero_title.";
  let system = "";
  model = mockModel(async (o: any) => { system = JSON.stringify(o.prompt.filter((m: any) => m.role === "system")); return say("ok"); });
  const job = runner.create(site.id, "what is going on?", undefined, [], { pageUrl: fake.url + "/" });
  await runner.waitUntilSettled(job.id);
  assert.match(system, /Drafts not deployed yet \(2\)/); ok("the drafts waiting to be deployed are in the instructions");
  assert.match(system, /Maria/); assert.match(system, /Elementor editor/); ok("a change made outside Livecrafts (Maria, in the Elementor editor) is known");
  assert.match(system, /#0B3D91/); assert.match(system, /hero_title/); ok("the site notes and this page's notes are read in");
  assert.match(system, /DRAFT/); assert.match(system, /cannot deploy/); ok("the assistant is told how drafts and deploying work");
}

// ------------------------------------------------------------------ 5) the tool set
console.log("\n5) tools: only drafts; no direct live writes; theme writes only when allowed");
{
  const names = Object.keys(makeTools(new Bridge(site), files, {}));
  for (const n of ["site_status", "site_history", "change_details", "read_notes", "write_notes", "get_page_map", "read_post", "make_change", "create_page", "revert_change"]) assert.ok(names.includes(n), n);
  ok("status, history, notes, page map, make_change, create_page, revert_change are there");
  for (const n of ["set_content", "edit_post_content", "set_post_status", "create_post", "create_menu", "add_menu_item", "style_patch", "undo_last_change", "deploy"]) assert.ok(!names.includes(n), n);
  ok("no tool writes to the live site directly, and there is no deploy tool");
  const sf: any = { list: async () => ({}), read: async () => ({}), edit: async () => ({}), create: async () => ({}), restore: async () => ({}) };
  assert.ok(!Object.keys(makeTools(new Bridge(site), files, { siteFiles: sf })).includes("edit_file")); ok("theme file writes (live at once) are not offered by default");
  assert.ok(Object.keys(makeTools(new Bridge(site), files, { siteFiles: sf, allowThemeWrites: true })).includes("edit_file")); ok("…only with LC_ALLOW_THEME_FILES=1");
  const css: any = await (makeTools(new Bridge(site), files, {}) as any).make_change.execute({ kind: "css.rule", target: "", value: JSON.stringify({ selector: ".x", media: "", declarations: { color: "red !important" } }), reason: "x" }, {});
  assert.equal(css.ok, false); assert.match(css.error, /important/); ok("JSON values reach the plugin as objects; its refusal comes back as a readable result");
}

// ------------------------------------------------------------------ 6) automatic checks after a change
console.log("\n6) every change is checked in a browser; the model hears the result");
{
  const verifier: any = { before: async () => null, after: async () => ({ passed: false, summary: "1 check failed: style color. Fix the change or revert it before reporting success.", checks: [{ name: "style color", ok: false, detail: "color is rgb(0, 0, 0), not rgb(11, 61, 145)" }] }) };
  let toolResult = "";
  const r = runnerWith(mockModel(async (o: any) => {
    const tool = o.prompt.filter((m: any) => m.role === "tool");
    if (!tool.length) return call("make_change", { kind: "acf.field", target: "field_hero_title", value: "Checked", reason: "x" });
    toolResult = JSON.stringify(tool.at(-1)); return say("The check failed, fixing it.");
  }), { verifier });
  const job = r.create(site.id, "change it", undefined, [], { approvalMode: "auto", pageUrl: fake.url + "/" });
  const done = await r.waitUntilSettled(job.id);
  assert.match(toolResult, /verification/); assert.match(toolResult, /another|not rgb\(11, 61, 145\)/); ok("the failed check is in the tool result the model reads");
  assert.equal(done.changes!.at(-1)!.verification!.passed, false); ok("the chat's change record shows the check failed");
  const end: any = done.events.find((e: any) => e.type === "tool_end" && e.data.tool === "make_change");
  assert.equal(end.data.ui.checks.passed, false); ok("the chat UI gets the check summary");

  // the checker itself, with a fake browser
  const audits: any[] = [];
  const v = new Verifier({
    siteUrl: fake.url, previewToken: async () => "tok", liveText: async () => "Old Title",
    audit: (async (_s: string, a: any, view: any) => {
      audits.push({ ...a, view });
      return { url: fake.url, device: a.device ?? "desktop", status: 200, fatal: null, overflowX: a.device === "mobile" ? 40 : 0, brokenImages: [], consoleErrors: [], lines: ["New Hero"],
        element: a.selector ? { selector: a.selector, found: true, visible: true, text: "", styles: [{ prop: "color", expected: "rgb(11, 61, 145)", actual: "rgb(0, 0, 0)", ok: false }] } : undefined };
    }) as any,
    compare: (async () => ({ changed: 0, bands: [] })) as any,
  });
  const res = await v.after(fake.url + "/", { kind: "css.rule", target: "rule-x", object: { id: 5 }, payload: { selector: ".hero", media: "", after: { color: "#0b3d91" } } }, null);
  assert.equal(res.passed, false); assert.ok(audits[0].view.preview === "tok"); ok("the draft view is opened with a preview token");
  assert.ok(res.checks.some((c) => c.name === "style color" && c.ok === false && /more specific selector/.test(c.detail))); ok("a style that does not win is reported with what to do (more specific selector, no !important)");
  assert.ok(res.checks.some((c) => c.name === "layout (mobile)" && c.ok === false)); ok("sideways scrolling on mobile is caught even for a desktop change");
  const t = await v.after(fake.url + "/", { kind: "acf.field", target: "field_hero_title", object: { id: 5 }, payload: { after: "New Hero", type: "text" } }, null);
  assert.ok(t.checks.some((c) => c.name === "draft text" && c.ok) && t.checks.some((c) => c.name === "live" && c.ok)); ok("text changes: shown in the draft view, not yet to visitors");
  assert.deepEqual(expectationOf({ kind: "el.setting", target: "abc123:hide_mobile", payload: { after: "yes", control: "switcher" } }), { selector: ".elementor-element-abc123", device: "mobile", hidden: true });
  assert.equal(expectationOf({ kind: "css.rule", payload: { selector: ".a", media: "tablet", after: { "font-size": "20px" } } }).device, "tablet"); ok("each kind of change knows what to look for and on which screen size");
}

// ------------------------------------------------------------------ 7) revert + diff from the chat's Changes panel
console.log("\n7) revert and diff of a change, through the site history");
{
  const first = wp.changes[0].id; // the hero title change of section 2
  const j = runner.list().find((x) => x.changes?.some((c) => c.pluginId === first))!;
  const c = j.changes!.find((x) => x.pluginId === first)!;
  const diff = await http("GET", `/jobs/${j.id}/changes/${c.id}/diff`);
  assert.equal(diff.status, 200); assert.equal(diff.body.before, "Old Title"); assert.equal(diff.body.after, "New Title"); ok("the diff comes from the site history (before → after)");
  const rv = await http("POST", `/jobs/${j.id}/changes/${c.id}/revert`);
  assert.equal(rv.status, 200); assert.equal(wp.changes.find((x) => x.id === c.pluginId)!.status, "discarded"); ok("reverting a draft drops it from the draft (the live site was never touched)");
}

// ------------------------------------------------------------------ 8) approval modes
console.log("\n8) approval modes");
{
  const before = wp.changes.length;
  const r = runnerWith(scripted([
    () => call("propose_plan", { summary: "Retitle", steps: ["Change the hero title", "Change the heading"] }),
    () => call("make_change", { kind: "acf.field", target: "field_hero_title", value: "Plan A", reason: "step 1" }),
    () => call("make_change", { kind: "el.setting", target: "abc123:title", value: "Plan B", reason: "step 2" }),
    () => say("Both done."),
  ]));
  const job = r.create(site.id, "retitle", undefined, [], { approvalMode: "request" });
  const w = await r.waitUntilSettled(job.id);
  assert.equal(w.pending[0].toolName, "propose_plan"); r.respond(job.id, w.pending[0].approvalId, true);
  const done = await r.waitUntilSettled(job.id);
  assert.equal(done.status, "completed"); assert.equal(wp.changes.length, before + 2); ok("once per request: one plan approval, then every step runs");
  const auto = runnerWith(scripted([() => call("make_change", { kind: "acf.field", target: "field_hero_title", value: "Auto", reason: "x" }), () => say("Done.")]));
  const aj = auto.create(site.id, "auto", undefined, [], { approvalMode: "auto" });
  assert.equal((await auto.waitUntilSettled(aj.id)).status, "completed"); ok("auto: no questions (still a draft, still checked)");
  const deny = runnerWith(scripted([() => call("make_change", { kind: "acf.field", target: "field_hero_title", value: "Nope", reason: "x" }), () => say("Understood.")]));
  const dj = deny.create(site.id, "deny", undefined, [], { approvalMode: "every" });
  const dw = await deny.waitUntilSettled(dj.id); const n = wp.changes.length;
  deny.respond(dj.id, dw.pending[0].approvalId, false, "no");
  await deny.waitUntilSettled(dj.id); assert.equal(wp.changes.length, n); ok("a denied change is never written");
}

// ------------------------------------------------------------------ 9) usage + logs
console.log("\n9) every model call is logged with its tokens");
{
  const rows = readUsage(new Date().toISOString().slice(0, 7));
  assert.ok(rows.length >= 5); assert.ok(rows.every((r) => r.site && r.job && typeof r.input === "number" && typeof r.output === "number" && r.model));
  ok(`${rows.length} model calls recorded with site, chat, model and token counts`);
  assert.ok(rows.some((r) => r.user === "editor7")); ok("calls made for a widget chat name the person");
  const j = runner.list()[0];
  assert.ok(j.usage && j.usage.calls >= 1); ok("each chat sums up its own usage");
}

console.log(`\nALL GOOD: ${passed} checks passed.\n`);
app.close(); fake.close();
process.exit(0);
