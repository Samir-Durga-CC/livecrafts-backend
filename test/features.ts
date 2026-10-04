/**
 * Tests for: pages/posts/menus, theme templates (PHP) via the plugin, the change ledger + Revert, vision (the model
 * really receives images), safe image download, and the WordPress skills loader.
 * No LLM key and no real site: a fake WordPress (core REST + Livecrafts plugin 0.7) and a scripted model.
 * Run:  npm test
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-feat-"));
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");
const { hydrateMessages, imageMarker } = await import("../src/vision.js");
const { downloadImage, isPrivateIp } = await import("../src/net.js");
const { Skills } = await import("../src/skills.js");
const { call, say, scripted, mockModel } = await import("./mockModel.js");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };
const sha1 = (s: string) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d10000000049454e44ae426082", "hex");

// ------------------------------------------------------------------ fake WordPress (core REST + Livecrafts 0.7)
const THEME = "wp-content/themes/aero";
const wp = {
  hero: "Old Title",
  pages: new Map<number, any>(), nextId: 100,
  menus: new Map<number, any>(), items: new Map<number, any>(), locations: { primary: { name: "primary", description: "Primary menu", menu: 0 } } as any,
  files: new Map<string, string>([
    [`${THEME}/footer.php`, `<?php if (!defined('ABSPATH')) exit; ?>\n<footer class="site-footer"><span>&copy; Aero</span></footer>\n<?php wp_footer(); ?>\n</body>\n</html>\n`],
    [`${THEME}/style.css`, `.site-footer { background: #111; }\n`],
  ]),
  media: [] as any[],
};
const render = () => {
  const footer = wp.files.get(`${THEME}/footer.php`)!;
  if (footer.includes("fatal_here()")) return { status: 500, html: "<p>There has been a critical error on this website.</p>" };
  const html = footer.replace(/<\?php[\s\S]*?\?>/g, "");
  return { status: 200, html: `<!doctype html><html><head><link rel="stylesheet" href="/${THEME}/style.css"></head><body><h1>${wp.hero}</h1>${html.includes("</body>") ? html : html}` };
};
const fakeWp = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  const raw = await new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  const body = raw && /json/.test(String(req.headers["content-type"])) ? JSON.parse(raw) : {};
  const json = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  const lc = p.replace("/wp-json/livecrafts/v1/", "");
  if (lc === "ping") return json(200, { ok: true, version: "0.7.0", capabilities: { acf: true, theme_files: true } });
  if (lc === "debug/target") return json(200, { stored_raw: wp.hero });
  if (lc === "target" && req.method === "POST") { wp.hero = body.value; return json(200, { ok: true, value: body.value }); }
  if (lc === "theme-files") return json(200, { ok: true, files: [...wp.files.keys()].map((f) => ({ path: f, bytes: wp.files.get(f)!.length })) });
  if (lc === "theme-file") {
    const f = u.searchParams.get("path") ?? body.path;
    if (!String(f).startsWith(THEME + "/")) return json(403, { code: "livecrafts_outside_theme", message: "Only files of the active theme." });
    if (req.method === "GET") return wp.files.has(f) ? json(200, { ok: true, path: f, content: wp.files.get(f), sha1: sha1(wp.files.get(f)!) }) : json(404, { code: "livecrafts_not_found", message: "File not found: " + f });
    if (req.method === "POST") {
      const exists = wp.files.has(f);
      if (exists && body.expectedSha1 && body.expectedSha1 !== "new" && sha1(wp.files.get(f)!) !== body.expectedSha1) return json(409, { code: "livecrafts_changed", message: "changed" });
      if (/\.php$/.test(f) && /syntax error/.test(body.content)) return json(400, { code: "livecrafts_php_syntax", message: "PHP syntax error on line 2 - nothing was written." });
      wp.files.set(f, body.content); return json(200, { ok: true, path: f, sha1: sha1(body.content) });
    }
    if (req.method === "DELETE") { if (sha1(wp.files.get(f) ?? "") !== u.searchParams.get("expectedSha1")) return json(409, { code: "livecrafts_changed", message: "changed" }); wp.files.delete(f); return json(200, { ok: true }); }
  }
  // core: pages / posts
  let m = p.match(/^\/wp-json\/wp\/v2\/(pages|posts)(?:\/(\d+))?$/);
  if (m) {
    const id = m[2] ? Number(m[2]) : 0;
    const view = (x: any) => ({ id: x.id, link: `${wpUrl}/${x.slug}/`, status: x.status, title: { raw: x.title, rendered: x.title }, content: { raw: x.content }, template: "" });
    if (!id && req.method === "POST") { const x = { id: wp.nextId++, title: body.title, content: body.content, status: body.status, slug: String(body.slug ?? body.title).toLowerCase().replace(/\W+/g, "-") }; wp.pages.set(x.id, x); return json(201, view(x)); }
    if (!id) return json(200, [...wp.pages.values()].filter((x) => x.status !== "trash").map(view));
    const x = wp.pages.get(id); if (!x) return json(404, { code: "rest_post_invalid_id", message: "Invalid post ID." });
    if (req.method === "GET") return json(200, view(x));
    if (req.method === "POST") { if (body.content !== undefined) x.content = body.content; if (body.status) x.status = body.status; return json(200, view(x)); }
    if (req.method === "DELETE") { x.status = "trash"; return json(200, view(x)); }
  }
  if (p === "/wp-json/wp/v2/menu-locations") return json(200, wp.locations);
  m = p.match(/^\/wp-json\/wp\/v2\/menus(?:\/(\d+))?$/);
  if (m) {
    if (!m[1] && req.method === "POST") { const x = { id: wp.nextId++, name: body.name, locations: body.locations }; wp.menus.set(x.id, x); for (const l of body.locations) wp.locations[l].menu = x.id; return json(201, x); }
    if (!m[1]) return json(200, [...wp.menus.values()]);
    if (req.method === "DELETE") { wp.menus.delete(Number(m[1])); for (const l of Object.values(wp.locations) as any[]) if (l.menu === Number(m[1])) l.menu = 0; for (const [k, v] of wp.items) if (v.menus === Number(m[1])) wp.items.delete(k); return json(200, { deleted: true }); }
  }
  m = p.match(/^\/wp-json\/wp\/v2\/menu-items(?:\/(\d+))?$/);
  if (m) {
    if (!m[1] && req.method === "POST") { const x = { id: wp.nextId++, ...body, title: { raw: body.title } }; wp.items.set(x.id, x); return json(201, x); }
    if (!m[1]) return json(200, [...wp.items.values()].filter((i) => i.menus === Number(u.searchParams.get("menus"))));
    if (req.method === "DELETE") { wp.items.delete(Number(m[1])); return json(200, { deleted: true }); }
  }
  if (p === "/wp-json/wp/v2/media" && req.method === "POST") { const id = wp.nextId++; wp.media.push(id); return json(201, { id, source_url: `${wpUrl}/wp-content/uploads/${id}.png`, mime_type: req.headers["content-type"] }); }
  m = p.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/); if (m) return json(200, { id: Number(m[1]) });
  if (p === `/${THEME}/style.css`) { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(wp.files.get(`${THEME}/style.css`)); }
  if (p === "/img/logo.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
  if (p === "/img/not-an-image") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("<html>nope</html>"); }
  if (p === "/" || p.endsWith("/")) { const r = render(); res.writeHead(r.status, { "Content-Type": "text/html" }); return res.end(r.html); }
  json(404, { code: "rest_no_route", message: "No route" });
});
await new Promise<void>((r) => fakeWp.listen(0, "127.0.0.1", r));
const wpUrl = `http://127.0.0.1:${(fakeWp.address() as any).port}`;

const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const files = new FileStore();
const site = sites.put({ id: "site_feat", name: "Aero", url: wpUrl, username: "admin", appPassword: "x y z", createdAt: new Date().toISOString() });
const runnerFor = (model: any) => new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null, allowPrivateImageHosts: true }));

/** Drive a job: approve every card, return the settled job. */
async function runAll(runner: any, jobId: string, approve = true) {
  for (;;) {
    const j = await runner.waitUntilSettled(jobId);
    if (j.status !== "waiting_approval") return j;
    for (const p of j.pending) runner.respond(jobId, p.approvalId, approve);
    if (!approve) return runner.waitUntilSettled(jobId);
  }
}

// ------------------------------------------------------------------ 1) new page + menu link, then Revert both
console.log("\n1) create a page and a menu link (with approval), then revert each with the Revert button");
{
  const runner = runnerFor(scripted([
    () => call("create_page", { title: "Blog", content: "<!-- wp:heading --><h2>Latest articles</h2><!-- /wp:heading -->\n<!-- wp:latest-posts /-->", status: "publish", reason: "Create the Blog page" }),
    () => call("get_menus", {}),
    () => call("create_menu", { name: "Main", location: "primary", items: [{ title: "About", url: "#why" }, { title: "Blog", pageId: 100 }], reason: "Add Blog to the navigation" }),
    () => say("Created the Blog page and added it to the menu."),
  ]));
  const job = runner.create(site.id, "add a blog page and put it in the navbar");
  const first = await runner.waitUntilSettled(job.id);
  assert.equal(first.status, "waiting_approval"); assert.equal(first.pending[0].toolName, "create_page"); assert.equal(wp.pages.size, 0);
  ok("create_page waits for approval; nothing created before");
  const done = await runAll(runner, job.id);
  assert.equal(done.status, "completed");
  assert.equal(wp.pages.get(100)?.status, "publish"); assert.equal(wp.locations.primary.menu, 101); assert.equal([...wp.items.values()].length, 2);
  ok("after approval: page published, menu created for the 'primary' location with 2 links");
  assert.equal(done.changes.length, 2); assert.deepEqual(done.changes.map((c: any) => c.tool), ["create_page", "create_menu"]);
  ok("both writes are in the change ledger");
  const ev = done.events.filter((e: any) => e.type === "change").length; assert.equal(ev, 2); ok("the chat got a 'change' event for each");

  const app = createApp(runner, sites, files);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(app.address() as any).port}`;
  const revert = (id: string) => fetch(`${api}/jobs/${job.id}/changes/${id}/revert`, { method: "POST" }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  const [pageChg, menuChg] = done.changes;
  const r1 = await revert(menuChg.id);
  assert.equal(r1.status, 200); assert.equal(wp.locations.primary.menu, 0); assert.equal(wp.menus.size, 0); ok("Revert menu → menu deleted, the theme's own links come back");
  const r2 = await revert(pageChg.id);
  assert.equal(r2.status, 200); assert.equal(wp.pages.get(100).status, "trash"); ok("Revert page → moved to the Trash (recoverable)");
  const again = await revert(pageChg.id); assert.equal(again.status, 409); assert.match(again.body.error, /already reverted/); ok("reverting twice is refused");
  const after = runner.get(job.id)!; assert.ok(after.changes!.every((c: any) => c.revertedAt)); ok("ledger shows both as reverted");
  app.close();
}

// ------------------------------------------------------------------ 2) footer.php: PHP edit + CSS, syntax check, auto-rollback, revert order
console.log("\n2) theme template (footer.php): PHP syntax check, rollback when the site breaks, revert order");
{
  const before = wp.files.get(`${THEME}/footer.php`)!;
  const runner = runnerFor(scripted([
    () => call("read_file", { path: `${THEME}/footer.php` }),
    () => call("edit_file", { path: `${THEME}/footer.php`, find: "<span>&copy; Aero</span>", replace: "<span>&copy; Aero</span><?php syntax error", reason: "Add social links" }),
    () => call("edit_file", { path: `${THEME}/footer.php`, find: "<span>&copy; Aero</span>", replace: "<span>&copy; Aero</span><?php fatal_here(); ?>", reason: "Add social links" }),
    () => call("edit_file", { path: `${THEME}/footer.php`, find: "<span>&copy; Aero</span>", replace: `<span>&copy; Aero</span><nav class="site-footer__social" aria-label="Social"><a href="https://x.com/aero" target="_blank" rel="noopener noreferrer">X</a></nav>`, reason: "Add social links" }),
    () => call("edit_file", { path: `${THEME}/style.css`, find: ".site-footer { background: #111; }", replace: ".site-footer { background: #0b0b0f; }\n.site-footer__social { display: flex; gap: 12px; }", reason: "Style the social links" }),
    () => call("edit_file", { path: "wp-config.php", find: "a", replace: "b", reason: "x" }),
    () => call("edit_file", { path: `${THEME}/functions.php`, find: "a", replace: "b", reason: "x" }),
    () => say("Footer updated with social links."),
  ]));
  const job = runner.create(site.id, "add social links to the footer");
  const done = await runAll(runner, job.id);
  const ends = done.events.filter((e: any) => e.type === "tool_end" && e.data.tool === "edit_file");
  assert.equal(ends[0].data.ok, false); assert.match(ends[0].data.error, /syntax error/); ok("PHP with a syntax error is refused by the plugin - nothing written");
  assert.equal(ends[1].data.ok, false); assert.match(ends[1].data.error, /restored automatically/); ok("PHP that breaks the page → original restored automatically");
  assert.equal(ends[2].data.ok, true); assert.match(wp.files.get(`${THEME}/footer.php`)!, /site-footer__social/); ok("valid footer.php edit applied and verified");
  assert.equal(ends[3].data.ok, true); assert.match(wp.files.get(`${THEME}/style.css`)!, /site-footer__social/); ok("CSS for it added in the theme stylesheet");
  assert.equal(ends[4].data.ok, false); assert.equal(ends[5].data.ok, false); assert.match(ends[5].data.error, /functions\.php/); ok("wp-config.php and functions.php are refused");
  assert.equal(done.changes.length, 2); ok("only the 2 successful edits are in the ledger (failed ones are not)");

  // revert footer.php from the chat (approval) - then the stylesheet with the button
  const footerChg = done.changes[0];
  const r2 = runnerFor(scripted([
    () => call("list_changes", {}),
    () => call("revert_change", { changeId: footerChg.id, reason: "Put the old footer back" }),
    () => say("Reverted the footer."),
  ]));
  r2.continue(job.id, "revert the footer");
  const paused = await r2.waitUntilSettled(job.id);
  assert.equal(paused.pending[0].toolName, "revert_change"); assert.equal((paused.pending[0] as any).current.title, "Add social links"); ok("revert from the chat asks for approval and names the change");
  const fin = await runAll(r2, job.id);
  assert.equal(wp.files.get(`${THEME}/footer.php`), before); ok("footer.php is byte-for-byte the original again");
  assert.ok(fin.changes.find((c: any) => c.id === footerChg.id).revertedAt); ok("ledger marks it reverted");
  await assert.rejects(() => r2.revertChange(job.id, footerChg.id), /already reverted/); ok("cannot revert the same change twice");
}

// ------------------------------------------------------------------ 3) block content: edit_post_content + revert guard
console.log("\n3) page sections in block content: exact edit, read back, revert blocked when a newer change exists");
{
  wp.pages.set(200, { id: 200, title: "Services", content: "<!-- wp:paragraph --><p>Intro</p><!-- /wp:paragraph -->", status: "publish", slug: "services" });
  const runner = runnerFor(scripted([
    () => call("read_post", { type: "pages", id: 200 }),
    () => call("edit_post_content", { type: "pages", id: 200, find: "<!-- wp:paragraph --><p>Intro</p><!-- /wp:paragraph -->", replace: "<!-- wp:paragraph --><p>Intro</p><!-- /wp:paragraph -->\n<!-- wp:heading --><h2>FAQ</h2><!-- /wp:heading -->", reason: "Add an FAQ section" }),
    () => call("edit_post_content", { type: "pages", id: 200, find: "<h2>FAQ</h2>", replace: "<h2>Questions</h2>", reason: "Rename FAQ" }),
    () => say("Added the section."),
  ]));
  const job = runner.create(site.id, "add an FAQ section to services");
  const done = await runAll(runner, job.id);
  assert.match(wp.pages.get(200).content, /Questions/); ok("section added and renamed (each edit read back)");
  await assert.rejects(() => runner.revertChange(job.id, done.changes[0].id), /newer change/); ok("reverting the older edit first is refused (would overwrite the newer one)");
  await runner.revertChange(job.id, done.changes[1].id); await runner.revertChange(job.id, done.changes[0].id);
  assert.equal(wp.pages.get(200).content, "<!-- wp:paragraph --><p>Intro</p><!-- /wp:paragraph -->"); ok("newest-first revert restores the original content exactly");
}

// ------------------------------------------------------------------ 4) set_content remembers the old value -> revert any time
console.log("\n4) content field: revert puts the exact old value back");
{
  wp.hero = "Old Title";
  const runner = runnerFor(scripted([() => call("set_content", { target: "acf:field_hero_title:5", value: "Welcome", reason: "New hero title" }), () => say("Done.")]));
  const job = runner.create(site.id, "hero title Welcome");
  const done = await runAll(runner, job.id);
  assert.equal(wp.hero, "Welcome"); assert.equal(done.changes[0].revert.previous, "Old Title"); ok("old value captured in the ledger");
  await runner.revertChange(job.id, done.changes[0].id); assert.equal(wp.hero, "Old Title"); ok("Revert → hero title is 'Old Title' again");
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
  assert.equal(wp.media.length, 1); assert.equal(done.changes[0].tool, "upload_media_from_url"); assert.equal(done.changes[0].revert, null);
  ok("upload_media_from_url (approved) puts it in the Media Library; listed as a change that stays");
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

console.log(`\nALL GOOD: ${passed} checks passed.\n`);
fakeWp.close();
process.exit(0);
