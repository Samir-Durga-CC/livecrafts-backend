/**
 * Tests for: vision (the model really receives images), safe image download into the Media Library, the WordPress
 * skills loader, AI providers, Stop / pause / continue, and "eyes" (tools looking through the person's browser).
 * No LLM key and no real site: the fake Livecrafts 0.10 site (test/fakeSite.ts) and a scripted model.
 * Run:  npm test
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-feat-"));
process.env.LC_VERIFY_CHANGES = "0";
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");
const { hydrateMessages, imageMarker } = await import("../src/vision.js");
const { downloadImage, isPrivateIp } = await import("../src/net.js");
const { Skills } = await import("../src/skills.js");
const { call, say, scripted, mockModel } = await import("./mockModel.js");
const { startFakeSite, PNG } = await import("./fakeSite.js");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };

const fake = await startFakeSite();
const wp = fake.s;
const wpUrl = fake.url;
const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const files = new FileStore();
const site = sites.put({ id: "site_feat", name: "Aero", url: wpUrl, username: "admin", appPassword: "x y z", createdAt: new Date().toISOString() });
const runnerFor = (model: any) => new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null, allowPrivateImageHosts: true }));
const heroWrites = () => wp.changes.filter((c) => c.target === "field_hero_title").length;

/** Drive a job: approve every card, return the settled job. */
async function runAll(runner: any, jobId: string, approve = true) {
  for (;;) {
    const j = await runner.waitUntilSettled(jobId);
    if (j.status !== "waiting_approval") return j;
    for (const p of j.pending) runner.respond(jobId, p.approvalId, approve);
    if (!approve) return runner.waitUntilSettled(jobId);
  }
}

// ------------------------------------------------------------------ 5) vision: the model really receives the pictures
console.log("\n5) vision: attached images and screenshots reach the model as real images");
{
  const att = files.save(PNG, "reference.png", "image/png");
  let seen: any[] = [];
  const model = mockModel(async ({ prompt }: any) => { seen = prompt; return say("I can see your reference image."); });
  const runner = runnerFor(model);
  const job = runner.create(site.id, "make the footer like this image", undefined, [att.id]);
  await runner.waitUntilSettled(job.id);
  const user = seen.find((m: any) => m.role === "user");
  const img = user.content.find((p: any) => p.type === "file");
  assert.ok(img && /^image\/png/.test(img.mediaType)); ok("the attached image is sent to the model as an image part");
  const saved = runner.get(job.id)!.messages[0] as any;
  assert.ok(JSON.stringify(saved).length < 2000 && JSON.stringify(saved).includes(imageMarker(att.id))); ok("the saved conversation keeps only a tiny marker (no image bytes on disk twice)");

  // a tool result with imageForModel is shown right after that tool result, only the newest few, and never duplicated
  const msgs: any[] = [{ role: "user", content: "hi" }];
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c" + i, toolName: "view_image", input: {} }] });
    msgs.push({ role: "tool", content: [{ type: "tool-result", toolCallId: "c" + i, toolName: "view_image", output: { type: "json", value: { ok: true, imageForModel: att.id, imageCaption: "shot " + i } } }] });
  }
  const once = hydrateMessages(msgs, files), twice = hydrateMessages(once, files);
  const injected = (arr: any[]) => arr.filter((m) => m.role === "user" && Array.isArray(m.content) && String(m.content[0].text).startsWith("[[lc-visual]]"));
  assert.equal(injected(once).length, 3); assert.equal(injected(twice).length, 3); ok("only the 3 newest tool images are sent, and re-hydrating never duplicates them");
}

// ------------------------------------------------------------------ 6) image download: real images only, never private networks
console.log("\n6) images from the web: safe download into the Media Library");
{
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp("8.8.8.8"), false); ok("private / loopback / cloud-metadata addresses are recognised");
  await assert.rejects(() => downloadImage(`${wpUrl}/img/logo.png`), /private\/internal/); ok("a download from this machine's network is refused");
  await assert.rejects(() => downloadImage("file:///etc/passwd"), /http/); ok("non-http addresses are refused");
  const img = await downloadImage(`${wpUrl}/img/logo.png`, { skipHostCheck: true });
  assert.equal(img.mime, "image/png"); ok("a real PNG is recognised by its bytes");
  await assert.rejects(() => downloadImage(`${wpUrl}/img/not-an-image`, { skipHostCheck: true }), /did not return an image/); ok("HTML pretending to be an image is refused");

  const runner = runnerFor(scripted([() => call("upload_media_from_url", { url: `${wpUrl}/img/logo.png`, alt: "Aero logo", title: "Logo", reason: "Import the logo" }), () => say("Uploaded.")]));
  const job = runner.create(site.id, "upload this logo");
  const done = await runAll(runner, job.id);
  assert.equal(done.status, "completed"); assert.equal(wp.media.length, 1);
  ok("upload_media_from_url (approved) puts it in the Media Library");
}

// ------------------------------------------------------------------ 7) skills
console.log("\n7) official WordPress skills are available to the assistant");
{
  const sk = new Skills();
  const names = sk.list().map((s) => s.name);
  for (const n of ["wp-block-themes", "wp-block-development", "wp-rest-api", "wp-performance", "wp-interactivity-api"]) assert.ok(names.includes(n), n);
  ok("5 skills found: " + names.join(", "));
  const s = sk.load("wp-block-themes"); assert.match(s.content, /theme\.json/); ok("SKILL.md loads");
  assert.match(sk.load("wp-block-themes", "references/patterns.md").content, /pattern/i); ok("reference files load");
  assert.throws(() => sk.load("wp-block-themes", "../../../.env"), /not part of/); ok("only the skill's own files can be loaded");
  assert.match(sk.catalogue(), /wp-rest-api/); ok("the catalogue goes into the assistant's instructions");
}

// ------------------------------------------------------------------ 9) AI providers
console.log("\n9) models: provider:model names, clear errors when a key is missing");
{
  const { parseModelSpec, resolveModel, testModel } = await import("../src/models.js");
  assert.deepEqual(parseModelSpec("gpt-5.5"), { provider: "openai", model: "gpt-5.5" });
  assert.deepEqual(parseModelSpec("anthropic:claude-sonnet-5-5"), { provider: "anthropic", model: "claude-sonnet-5-5" });
  assert.deepEqual(parseModelSpec("openrouter:google/gemini-3-pro"), { provider: "openrouter", model: "google/gemini-3-pro" });
  assert.deepEqual(parseModelSpec("groq:openai/gpt-oss-120b"), { provider: "groq", model: "openai/gpt-oss-120b" });
  assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-5-5"), { provider: "gateway", model: "anthropic/claude-sonnet-5-5" });
  ok("model names: openai (plain), anthropic:, openrouter:, groq:, and vendor/model = AI Gateway");
  const saved = process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY;
  assert.throws(() => resolveModel("groq:llama-3.3-70b-versatile"), /No API key for Groq/); ok("a missing key gives a clear message (not a crash)");
  assert.throws(() => resolveModel("custom:my-model"), /no address/); ok("the custom provider asks for its address first");
  const t = await testModel("groq:x"); assert.equal(t.ok, false); ok("'Save & test' reports failures as a result");
  if (saved) process.env.GROQ_API_KEY = saved;
}

// ------------------------------------------------------------------ 12) Stop / pause / continue
console.log("\n12) Stop button: pauses safely, keeps finished work, never repeats a change; continue with a note or a correction");
{
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const until = async (runner: any, id: string, pred: (j: any) => boolean) => { for (let i = 0; i < 200; i++) { const j = runner.get(id); if (pred(j)) return j; await new Promise((r) => setTimeout(r, 20)); } throw new Error("timeout"); };

  // a) stop while the model is writing
  let turn = 0;
  const r1 = runnerFor(mockModel(async () => (turn++ === 0 ? say(long) : say("Continuing with the note.")), { delayMs: 15 }));
  const j1 = r1.create(site.id, "write a long answer", undefined, [], { approvalMode: "auto" });
  await until(r1, j1.id, (j) => j.status === "running");
  await new Promise((r) => setTimeout(r, 150));
  r1.stop(j1.id);
  const p1 = await r1.waitUntilSettled(j1.id);
  assert.equal(p1.status, "paused"); ok("Stop while writing → paused at once");
  r1.continue(j1.id, "make it shorter", undefined, [], { kind: "note" });
  const c1 = await r1.waitUntilSettled(j1.id);
  assert.equal(c1.status, "completed"); assert.equal(c1.requestSeq, 1); assert.match(String(c1.messages.at(-2)?.content ?? JSON.stringify(c1.messages)), /paused you/i);
  ok("a note while paused continues the SAME request (no new request in Changes)");

  // b) stop right after an approved change: it ran once and never runs again
  const base2 = heroWrites(); let t2 = 0;
  const r2 = runnerFor(mockModel(async () => { t2++; return t2 === 1 ? call("make_change", { kind: "acf.field", target: "field_hero_title", value: "Approved", reason: "x" }) : t2 === 2 ? say(long) : say("ok, done"); }, { delayMs: 15 }));
  const j2 = r2.create(site.id, "change the title", undefined, [], { approvalMode: "every" });
  const w2 = await r2.waitUntilSettled(j2.id);
  r2.respond(j2.id, w2.pending[0].approvalId, true);
  await until(r2, j2.id, (j) => j.status === "running");
  await until(r2, j2.id, () => heroWrites() === base2 + 1);
  await new Promise((r) => setTimeout(r, 120));
  r2.stop(j2.id);
  const p2 = await r2.waitUntilSettled(j2.id);
  assert.equal(p2.status, "paused"); assert.equal(wp.changes.at(-1)!.payload.after, "Approved"); assert.equal(heroWrites(), base2 + 1);
  assert.ok(p2.messages.some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes("tool-result")));
  ok("approved change ran once and its result is saved even though Stop came mid-answer");
  r2.resume(j2.id);
  const c2 = await r2.waitUntilSettled(j2.id);
  assert.equal(c2.status, "completed"); assert.equal(heroWrites(), base2 + 1); ok("Continue → finishes without running the change again");

  // c) stop while waiting for approval, then correct the request: the pending change is declined, nothing written
  const base3 = heroWrites(); let t3 = 0;
  const r3 = runnerFor(mockModel(async () => { t3++; return t3 === 1 ? call("make_change", { kind: "acf.field", target: "field_hero_title", value: "Wrong", reason: "x" }) : say("Understood, using the corrected request."); }));
  const j3 = r3.create(site.id, "title Wrong", undefined, [], { approvalMode: "every" });
  await r3.waitUntilSettled(j3.id);
  r3.stop(j3.id);
  assert.equal(r3.get(j3.id)!.status, "paused"); ok("Stop while an approval card waits → paused");
  r3.continue(j3.id, "actually keep the title, change nothing", undefined, [], { kind: "edit" });
  const c3 = await r3.waitUntilSettled(j3.id);
  assert.equal(c3.status, "completed"); assert.equal(heroWrites(), base3); assert.ok(c3.events.some((e: any) => e.type === "approval_response" && e.data.approved === false));
  ok("editing the request declines the waiting change - nothing was written");
}

// ------------------------------------------------------------------ 13) eyes: the person's browser looks for the assistant
console.log("\n13) eyes: tools look through the person's browser when the widget is open; honest about bot-check pages");
{
  const { eyes } = await import("../src/eyes.js");
  const { readPage, closeBrowser } = await import("../src/browser.js");
  const app = createApp(runnerFor(scripted([() => say("ok")])), sites, files);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(app.address() as any).port}`;

  // a pretend widget: opens the live line and answers requests like widget.js would
  const seenRequests: any[] = [];
  const ctrl = new AbortController();
  const widget = (async () => {
    const res = await fetch(`${api}/sites/${site.id}/eyes?pageUrl=${encodeURIComponent(wpUrl + "/")}&viewport=1366`, { signal: ctrl.signal });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!/^event: request/m.test(block)) continue;
          const req = JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
          seenRequests.push(req);
          const shot = req.action === "screenshot" ? files.save(PNG, "page.jpg", "image/png").id : undefined;
          const result = req.action === "read" ? { ok: true, url: wpUrl + "/", title: "Aero", headings: [{ tag: "h1", text: "Hello from the real browser" }], text: "Footer: © Aero 2026 · Instagram · LinkedIn" }
            : { ok: true, screenshotId: shot, device: "desktop", target: "page", url: wpUrl + "/" };
          await fetch(`${api}/sites/${site.id}/eyes/${req.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, result }) });
        }
      }
    } catch { /* closed */ }
  })();
  for (let i = 0; i < 50 && !eyes.available(site.id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(eyes.available(site.id)); ok("the widget's live line is registered for this site");

  let modelSaw: any[] = [];
  const runner = new JobRunner(jobs, sites, buildAgent(files, {
    hostinger: null, allowPrivateImageHosts: true,
    model: mockModel(async ({ prompt }: any) => { modelSaw = prompt; const n = prompt.filter((m: any) => m.role === "tool").length; return n === 0 ? call("read_page", {}) : n === 1 ? call("screenshot_page", { text: "footer" }) : say("The footer shows Instagram and LinkedIn."); }),
  }));
  const job = runner.create(site.id, "check the footer", undefined, [], { approvalMode: "auto" });
  const done = await runner.waitUntilSettled(job.id);
  assert.equal(done.status, "completed"); assert.deepEqual(seenRequests.map((r) => r.action), ["read", "screenshot"]);
  const readResult = JSON.stringify(done.messages.find((m: any) => m.role === "tool"));
  assert.match(readResult, /Hello from the real browser/); assert.match(readResult, /person's browser/);
  ok("read_page went to the person's browser (not the server's), and says so");
  assert.ok(modelSaw.some((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "file" && /^image\//.test(p.mediaType))));
  ok("the screenshot taken in the person's browser reached the AI as an image (no public URL needed)");

  ctrl.abort(); await widget;
  for (let i = 0; i < 50 && eyes.available(site.id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(eyes.available(site.id), false); ok("closing the widget removes it - tools fall back to the server browser");
  app.close();

  // the server browser recognises a "checking your browser" page instead of reading it as the site
  const guard = http.createServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>"); });
  await new Promise<void>((r) => guard.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(() => readPage(`http://127.0.0.1:${(guard.address() as any).port}`, {}), /BOT_CHECK/);
    ok("bot-check page detected → clear BOT_CHECK message, never a made-up answer");
  } catch (e) {
    if (/No browser available/.test(String((e as Error).message))) console.log("  - skipped: no Edge/Chrome on this machine"); else throw e;
  } finally { guard.close(); await closeBrowser(); }
}

console.log(`\nALL GOOD: ${passed} checks passed.\n`);
fake.close();
process.exit(0);
