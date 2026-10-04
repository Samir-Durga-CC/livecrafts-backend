/**
 * End-to-end smoke test WITHOUT an LLM key or a real WordPress site:
 *   - a fake "WordPress" HTTP server imitates the Livecrafts plugin (ping / map / debug/target / target) and serves a page
 *   - a scripted MockLanguageModel plays the model (it calls tools in a fixed order)
 *   - the real JobRunner + ToolLoopAgent + tools + Bridge run against them
 * Run:  npm test   (needs Node 22+)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-test-"));
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");

// ------------------------------------------------------------------ fake WordPress
const wp = { title: "Old Title", posts: [] as any[], mode: "ok" as "ok" | "broken", authSeen: [] as string[] };
const fakeWp = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  const body = await new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  const json = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const route = u.pathname.replace("/wp-json/livecrafts/v1/", "");
  if (u.pathname.startsWith("/wp-json/")) wp.authSeen.push(String(req.headers.authorization));
  if (route === "ping") { return json(200, { ok: true, plugin: "livecrafts", version: "0.6.0", capabilities: { acf: true, elementor: false } }); }
  if (wp.mode === "broken" && route === "map") return json(401, { code: "rest_forbidden", message: "Sorry, you are not allowed to do that." });
  if (route === "map") return json(200, { ok: true, post: { id: 5, title: "Home", url: "http://localhost/" }, builders: { acf_fields: 1 }, elementor: [], acf: [{ kind: "acf", tid: "acf:field_hero_title:5", label: "Title", name: "hero_title", ftype: "text", value: wp.title }] });
  if (route === "debug/target") return json(200, { stored_raw: wp.title });
  if (route === "target" && req.method === "POST") { const b = JSON.parse(body); wp.posts.push(b); wp.title = b.value; return json(200, { ok: true, value: b.value, verified: { database: true } }); }
  if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<html><body><script>var x=1</script><h1>${wp.title}</h1></body></html>`); }
  json(404, { code: "rest_no_route", message: "No route" });
});
await new Promise<void>((r) => fakeWp.listen(0, "127.0.0.1", r));
const wpUrl = `http://127.0.0.1:${(fakeWp.address() as any).port}`;

// ------------------------------------------------------------------ scripted model (streams, like a real one)
const { call, say, scripted, mockModel } = await import("./mockModel.js");

const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const files = new FileStore();
const site = sites.put({ id: "site_test", name: "Fake WP", url: wpUrl, username: "admin", appPassword: "abcd efgh", createdAt: new Date().toISOString() });
const runnerFor = (model: any) => new JobRunner(jobs, sites, buildAgent(files, { model }));

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };

// ------------------------------------------------------------------ 1) approve path
console.log("\n1) approve: map -> set_content (pauses) -> approve -> verify -> done");
{
  const runner = runnerFor(scripted([
    () => call("get_page_map", {}),
    () => call("set_content", { target: "acf:field_hero_title:5", value: "New Title", reason: "Change the hero title as requested" }),
    () => call("verify_page", { url: wpUrl + "/", expectPresent: ["New Title"], expectAbsent: ["Old Title"] }),
    () => say("Changed the hero title from Old Title to New Title and verified it on the public page."),
  ]));
  const job = runner.create(site.id, "change the hero title to New Title");
  const paused = await runner.waitUntilSettled(job.id);
  assert.equal(paused.status, "waiting_approval"); ok("job paused for approval");
  assert.equal(wp.posts.length, 0); ok("nothing was written before approval");
  assert.equal(paused.pending[0].toolName, "set_content");
  assert.equal((paused.pending[0] as any).current, "Old Title"); ok("approval card carries the CURRENT value (for a before/after diff)");
  assert.match(wp.authSeen[0] ?? "", /^Basic /) ; ok("bridge authenticates with an Application Password (Basic auth)");

  // "browser closed": a brand-new runner (like a restarted server) continues from the saved job
  const restarted = runnerFor(scripted([
    () => call("verify_page", { url: wpUrl + "/", expectPresent: ["New Title"], expectAbsent: ["Old Title"] }),
    () => say("Changed and verified."),
  ]));
  restarted.respond(job.id, paused.pending[0].approvalId, true);
  const done = await restarted.waitUntilSettled(job.id);
  assert.equal(done.status, "completed"); ok("job continued after a 'restart' and completed");
  assert.equal(wp.posts.length, 1); assert.equal(wp.posts[0].value, "New Title"); ok("exactly one write, with the right value");
  const verify = done.events.find((e: any) => e.type === "tool_end" && e.data.tool === "verify_page");
  assert.ok(verify && verify.data.ok); ok("verify_page confirmed the PUBLIC page shows the new title");
  assert.match(done.result ?? "", /verified/i); ok("final answer reported the verification");
}

// ------------------------------------------------------------------ 2) deny path
console.log("\n2) deny: set_content is refused -> no write, model told not to retry");
{
  wp.title = "Old Title"; wp.posts.length = 0;
  const runner = runnerFor(scripted([
    () => call("get_page_map", {}),
    () => call("set_content", { target: "acf:field_hero_title:5", value: "Nope", reason: "test" }),
    () => say("Understood - I will not change it."),
  ]));
  const job = runner.create(site.id, "change the hero title to Nope");
  const paused = await runner.waitUntilSettled(job.id);
  runner.respond(job.id, paused.pending[0].approvalId, false, "Not now");
  const done = await runner.waitUntilSettled(job.id);
  assert.equal(done.status, "completed"); assert.equal(wp.posts.length, 0); assert.equal(wp.title, "Old Title");
  ok("denied change was NOT written; job still finished cleanly");
}

// ------------------------------------------------------------------ 3) failing site
console.log("\n3) failure: site rejects the credentials -> tool error is handled, loop does not crash");
{
  wp.mode = "broken";
  const runner = runnerFor(scripted([() => call("get_page_map", {}), () => say("I could not read the page: the site rejected my login.")]));
  const job = runner.create(site.id, "change the hero title");
  const done = await runner.waitUntilSettled(job.id);
  assert.equal(done.status, "completed");
  const te = done.events.find((e: any) => e.type === "tool_end")!;
  assert.equal(te.data.ok, false); assert.match(String(te.data.error), /Application Password|not allowed/i);
  ok("401 from the site became a readable tool error with a helpful hint"); wp.mode = "ok";
}

// ------------------------------------------------------------------ 4) HTTP API
console.log("\n4) HTTP API: register a site (validated), start a job, answer the approval card, read the stream");
{
  wp.title = "Old Title"; wp.posts.length = 0;
  const runner = runnerFor(scripted([
    () => call("get_page_map", {}),
    () => call("set_content", { target: "acf:field_hero_title:5", value: "Via HTTP", reason: "http test" }),
    () => say("Done."),
  ]));
  const app = createApp(runner, sites, files);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

  const bad = await post("/sites", { url: "http://127.0.0.1:1", username: "a", appPassword: "b" });
  assert.equal(bad.status, 400); ok("site with unreachable URL is rejected with a clear error");
  const reg = await post("/sites", { name: "Fake", url: wpUrl, username: "admin", appPassword: "abcd efgh" });
  assert.equal(reg.status, 200); assert.equal(reg.body.reconnected, true); assert.equal(reg.body.id, site.id); assert.ok(!JSON.stringify(reg.body).includes("abcd"));
  ok("adding the same site again reconnects it (no duplicate); password never echoed back");
  assert.equal(sites.list().filter((x: any) => x.url === wpUrl).length, 1); ok("still exactly one connection for this site");

  const created = await post("/jobs", { siteId: reg.body.id, prompt: "change it to Via HTTP" });
  assert.equal(created.status, 201);
  const settled = await runner.waitUntilSettled(created.body.id);
  assert.equal(settled.status, "waiting_approval");
  const ans = await post(`/jobs/${created.body.id}/approvals`, { approvalId: settled.pending[0].approvalId, approved: true });
  assert.equal(ans.status, 200);
  const fin = await runner.waitUntilSettled(created.body.id);
  assert.equal(fin.status, "completed"); assert.equal(wp.posts[0].value, "Via HTTP"); ok("approval answered over HTTP; change applied once");

  const sse = await fetch(`${base}/jobs/${created.body.id}/events?after=0`);
  const reader = sse.body!.getReader(); let text = ""; const t0 = Date.now();
  while (Date.now() - t0 < 1500) { const { value, done } = await Promise.race([reader.read(), new Promise<any>((r) => setTimeout(() => r({ done: true }), 800))]); if (done) break; text += new TextDecoder().decode(value); if (text.includes("event: done")) break; }
  await reader.cancel().catch(() => {});
  assert.match(text, /event: tool_start/); assert.match(text, /event: approval_request/); assert.match(text, /event: done/);
  ok("a late subscriber replays the whole history (reconnect-safe progress stream)");
  app.close();
}

// ------------------------------------------------------------------ 5) chat features
console.log("\n5) chat features: follow-up keeps context, image upload + preview, UI is served");
{
  const seen: string[] = [];
  const model = mockModel(({ prompt }: any) => {
    seen.push(JSON.stringify(prompt));
    return say("Reply to message #" + prompt.filter((m: any) => m.role === "user").length);
  });
  const runner = runnerFor(model);
  const app = createApp(runner, sites, files);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const up = await fetch(base + "/files", { method: "POST", headers: { "Content-Type": "image/png", "x-filename": "pixel.png" }, body: png }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  assert.equal(up.status, 201); ok("image uploaded to the backend");
  const shown = await fetch(base + "/files/" + up.body.id);
  assert.equal(shown.status, 200); assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await shown.arrayBuffer()).length, png.length); ok("the same image can be shown back in the chat");
  const notImage = await fetch(base + "/files", { method: "POST", headers: { "Content-Type": "text/html", "x-filename": "x.html" }, body: "<script>1</script>" });
  assert.equal(notImage.status, 400); ok("non-image files are refused");

  const first = await post("/jobs", { siteId: site.id, prompt: "first question", fileIds: [up.body.id] });
  await runner.waitUntilSettled(first.body.id);
  assert.match(seen[0], /pixel\.png/); ok("the model is told which image was attached (id + file name)");

  const second = await post("/jobs/" + first.body.id + "/messages", { prompt: "second question" });
  assert.equal(second.status, 200);
  const done = await runner.waitUntilSettled(first.body.id);
  assert.match(done.result ?? "", /#2/); assert.match(seen[1], /first question/);
  ok("a follow-up continues the SAME conversation (earlier messages are sent to the model again)");
  assert.equal(done.events.filter((e: any) => e.type === "user").length, 2);
  ok("both user messages are in the event history, so the UI can redraw the chat after a reload");

  const page = await fetch(base + "/");
  assert.equal(page.status, 200); assert.match(await page.text(), /<title>Livecrafts<\/title>/); ok("the chat UI is served at /");
  const deep = await fetch(base + "/some/deep/link"); assert.equal(deep.status, 200); ok("deep links fall back to the UI");
  const trav = await fetch(base + "/..%2f..%2fpackage.json");
  assert.ok(!(await trav.text()).includes("livecrafts-backend")); ok("path traversal cannot read files outside the UI folder");
  app.close();
}

// ------------------------------------------------------------------ 6) streaming
console.log("\n6) streaming: text arrives live in pieces, is saved once, and an approved write never repeats");
{
  wp.title = "Old Title"; wp.posts.length = 0;
  const runner = runnerFor(scripted([
    () => call("set_content", { target: "acf:field_hero_title:5", value: "Streamed", reason: "stream test" }),
    () => say("Done - the hero title now reads Streamed and the live page shows it."),
    () => say("Sure, anything else?"),
  ]));
  const job = runner.create(site.id, "change the hero title to Streamed");
  const deltas: string[] = [];
  runner.subscribe(job.id, (e) => { if (e.type === "text_delta") deltas.push(String(e.data.text)); });
  const paused = await runner.waitUntilSettled(job.id);
  runner.respond(job.id, paused.pending[0].approvalId, true);
  const done = await runner.waitUntilSettled(job.id);
  assert.equal(done.status, "completed");
  assert.ok(deltas.length > 1); assert.equal(deltas.join(""), "Done - the hero title now reads Streamed and the live page shows it.");
  ok(`answer streamed live in ${deltas.length} pieces and they add up to the exact final text`);
  assert.equal(done.events.filter((e: any) => e.type === "text_delta").length, 0);
  assert.equal(done.events.filter((e: any) => e.type === "text").length, 1);
  ok("live pieces are not written to disk; the finished text is saved exactly once");

  runner.continue(job.id, "thanks");
  const after = await runner.waitUntilSettled(job.id);
  assert.equal(after.status, "completed"); assert.equal(wp.posts.length, 1);
  ok("a follow-up message after an approved change does NOT run the write again");
  const toolResults = after.messages.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((c: any) => c.type === "tool-result");
  assert.equal(toolResults.length, 1); ok("the approved tool's result is saved in the conversation history");
}

// ------------------------------------------------------------------ 7) theme file editing (fake hosting file system)
console.log("\n7) file editing: only theme files, one exact match, backup, verified live, automatic rollback");
{
  const { SiteFiles } = await import("../src/sitefiles.js");
  const siteUrl = "https://shop.test/sub";
  const fsMap = new Map<string, string>([["wp-content/themes/demo/style.css", ".hero__title { color: #111; font-size: 40px; }\n.btn { color: #fff; }\n.btn { padding: 4px; }\n"]]);
  let uploads = 0; let pageBroken = false;
  const remote = {
    list: async () => [...fsMap.keys()].map((p) => ({ name: p.split("/").pop()!, path: p, type: "file", bytes: fsMap.get(p)!.length })),
    readViaApi: async (p: string) => fsMap.get(p) ?? "",
    upload: async (p: string, c: string) => { uploads++; fsMap.set(p, c); },
  };
  const fakeFetch = (async (input: any) => {
    const u = new URL(String(input));
    const rel = u.pathname.replace(/^\/sub\/?/, "");
    if (!rel) return new Response(pageBroken ? "There has been a critical error on this website." : "<html>ok</html>", { status: pageBroken ? 500 : 200, headers: { "content-type": "text/html" } });
    const c = fsMap.get(rel);
    return c === undefined ? new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }) : new Response(c, { status: 200, headers: { "content-type": "text/css" } });
  }) as typeof fetch;
  const sf = new SiteFiles({ siteId: "site_test", siteUrl, remote, fetchImpl: fakeFetch });
  const home = siteUrl + "/";

  const r1: any = await sf.edit("wp-content/themes/demo/style.css", "color: #111;", "color: #1d4ed8;", home);
  assert.equal(r1.ok, true); assert.equal(r1.verifiedLive, true); assert.match(fsMap.get("wp-content/themes/demo/style.css")!, /color: #1d4ed8;/);
  ok("edit replaced exactly the one snippet and the public file shows it");
  assert.ok(sf.getBackup(r1.backupId)?.before.includes("color: #111;")); ok("a backup of the original file was kept");

  for (const bad of ["wp-config.php", "wp-content/plugins/x/a.css", "../etc/passwd", "wp-content/themes/demo/functions.php"]) {
    await assert.rejects(() => sf.edit(bad, "a", "b", home));
  }
  ok("refused: wp-config.php, plugin files, '..' paths and PHP files");
  const before = uploads;
  await assert.rejects(() => sf.edit("wp-content/themes/demo/style.css", "not there", "x", home), /not found/);
  await assert.rejects(() => sf.edit("wp-content/themes/demo/style.css", ".btn {", ".btn  {", home), /appears 2 times/);
  assert.equal(uploads, before); ok("no match / ambiguous match = refused, nothing uploaded");

  pageBroken = true;
  const r2: any = await sf.edit("wp-content/themes/demo/style.css", "font-size: 40px;", "font-size: 44px;", home);
  pageBroken = false;
  assert.equal(r2.ok, false); assert.equal(r2.rolledBack, true); assert.match(fsMap.get("wp-content/themes/demo/style.css")!, /font-size: 40px;/);
  ok("page broke after an edit -> original file restored automatically, reported as failed");

  const r3: any = await sf.restore(r1.backupId, home);
  assert.equal(r3.ok, true); assert.match(fsMap.get("wp-content/themes/demo/style.css")!, /color: #111;/); ok("restore_file puts the original back");

  // the whole thing through the agent: edit_file must wait for approval
  const runner = new JobRunner(jobs, sites, buildAgent(files, {
    model: scripted([
      () => call("edit_file", { path: "wp-content/themes/demo/style.css", find: "color: #111;", replace: "color: #b91c1c;", reason: "Make the hero title red" }),
      () => say("Done - the hero title is now red."),
    ]),
    remoteFiles: () => remote, fetchImpl: fakeFetch, browser: null, hostinger: null,
  }));
  const fsite = sites.put({ ...site, id: "site_files", url: siteUrl });
  const job = runner.create(fsite.id, "make the hero title red");
  const paused = await runner.waitUntilSettled(job.id);
  assert.equal(paused.status, "waiting_approval"); assert.match(fsMap.get("wp-content/themes/demo/style.css")!, /color: #111;/);
  ok("edit_file waits for approval; nothing changed before that");
  runner.respond(job.id, paused.pending[0].approvalId, true);
  const done = await runner.waitUntilSettled(job.id);
  const end = done.events.find((e: any) => e.type === "tool_end" && e.data.tool === "edit_file");
  assert.equal(done.status, "completed"); assert.match(fsMap.get("wp-content/themes/demo/style.css")!, /color: #b91c1c;/); assert.ok((end?.data.ui as any)?.backupId);
  ok("after approval the file changed, and the chat got the file path + backup id");
}

// ------------------------------------------------------------------ 8) Hostinger API guard
console.log("\n8) Hostinger API from the chat is READ-ONLY");
{
  const { makeTools } = await import("../src/tools.js");
  const { Bridge } = await import("../src/bridge.js");
  const executed: string[] = [];
  const fakeHg: any = { isReadOnly: async (op: string) => op.endsWith("list") || op.endsWith("list-installed"), execute: async (op: string) => { executed.push(op); return { data: [] }; }, search: async () => "[]" };
  const tools: any = makeTools(new Bridge(site), files, { hostinger: fakeHg });
  const ctx = { toolCallId: "t", messages: [] };
  const denied = await tools.hostinger_read.execute({ operation: "hosting_websites_delete", params: {} }, ctx);
  const allowed = await tools.hostinger_read.execute({ operation: "wordpress_plugins_list-installed", params: {} }, ctx);
  assert.equal(denied.ok, false); assert.equal(allowed.ok, true); assert.deepEqual(executed, ["wordpress_plugins_list-installed"]);
  ok("a destructive operation is refused; a read-only one runs");
  assert.equal(tools.edit_file, undefined); ok("file tools are not offered when the site is not linked to hosting");
}

// ------------------------------------------------------------------ 9) real browser (headless Edge/Chrome)
console.log("\n9) browser: inspect finds the CSS rule + file behind an element; screenshot works");
{
  const { inspectElement, screenshotPage, screenshotPath, closeBrowser } = await import("../src/browser.js");
  const page = http.createServer((req, res) => {
    if (req.url?.startsWith("/wp-content/themes/demo/style.css")) { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(".hero__title { color: rgb(29, 78, 216); font-size: 42px; }"); }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><head><link rel="stylesheet" href="/wp-content/themes/demo/style.css"></head><body><h1 class="hero__title">Hello Hero</h1></body></html>`);
  });
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(page.address() as any).port}`;
  try {
    const r: any = await inspectElement(base, { text: "Hello Hero" });
    assert.equal(r.ok, true); assert.equal(r.elements[0].computed.color, "rgb(29, 78, 216)");
    const rule = r.elements[0].rules.find((x: any) => x.declarations?.color);
    assert.equal(rule.file, "wp-content/themes/demo/style.css"); assert.equal(rule.selector, ".hero__title");
    ok("inspect: computed colour is right AND it names the rule (.hero__title) and the file to edit");
    const s: any = await screenshotPage(base, { text: "Hello Hero", device: "mobile" });
    assert.ok(s.ok && screenshotPath(s.screenshotId)); ok("screenshot saved (element, mobile size) and can be shown in the chat");
    await assert.rejects(() => inspectElement(base, { url: "https://example.com/", text: "x" }), /Only pages on/); ok("pages on other websites are refused");
  } catch (e) {
    if (/No browser available/.test(String((e as Error).message))) console.log("  - skipped: no Edge/Chrome on this machine");
    else throw e;
  } finally { await closeBrowser(); page.close(); }
}

console.log(`\nALL GOOD: ${passed} checks passed.\n`);
fakeWp.close();
process.exit(0);
