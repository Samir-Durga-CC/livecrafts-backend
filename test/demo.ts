/**
 * DEMO MODE - try the chat UI with NO OpenAI key and NO real WordPress site:
 *   npm run demo   ->  http://127.0.0.1:8791
 * A fake WordPress (imitating the Livecrafts plugin) + a small rule-based stand-in for the model that STREAMS its answers.
 * The real backend, job runner, approvals, uploads, streaming and UI all run for real; only the "AI" and the "site" are fake.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-demo-"));
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");
const { mockModel, call, say } = await import("./mockModel.js");

// ------------------------------------------------------------------ fake hosting file system (stands in for Hostinger)
const CSS_PATH = "wp-content/themes/aeromatic/style.css";
const hostFs = new Map<string, string>([[CSS_PATH, `/* Theme Name: Aeromatic */
body { margin: 0; font-family: Inter, system-ui, sans-serif; color: #1f2937; background: #f8fafc; }
.hero { padding: 72px 48px; background: linear-gradient(135deg, #eef2ff, #f8fafc); }
.hero__title { color: #111827; font-size: 52px; line-height: 1.1; max-width: 760px; margin: 0 0 24px; }
.hero__cta { display: inline-block; background: #111827; color: #fff; padding: 14px 22px; border-radius: 10px; text-decoration: none; }
.hero img { display: block; margin-top: 32px; max-width: 100%; border-radius: 14px; }
`]]);
const remoteFiles = () => ({
  list: async () => [...hostFs.keys()].map((p) => ({ name: p.split("/").pop()!, path: p, type: "file", bytes: hostFs.get(p)!.length })),
  readViaApi: async (p: string) => hostFs.get(p) ?? "",
  upload: async (p: string, c: string) => { await new Promise((r) => setTimeout(r, 500)); hostFs.set(p, c); },
});

// ------------------------------------------------------------------ fake WordPress
const wp = { title: "Delivering Reliable Process Solutions.", cta: "Request Consultation", imageId: 7, imageUrl: "https://placehold.co/600x300/png?text=Current+hero", nextId: 100, pages: new Map<number, any>() };
// The REAL plugin widget (livecrafts/assets/widget.js + .css) is loaded on every demo page, exactly like WordPress does it.
const PLUGIN_ASSETS = path.resolve(process.cwd(), "..", "livecrafts", "livecrafts", "assets");
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 8791);
const widgetTags = (pageKey = "p5") => `<link rel="stylesheet" href="/wp-content/plugins/livecrafts/assets/widget.css">
<script>window.LIVECRAFTS_WIDGET=${JSON.stringify({ backend: `http://127.0.0.1:${DEMO_PORT}`, token: "", botName: "Aero Assistant", welcome: "Hi! I'm the Aeromatic site assistant. Tell me what to change, or pick an element on the page.", accent: "#e8590c", position: "right", approvalMode: "request", siteUrl: wpUrl, user: "admin", pageKey, version: "0.9.2", assets: `${wpUrl}/wp-content/plugins/livecrafts/assets/` })}; window.LIVECRAFTS_WIDGET.pageUrl = location.href;</script>
<script src="/wp-content/plugins/livecrafts/assets/widget.js" defer></script>`;
// Livecrafts style overlay (the plugin prints this in <head>; same format: all screens, tablet ≤1024px, mobile ≤767px)
const patches: Record<string, Record<string, any>> = {};
const overlayCss = (key: string) => {
  let all = "", tablet = "", mobile = "";
  for (const k of ["site", key]) for (const [sel, pt] of Object.entries(patches[k] ?? {})) {
    const decl = (o: Record<string, string>) => Object.entries(o ?? {}).map(([p, v]) => `${p}:${v} !important`).join(";");
    if (pt.styles) all += `${sel}{${decl(pt.styles)}}\n`;
    if (pt.styles_tablet) tablet += `${sel}{${decl(pt.styles_tablet)}}\n`;
    if (pt.styles_mobile) mobile += `${sel}{${decl(pt.styles_mobile)}}\n`;
  }
  return all + (tablet ? `@media (max-width:1024px){${tablet}}` : "") + (mobile ? `@media (max-width:767px){${mobile}}` : "");
};
const textScript = (key: string) => {
  const t: Record<string, string> = {};
  for (const k of ["site", key]) for (const [sel, pt] of Object.entries(patches[k] ?? {})) if (pt.text) t[sel] = pt.text;
  return Object.keys(t).length ? `<script>(function(){var m=${JSON.stringify(t)};Object.keys(m).forEach(function(s){var e=document.querySelector(s);if(e)e.textContent=m[s];});})();</script>` : "";
};
const pageHtml = (body: string, key = "p5") => `<!doctype html><html><head><title>Aeromatic - Process Solutions</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/${CSS_PATH}?ver=1"><style id="livecrafts-patches">${overlayCss(key)}</style></head><body>${body}${textScript(key)}${widgetTags(key)}</body></html>`;
const fakeWp = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const json = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const route = u.pathname.replace("/wp-json/livecrafts/v1/", "");
  if (route === "ping") return json(200, { ok: true, plugin: "livecrafts", version: "0.8.0", site: { wp: "6.8", php: "8.3" }, user: { login: "admin", can_edit_pages: true, can_edit_themes: true }, capabilities: { acf: true, elementor: false, theme_files: false, theme: "aeromatic" } });
  if (route === "patches") { const key = u.searchParams.get("pageKey") || "p5"; return json(200, { ok: true, pageKey: key, page: patches[key] ?? {}, site: patches.site ?? {} }); }
  if ((route === "save" || route === "revert") && req.method === "POST") {
    const b = JSON.parse(raw.toString()); const key = b.scope === "site" ? "site" : b.pageKey;
    patches[key] ??= {};
    if (route === "revert") delete patches[key][b.selector];
    else { const pt: any = {}; for (const k of ["styles", "styles_tablet", "styles_mobile"]) if (b[k]) pt[k] = b[k]; if (typeof b.text === "string") pt.text = b.text; patches[key][b.selector] = pt; }
    return json(200, { ok: true });
  }
  if (route === "assistant") return json(200, { ok: true, botName: "Aero Assistant", welcome: "Hi! I'm the Aeromatic site assistant. Tell me what to change, or pick an element on the page.", instructions: "Brand colours: #e8590c and #111827.", model: "", approvalMode: "request", accent: "#e8590c" });
  const asset = u.pathname.match(/^\/wp-content\/plugins\/livecrafts\/assets\/((?:vendor\/)?[\w.-]+\.(js|css))$/);
  if (asset) { res.writeHead(200, { "Content-Type": asset[2] === "js" ? "text/javascript" : "text/css", "Cache-Control": "no-store" }); return res.end(fs.readFileSync(path.join(PLUGIN_ASSETS, asset[1]))); }
  if (route === "map") return json(200, {
    ok: true, post: { id: 5, title: "Home", url: wpUrl + "/" }, builders: { acf_fields: 3 }, elementor: [],
    acf: [
      { kind: "acf", tid: "acf:field_hero_title:5", label: "Hero title", name: "hero_title", ftype: "text", value: wp.title },
      { kind: "acf", tid: "acf:field_hero_cta:5", label: "Button label", name: "hero_cta_label", ftype: "text", value: wp.cta },
      { kind: "acf", tid: "acf:field_hero_image:5", label: "Hero image", name: "hero_image", ftype: "image", value: wp.imageId, url: wp.imageUrl },
    ],
  });
  if (route === "debug/target") { const t = u.searchParams.get("targetId") ?? ""; return json(200, { stored_raw: t.includes("hero_title") ? wp.title : t.includes("hero_cta") ? wp.cta : wp.imageId }); }
  if (route === "target" && req.method === "POST") {
    const b = JSON.parse(raw.toString()); await new Promise((r) => setTimeout(r, 600));
    if (b.targetId.includes("hero_title")) wp.title = b.value; else if (b.targetId.includes("hero_cta")) wp.cta = b.value; else { wp.imageId = Number(b.value); wp.imageUrl = `${wpUrl}/wp-content/uploads/${wp.imageId}.png`; }
    return json(200, { ok: true, value: b.value, verified: { database: true } });
  }
  if (u.pathname === "/wp-json/wp/v2/media" && req.method === "POST") { await new Promise((r) => setTimeout(r, 700)); const id = wp.nextId++; return json(201, { id, source_url: `${wpUrl}/wp-content/uploads/${id}.png`, mime_type: req.headers["content-type"], title: { rendered: "Uploaded" } }); }
  const pm = u.pathname.match(/^\/wp-json\/wp\/v2\/pages\/(\d+)$/);
  if (u.pathname === "/wp-json/wp/v2/pages" && req.method === "POST") {
    const b = JSON.parse(raw.toString()); await new Promise((r) => setTimeout(r, 500));
    const id = wp.nextId++, slug = String(b.slug ?? b.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const pg = { id, title: b.title, content: b.content, status: b.status ?? "publish", slug };
    wp.pages.set(id, pg);
    return json(201, { id, link: `${wpUrl}/${slug}/`, status: pg.status, title: { raw: pg.title, rendered: pg.title }, content: { raw: pg.content } });
  }
  if (pm && req.method === "DELETE") { const pg = wp.pages.get(Number(pm[1])); if (pg) pg.status = "trash"; return json(200, { id: Number(pm[1]), status: "trash" }); }
  if (u.pathname === "/wp-json/wp/v2/pages") return json(200, [{ id: 5, title: { rendered: "Home" }, link: wpUrl + "/", status: "publish" }, { id: 9, title: { rendered: "About us" }, link: wpUrl + "/about/", status: "publish" }, { id: 12, title: { rendered: "Contact" }, link: wpUrl + "/contact/", status: "publish" }]);
  if (u.pathname === "/" + CSS_PATH) { res.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "no-store" }); return res.end(hostFs.get(CSS_PATH)); }
  const created = [...wp.pages.values()].find((p) => u.pathname === `/${p.slug}/` && p.status === "publish");
  if (created) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(pageHtml(`<main class="hero"><h1 class="hero__title">${created.title}</h1>${String(created.content).replace(/<!--[\s\S]*?-->/g, "")}</main>`)); }
  if ([...wp.pages.values()].some((p) => u.pathname === `/${p.slug}/`)) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end(pageHtml("<main class='hero'><h1>Page not found</h1><p>This page is in the Trash.</p></main>")); }
  if (u.pathname === "/" || u.pathname.endsWith("/")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(pageHtml(`<section class="hero"><h1 class="hero__title">${wp.title}</h1><a class="hero__cta" href="#">${wp.cta}</a><img src="${wp.imageUrl}"></section>`)); }
  json(404, { code: "rest_no_route", message: "No route" });
});
await new Promise<void>((r) => fakeWp.listen(0, "127.0.0.1", r));
const wpUrl = `http://127.0.0.1:${(fakeWp.address() as any).port}`;

// ------------------------------------------------------------------ rule-based stand-in for the model (streams its text)
const textOf = (m: any) => (Array.isArray(m?.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ") : String(m?.content ?? ""));
const isVisual = (m: any) => m.role === "user" && Array.isArray(m.content) && String(m.content[0]?.text ?? "").startsWith("[[lc-visual]]");
const lastUserText = (prompt: any[]) => textOf([...prompt].reverse().find((m) => m.role === "user" && !isVisual(m)));
const lastTool = (prompt0: any[]) => {
  const prompt = prompt0.filter((m) => !isVisual(m));
  const last = prompt[prompt.length - 1];
  if (last?.role !== "tool") return null;
  const part = [...last.content].reverse().find((c: any) => c.type === "tool-result");
  const out = part?.output;
  return part ? { name: part.toolName as string, out: out?.value ?? out, denied: JSON.stringify(out ?? "").toLowerCase().includes("denied") } : null;
};

let lastBackup = "";
const prev = { title: "", h1: "", color: "", size: "" };
const model = mockModel(async ({ prompt }: any) => {
  await new Promise((r) => setTimeout(r, 450));
  const user = lastUserText(prompt);
  const tool = lastTool(prompt);
  // remember what earlier look-tools returned (for the demo summary)
  for (const m of prompt) if (m.role === "tool") for (const c of m.content ?? []) if (c.type === "tool-result") {
    const v = c.output?.value ?? c.output;
    if (c.toolName === "read_page" && v?.title) { prev.title = v.title; prev.h1 = v.headings?.[0]?.text ?? ""; }
    if (c.toolName === "inspect_element" && v?.elements?.[0]) { prev.color = v.elements[0].computed?.color ?? ""; prev.size = v.elements[0].computed?.["font-size"] ?? ""; }
  }
  const wanted = user.match(/\bto\s+["“]?(.+?)["”]?\s*$/im)?.[1];
  const fileId = user.match(/file_[a-f0-9]+/)?.[0];
  // a Quick-actions style request says "color: #old → #new" - use the new one
  const colour = (user.match(/color: [^\n]*?→\s*(#[0-9a-f]{3,6})\b/i)?.[1] ?? user.match(/\b(blue|red|green|purple|orange|black|#[0-9a-f]{3,6})\b/i)?.[1])?.toLowerCase();
  const HEX: Record<string, string> = { blue: "#1d4ed8", red: "#b91c1c", green: "#15803d", purple: "#7e22ce", orange: "#c2410c", black: "#111827" };
  const styleAsk = !!colour && /title|heading/i.test(user);
  const revertAsk = /\b(revert|restore|undo)\b/i.test(user) && !!lastBackup;
  const pageAsk = /\b(blog|new page|create (a )?page)\b/i.test(user);
  const lookAsk = /\b(read|look at|check) (this|the) (page|title|hero)\b/i.test(user);

  if (!tool) {
    if (revertAsk) return call("restore_file", { backupId: lastBackup, reason: "Put the theme stylesheet back the way it was" });
    if (styleAsk) return call("inspect_element", { text: wp.title.slice(0, 20) });
    if (lookAsk) return call("read_page", /mobile/i.test(user) ? { device: "mobile" } : {});
    if (pageAsk) return call("create_page", {
      title: "Blog", status: "publish", reason: "Create a Blog page with an intro and the latest articles",
      content: [
        '<!-- wp:paragraph {"className":"blog-intro"} -->', '<p class="blog-intro">News, guides and project stories from the Aeromatic team.</p>', "<!-- /wp:paragraph -->",
        '<!-- wp:latest-posts {"postsToShow":6,"displayPostDate":true,"displayFeaturedImage":true,"postLayout":"grid","columns":3} /-->',
      ].join("\n"),
    });
    if (fileId) return call("upload_media_from_chat", { fileId, title: "Hero image" });
    if (/list.*pages|which pages/i.test(user)) return call("list_pages", {});
    return call("get_page_map", {});
  }
  if (tool.denied) return say("Okay — **I won't change anything.** Tell me what you'd like instead, or pick a different field.");
  if (tool.name === "inspect_element" && styleAsk) return call("read_file", { path: CSS_PATH });
  if (tool.name === "read_file" && styleAsk) {
    const cur = hostFs.get(CSS_PATH)!.match(/\.hero__title \{ color: (#[0-9a-f]+);/i)?.[1] ?? "#111827";
    return call("edit_file", { path: CSS_PATH, find: `.hero__title { color: ${cur};`, replace: `.hero__title { color: ${HEX[colour!] ?? colour};`, reason: `Make the hero title ${colour}` });
  }
  if (tool.name === "edit_file") { lastBackup = tool.out?.backupId ?? lastBackup; return tool.out?.ok === false ? say(`The edit did not go through: ${tool.out?.error ?? "unknown error"}`) : call("screenshot_page", { text: wp.title.slice(0, 20) }); }
  if (tool.name === "restore_file") return call("screenshot_page", { text: wp.title.slice(0, 20) });
  if (tool.name === "create_page") return tool.out?.ok === false ? say(`Could not create the page: ${tool.out?.error}`) : call("screenshot_page", { url: tool.out?.link, device: "mobile" });
  if (tool.name === "screenshot_page" && pageAsk) {
    return say("Created the **Blog** page and checked it on a phone-size screen (screenshot above):\n\n- Intro line + a **3-column grid of the latest 6 posts** (stacks to one column on mobile)\n- It is live and shown in the Preview panel\n\nDon't like it? Press **Revert** on this change in the *Changes* panel — the page goes to the Trash.");
  }
  if (tool.name === "screenshot_page" && !lookAsk) {
    return say(revertAsk
      ? "Reverted. The theme stylesheet is back to its original version — the screenshot above shows the live hero title again."
      : `Done. I changed one line in \`${CSS_PATH}\`:

- **Rule:** \`.hero__title\`
- **Colour:** → **${colour}** (${HEX[colour!] ?? colour})
- **Checked:** the live stylesheet has the new value and the page still loads ✓

The screenshot above is the live page. Say *“revert it”* to put it back.`);
  }
  if (tool.name === "read_page" && lookAsk) return tool.out?.ok === false ? say(`I could not read the page: ${tool.out?.error}`) : call("inspect_element", { text: (tool.out?.headings?.[0]?.text ?? "").slice(0, 20) || "Delivering", ...(/mobile/i.test(user) ? { device: "mobile" } : {}) });
  if (tool.name === "inspect_element" && lookAsk) return tool.out?.ok === false ? say(`I could not inspect it: ${tool.out?.error}`) : call("screenshot_page", { selector: "h1", ...(/mobile/i.test(user) ? { device: "mobile" } : {}) });
  if (tool.name === "screenshot_page" && lookAsk) {
    return say(`I looked through **${String(tool.out?.seenBy ?? "a browser")}** (${tool.out?.device ?? "desktop"}). The page title is "${prev.title}", the main heading is "${prev.h1}" in ${prev.color}, ${prev.size}. Screenshot: ${tool.out?.ok === false ? "failed - " + tool.out?.error : "taken (" + (tool.out?.screenshotId ?? "") + ")"}.`);
  }
  if (tool.name === "list_pages") return say("This site has **3 published pages**:\n\n1. **Home** — the landing page with the hero section\n2. **About us**\n3. **Contact**\n\nTell me which one to work on and what to change.");
  if (tool.name === "get_page_map") {
    if (fileId) return call("set_content", { target: "acf:field_hero_image:5", value: "100", reason: "Use the attached image as the hero image" });
    if (wanted && /title|heading/i.test(user)) return call("set_content", { target: "acf:field_hero_title:5", value: wanted, reason: `Change the hero title to “${wanted}”` });
    if (wanted && /button|cta/i.test(user)) return call("set_content", { target: "acf:field_hero_cta:5", value: wanted, reason: `Change the hero button label to “${wanted}”` });
    const rows = (tool.out?.targets ?? []).map((x: any) => `| ${x.label} | ${x.type} | ${String(x.value).slice(0, 48)} |`).join("\n");
    return say(`Here's everything I can edit on the **Home** page:\n\n| Field | Type | Current value |\n|---|---|---|\n${rows}\n\nJust tell me what to change — for example: *“change the hero title to Welcome”*. I'll show you the exact change and wait for your approval.`);
  }
  if (tool.name === "upload_media_from_chat") return call("set_content", { target: "acf:field_hero_image:5", value: String(tool.out?.id ?? 100), reason: "Set the uploaded image as the hero image" });
  if (tool.name === "set_content") {
    const isImage = /image/.test(JSON.stringify(tool.out ?? "")) || !!fileId;
    return call("verify_page", { url: wpUrl + "/", expectPresent: isImage ? [] : [wanted ?? wp.title] });
  }
  if (tool.name === "verify_page") {
    return say(tool.out?.allPresentFound === false
      ? "I saved the change, but the **public page doesn't show it yet** — it may be cached. Want me to undo it, or check again in a minute?"
      : `Done. Here's what changed:\n\n- **Field:** Hero ${fileId ? "image" : "title"}\n- **Now:** ${fileId ? "your uploaded photo" : `“${wanted ?? wp.title}”`}\n- **Checked:** the live page shows the new content ✓\n\nAnything else you'd like to adjust?`);
  }
  return say("Done.");
}, { delayMs: 28 });

const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const files = new FileStore();
sites.put({ id: "site_demo", name: "Aeromatic (demo)", url: wpUrl, username: "admin", appPassword: "demo demo demo", createdAt: new Date().toISOString(), hosting: { provider: "hostinger", username: "u000000", domain: "aeromatic.demo", dir: "/" } });
const runner = new JobRunner(jobs, sites, buildAgent(files, { model, remoteFiles, hostinger: null }));
const port = Number(process.env.DEMO_PORT ?? 8791);
createApp(runner, sites, files).listen(port, "127.0.0.1", () => {
  console.log(`\nLivecrafts DEMO  →  http://127.0.0.1:${port}\n  fake WordPress: ${wpUrl}\n  try: "change the hero title to Welcome" | "make the hero title blue" then "revert it" | "create a blog page" | attach an image\n`);
});
