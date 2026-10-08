import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import { FileStore } from "./files.js";
import { Bridge } from "./bridge.js";
import { buildAgent } from "./agent.js";
import { JobRunner } from "./jobs.js";
import type { Job, Site } from "./types.js";
import { hostinger, type HostingerHealth } from "./hostinger.js";
import { secrets, type ProviderId } from "./secrets.js";
import { PROVIDERS, providerStatus, testModel } from "./models.js";
import { diffOf } from "./changes.js";
import { canUseSite, verifyWidgetToken, type Caller } from "./auth.js";
import { log } from "./usage.js";
import { eyes } from "./eyes.js";
import { assistantSettings, forgetAssistantSettings } from "./persona.js";
import { closeBrowser, screenshotPath } from "./browser.js";
import { speak, transcribe, voiceInfo } from "./voice.js";

export function createApp(runner: JobRunner, sites: JsonStore<Site>, files: FileStore) {
  const publicSite = (s: Site) => ({ id: s.id, name: s.name, url: s.url, username: s.username, createdAt: s.createdAt, hosting: s.hosting ?? null }); // never expose the password
  let lastHealth: HostingerHealth | null = null;
  const checkHostinger = async () => (lastHealth = await hostinger.health());
  /** Find the site's folder on Hostinger. Best effort: the site still works for content edits without it. */
  const linkSite = async (site: Site): Promise<string | null> => {
    if (!secrets.hostingerToken()) return "Hostinger is not connected.";
    try {
      const p = await hostinger.findPlacement(site.url);
      if (!p) return "This site was not found on the connected Hostinger account.";
      site.hosting = p;
      sites.put(site);
      return null;
    } catch (e) { return (e as Error).message; }
  };
  const publicJob = (j: Job) => ({ id: j.id, siteId: j.siteId, prompt: j.prompt, status: j.status, pending: j.pending, result: j.result, error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt, lastEventSeq: j.events.at(-1)?.seq ?? 0, changes: j.changes ?? [],
    approvalMode: j.approvalMode ?? "every", model: j.model ?? null, requestSeq: j.requestSeq ?? 1, pageUrl: j.pageUrl ?? null, actor: j.actor ?? null, usage: j.usage ?? null });
  /** Fetch the site secret its widget tokens are signed with (needs an administrator's Application Password). */
  const connectWidget = async (site: Site): Promise<string | null> => {
    try { const c = await new Bridge(site).connect(); secrets.setSiteSecret(site.id, c.secret); log("info", "site connected", { site: site.id, url: site.url, plugin: c.version }); return null; }
    catch (e) { log("warn", "site secret not available", { site: site.id, error: (e as Error).message }); return `The chat widget cannot sign in people on this site yet: ${(e as Error).message} (connect with an administrator's Application Password and Livecrafts 0.10+).`; }
  };
  const sameSite = (a: string, b: string) => a.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase() === b.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
  const requestOpts = (b: any, caller: Caller) => ({
    approvalMode: b.approvalMode, model: typeof b.model === "string" ? b.model.trim() : undefined, kind: ["new", "note", "edit"].includes(b.kind) ? b.kind : undefined,
    pageUrl: typeof b.pageUrl === "string" && /^https?:\/\//.test(b.pageUrl) ? b.pageUrl : undefined,
    actor: caller.via === "widget" ? { token: caller.token, name: caller.user.name, login: caller.user.login } : undefined,
  });
  // What the chat inside the WordPress widget may call (with its signed per-person token).
  const WIDGET_ROUTES = /^(GET \/(health|sites|models|voice)|POST \/voice\/(transcribe|speak)|GET \/sites\/[\w-]+\/(assistant|eyes)|POST \/sites\/[\w-]+\/eyes\/eye_[a-f0-9]+|POST \/files|GET \/(files|screens)\/[\w-]+|GET \/jobs|POST \/jobs|(GET|DELETE) \/jobs\/[\w-]+|POST \/jobs\/[\w-]+\/(messages|approvals|stop|resume)|PUT \/jobs\/[\w-]+\/approval-mode|GET \/jobs\/[\w-]+\/(events|changes\/lc_\d+\/diff)|POST \/jobs\/[\w-]+\/(changes\/lc_\d+\/revert|requests\/\d+\/revert))$/;

  async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(c as Buffer); }
    return Buffer.concat(chunks);
  }
  const readJson = async (req: http.IncomingMessage) => { const b = await readBody(req, 1_000_000); return b.length ? JSON.parse(b.toString("utf8")) : {}; };
  const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

  // Builds the "what the user attached / is looking at" lines that go in front of the prompt.
  function contextFor(b: any): string | undefined {
    const ctx: string[] = [];
    if (b.pageUrl) ctx.push(`The user is looking at: ${b.pageUrl}`);
    if (b.selectedTarget) ctx.push(`The user selected this element (target id): ${b.selectedTarget}`);
    if (typeof b.extraContext === "string" && b.extraContext.trim()) ctx.push(b.extraContext.trim().slice(0, 6000)); // e.g. the element picked in the widget
    if (Array.isArray(b.fileIds) && b.fileIds.length) {
      const names = b.fileIds.map((id: string) => { try { return `${id} (${files.read(String(id)).meta.filename})`; } catch { return String(id); } });
      ctx.push(`The user attached image file(s): ${names.join(", ")}. You can see them below. To put one on the site, upload it with upload_media_from_chat.`);
    }
    return ctx.join("\n") || undefined;
  }
  const fileIdsOf = (b: any): string[] => (Array.isArray(b.fileIds) ? b.fileIds.map(String) : []);

  // The chat UI is a static React build in web/dist, served from the same origin (so no CORS, and the plugin can iframe it).
  const webRoot = path.resolve(process.cwd(), "web", "dist");
  const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json" };
  function serveStatic(pathname: string, res: http.ServerResponse): boolean {
    if (!fs.existsSync(webRoot)) return false;
    let rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    let file = path.resolve(webRoot, "." + rel);
    if (!file.startsWith(webRoot)) return false; // path traversal guard
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { file = path.join(webRoot, "index.html"); rel = "/index.html"; } // single-page-app fallback
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store" }); // the page itself is never cached, so an update shows at once
    fs.createReadStream(file).pipe(res);
    return true;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = `${req.method} ${url.pathname}`;
    try {
      const isApi = /^\/(health|sites|jobs|files|integrations|screens|models|voice)(\/|$)/.test(url.pathname);
      if (!isApi && req.method === "GET" && serveStatic(url.pathname, res)) return; // UI files are public; the API below is protected
      // Who is calling: the chat in the WordPress widget (signed per-person token, only its own site) or the app / admin.
      let caller: Caller = { via: "admin" };
      const widgetToken = String(req.headers["x-livecrafts-widget"] ?? "");
      if (widgetToken) {
        // No sign-in (owner's decision): the chat works with or without the plugin's token. A valid token only adds who
        // made the change (credit in the history); a missing, expired or invalid one is NOT an error. The widget still
        // only gets the chat routes. Access control is the network: keep the backend on localhost or behind a tunnel.
        if (!WIDGET_ROUTES.test(route)) return send(res, 403, { error: "Not available from the widget." });
        const w = verifyWidgetToken(widgetToken, sites.list());
        if (w) {
          if (!w.user.edit) return send(res, 403, { error: "Your WordPress account may not edit with Livecrafts." });
          caller = { via: "widget", site: w.site, user: w.user, token: widgetToken };
          const jm = url.pathname.match(/^\/jobs\/([\w-]+)/);
          if (jm) { const j = runner.get(jm[1]); if (j && !canUseSite(caller, j.siteId)) return send(res, 404, { error: "Unknown job" }); }
          const sm = url.pathname.match(/^\/sites\/([\w-]+)/);
          if (sm && !canUseSite(caller, sm[1])) return send(res, 404, { error: "Unknown site" });
        }
      } else if (config.apiToken && route !== "GET /health" && req.headers.authorization !== `Bearer ${config.apiToken}`) {
        return send(res, 401, { error: "Unauthorized" });
      }

      if (route === "GET /health") return send(res, 200, { ok: true, model: config.model, authRequired: !!config.apiToken });

      // ---- sites
      const pt = url.pathname.match(/^\/sites\/([\w-]+)\/preview-token$/);
      if (pt && req.method === "POST") { // the console preview shows the DRAFT view (what editors see) with a short-lived view-only token
        const ps = sites.get(pt[1]);
        if (!ps || !canUseSite(caller, ps.id)) return send(res, 404, { error: "Unknown site" });
        const r = await new Bridge(ps, caller.via === "widget" ? caller.token : undefined).previewToken();
        return send(res, 200, { token: r.token, param: r.param });
      }
      if (route === "GET /sites") return send(res, 200, sites.list().filter((x) => canUseSite(caller, x.id)).map(publicSite));
      if (route === "POST /sites") {
        const b = await readJson(req);
        const siteUrl = String(b.url ?? "").trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(siteUrl) || !b.username || !b.appPassword) return send(res, 400, { error: "url (http/https), username and appPassword are required." });
        // The same site added again = reconnect it (new login) instead of creating a duplicate.
        const existing = sites.list().find((x) => sameSite(x.url, siteUrl));
        const site: Site = existing
          ? { ...existing, url: siteUrl, username: String(b.username), appPassword: String(b.appPassword), name: String(b.name || existing.name) }
          : { id: newId("site"), name: String(b.name || new URL(siteUrl).host), url: siteUrl, username: String(b.username), appPassword: String(b.appPassword), createdAt: new Date().toISOString() };
        let info: any = null;
        try { info = await new Bridge(site).ping(); } catch (e) { return send(res, 400, { error: `Could not connect: ${(e as Error).message}` }); } // validate credentials BEFORE saving
        sites.put(site);
        forgetAssistantSettings(site.id);
        const widgetNote = await connectWidget(site);
        const hostingNote = await linkSite(site); // automatic, best effort
        return send(res, existing ? 200 : 201, { ...publicSite(site), plugin: info, hostingNote, widgetNote, reconnected: !!existing });
      }
      let m = url.pathname.match(/^\/sites\/([\w-]+)$/);
      if (m && req.method === "DELETE") { sites.delete(m[1]); secrets.setSiteSecret(m[1], null); forgetAssistantSettings(m[1]); return send(res, 200, { ok: true }); }
      if (m && req.method === "PUT") { // rename / reconnect with a new Application Password (checked before saving)
        const cur = sites.get(m[1]);
        if (!cur) return send(res, 404, { error: "Unknown site" });
        const b = await readJson(req);
        const next: Site = { ...cur, name: b.name ? String(b.name).slice(0, 80) : cur.name, username: b.username ? String(b.username) : cur.username, appPassword: b.appPassword ? String(b.appPassword) : cur.appPassword };
        let info: any = null;
        try { info = await new Bridge(next).ping(); } catch (e) { return send(res, 400, { error: `Could not connect with these details: ${(e as Error).message}` }); }
        sites.put(next); forgetAssistantSettings(next.id);
        return send(res, 200, { ...publicSite(next), plugin: info, widgetNote: await connectWidget(next) });
      }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/status$/);
      if (m && req.method === "GET") { // connection check for the Sites screen
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        const t = Date.now();
        try {
          const info: any = await new Bridge(s).ping();
          return send(res, 200, { ok: true, ms: Date.now() - t, plugin: info?.version ?? null, wp: info?.site?.wp ?? null, php: info?.site?.php ?? null, user: info?.user ?? null, themeFiles: !!info?.capabilities?.theme_files, theme: info?.capabilities?.theme ?? null, acf: !!info?.capabilities?.acf, elementor: !!info?.capabilities?.elementor, checkedAt: new Date().toISOString() });
        } catch (e) { return send(res, 200, { ok: false, ms: Date.now() - t, error: (e as Error).message, checkedAt: new Date().toISOString() }); }
      }
      // ---- "eyes": the widget lends the person's browser to the assistant (live line + answers)
      m = url.pathname.match(/^\/sites\/([\w-]+)\/eyes$/);
      if (m && req.method === "GET") {
        if (!sites.get(m[1])) return send(res, 404, { error: "Unknown site" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const off = eyes.connect(m[1], res, String(url.searchParams.get("pageUrl") ?? ""), Number(url.searchParams.get("viewport") ?? 0));
        req.on("close", off);
        return;
      }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/eyes\/(eye_[a-f0-9]+)$/);
      if (m && req.method === "POST") {
        const b = await readBody(req, 8_000_000).then((x) => (x.length ? JSON.parse(x.toString("utf8")) : {}));
        return eyes.respond(m[2], b) ? send(res, 200, { ok: true }) : send(res, 404, { error: "That request is no longer waiting." });
      }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/assistant$/);
      if (m && req.method === "GET") { // bot name / welcome text / defaults set in WordPress
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        return send(res, 200, (await assistantSettings(s, { fresh: url.searchParams.has("fresh") })) ?? {});
      }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/link-hosting$/);
      if (m && req.method === "POST") {
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        const note = await linkSite(s);
        return note ? send(res, 400, { error: note }) : send(res, 200, publicSite(sites.get(m[1])!));
      }

      // ---- integrations: Hostinger (token + health check). The token is never sent back to the browser.
      if (route === "GET /integrations") return send(res, 200, { hostinger: lastHealth ?? (await checkHostinger()), models: providerStatus(), defaultModel: config.model });

      // ---- AI providers: keys are stored on the backend only, never sent back
      m = url.pathname.match(/^\/integrations\/models\/(openai|anthropic|openrouter|groq|custom)$/);
      if (m && req.method === "PUT") {
        const id = m[1] as ProviderId;
        const b = await readJson(req);
        const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : undefined;
        const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : undefined;
        if (baseUrl && !/^https?:\/\//.test(baseUrl)) return send(res, 400, { error: "The address must start with http:// or https://" });
        if (apiKey && secrets.providerSource(id) === "env") return send(res, 409, { error: "This provider's key is set in the backend .env, which always wins. Change it there." });
        const before = providerStatus().find((x) => x.id === id);
        secrets.setProvider(id, { ...(apiKey ? { apiKey } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) });
        const testWith = typeof b.testModel === "string" && b.testModel.trim() ? `${id}:${b.testModel.trim()}` : null;
        if (testWith) {
          const t = await testModel(testWith);
          if (!t.ok && apiKey && before?.keySource !== "saved") secrets.setProvider(id, null); // do not keep a key that does not work
          if (!t.ok) return send(res, 400, { error: t.error, test: t });
          return send(res, 200, { ok: true, test: t, models: providerStatus() });
        }
        return send(res, 200, { ok: true, models: providerStatus() });
      }
      if (m && req.method === "DELETE") { secrets.setProvider(m[1] as ProviderId, null); return send(res, 200, { ok: true, models: providerStatus() }); }
      if (route === "POST /integrations/models/test") {
        const b = await readJson(req);
        if (!b.model) return send(res, 400, { error: "model is required (provider:model)." });
        return send(res, 200, await testModel(String(b.model)));
      }
      if (route === "GET /models") return send(res, 200, { defaultModel: config.model, providers: PROVIDERS.map((p) => ({ ...p, configured: providerStatus().find((x) => x.id === p.id)?.configured })) });
      if (route === "POST /integrations/hostinger/test") return send(res, 200, await checkHostinger());
      if (route === "PUT /integrations/hostinger") {
        const b = await readJson(req);
        const token = String(b.token ?? "").trim();
        if (!token) return send(res, 400, { error: "Paste a Hostinger API token." });
        if (secrets.hostingerSource() === "env") return send(res, 409, { error: "HOSTINGER_API_TOKEN is set in the backend .env, which always wins. Change it there." });
        const previous = secrets.hostingerSource() === "saved" ? secrets.hostingerToken() : "";
        secrets.setHostingerToken(token);
        await hostinger.reset();
        const h = await checkHostinger();
        if (!h.connected) { // never keep a token that does not work: put the previous one back
          secrets.setHostingerToken(previous ?? ""); await hostinger.reset();
          lastHealth = null;
          return send(res, 400, { error: h.error ?? "Could not connect with this token." });
        }
        for (const s of sites.list()) if (!s.hosting) await linkSite(s); // link existing sites automatically
        return send(res, 200, h);
      }
      if (route === "DELETE /integrations/hostinger") { secrets.setHostingerToken(""); await hostinger.reset(); return send(res, 200, await checkHostinger()); }

      // ---- screenshots taken by the agent
      const shot = url.pathname.match(/^\/screens\/(shot_[a-f0-9]+)$/);
      if (shot && req.method === "GET") {
        const f = screenshotPath(shot[1]);
        if (!f) return send(res, 404, { error: "Unknown screenshot" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" });
        return void fs.createReadStream(f).pipe(res);
      }

      m = url.pathname.match(/^\/sites\/([\w-]+)\/ping$/);
      if (m && req.method === "POST") { const s = sites.get(m[1]); if (!s) return send(res, 404, { error: "Unknown site" }); return send(res, 200, await new Bridge(s).ping()); }

      // ---- voice: what the person says -> text; the assistant's answer -> speech
      if (route === "GET /voice") return send(res, 200, voiceInfo());
      if (route === "POST /voice/transcribe") {
        const buf = await readBody(req, 12_000_000);
        return send(res, 200, await transcribe(buf, String(req.headers["content-type"] ?? "")));
      }
      if (route === "POST /voice/speak") {
        const b = await readJson(req);
        const audio = await speak(String(b.text ?? ""), typeof b.voice === "string" ? b.voice : undefined);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
        return void res.end(audio);
      }

      // ---- files (images from the user's computer)
      if (route === "POST /files") {
        const buf = await readBody(req, 15_000_000);
        const meta = files.save(buf, path.basename(String(req.headers["x-filename"] ?? "image")), String(req.headers["content-type"] ?? ""));
        return send(res, 201, meta);
      }
      const fileMatch = url.pathname.match(/^\/files\/(file_[a-f0-9]+)$/);
      if (fileMatch && req.method === "GET") { // show an attached image in the chat
        try { const f = files.read(fileMatch[1]); res.writeHead(200, { "Content-Type": f.meta.mime, "Cache-Control": "private, max-age=3600" }); return void res.end(f.buf); }
        catch { return send(res, 404, { error: "Unknown file" }); }
      }

      // ---- jobs
      if (route === "GET /jobs") return send(res, 200, runner.list().filter((j) => canUseSite(caller, j.siteId)).map(publicJob));
      if (route === "POST /jobs") {
        const b = await readJson(req);
        if (!b.siteId || !b.prompt) return send(res, 400, { error: "siteId and prompt are required." });
        if (!canUseSite(caller, String(b.siteId))) return send(res, 404, { error: "Unknown site." });
        return send(res, 201, publicJob(runner.create(String(b.siteId), String(b.prompt), contextFor(b), fileIdsOf(b), requestOpts(b, caller))));
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/messages$/);
      if (m && req.method === "POST") { // follow-up message in the same conversation
        const b = await readJson(req);
        if (!b.prompt) return send(res, 400, { error: "prompt is required." });
        return send(res, 200, publicJob(runner.continue(m[1], String(b.prompt), contextFor(b), fileIdsOf(b), requestOpts(b, caller))));
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)$/);
      if (m && req.method === "DELETE") { try { runner.delete(m[1]); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: (e as Error).message }); } }
      if (m && req.method === "GET") { await runner.syncChanges(m[1]); const j = runner.get(m[1]); return j ? send(res, 200, { ...publicJob(j), events: j.events }) : send(res, 404, { error: "Unknown job" }); }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/approvals$/);
      if (m && req.method === "POST") {
        const b = await readJson(req);
        if (!b.approvalId || typeof b.approved !== "boolean") return send(res, 400, { error: "approvalId and approved (true/false) are required." });
        return send(res, 200, publicJob(runner.respond(m[1], String(b.approvalId), b.approved, b.reason ? String(b.reason) : undefined, caller.via === "widget" ? caller.token : undefined)));
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/stop$/);
      if (m && req.method === "POST") { try { return send(res, 200, publicJob(runner.stop(m[1]))); } catch (e) { return send(res, 409, { error: (e as Error).message }); } }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/approval-mode$/);
      if (m && req.method === "PUT") { const b = await readJson(req); return send(res, 200, publicJob(runner.setApprovalMode(m[1], b.mode))); }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/requests\/(\d+)\/revert$/);
      if (m && req.method === "POST") { // revert everything one request changed
        try { return send(res, 200, await runner.revertRequest(m[1], Number(m[2]))); }
        catch (e) { return send(res, 409, { error: (e as Error).message }); }
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/changes\/(lc_\d+)\/diff$/);
      if (m && req.method === "GET") { // GitHub-style diff of one change (from the site history)
        const j = runner.get(m[1]);
        const c = j?.changes?.find((x) => x.id === m![2]);
        const s = j ? sites.get(j.siteId) : undefined;
        if (!j || !c || !s) return send(res, 404, { error: "Unknown change" });
        const d = await diffOf(c, new Bridge(s, j.actorToken)).catch(() => null);
        return d ? send(res, 200, d) : send(res, 404, { error: "No diff stored for this change." });
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/changes\/(lc_\d+)\/revert$/);
      if (m && req.method === "POST") { // the Revert button on a change
        try { return send(res, 200, await runner.revertChange(m[1], m[2], "button")); }
        catch (e) { return send(res, 409, { error: (e as Error).message }); }
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/resume$/);
      if (m && req.method === "POST") return send(res, 200, publicJob(runner.resume(m[1])));

      // ---- live progress (Server-Sent Events). Close the browser any time: the job keeps running; reconnect with ?after=<last seq>.
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/events$/);
      if (m && req.method === "GET") {
        if (!runner.get(m[1])) return send(res, 404, { error: "Unknown job" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const after = Number(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? 0) || 0;
        const off = runner.subscribe(m[1], (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`), after);
        const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        req.on("close", () => { off(); clearInterval(ping); });
        return;
      }

      return send(res, 404, { error: "Not found" });
    } catch (e) {
      const status = (e as any).status ?? 400;
      if (status >= 500) log("error", "request failed", { route, error: (e as Error).message });
      return send(res, status, { error: (e as Error).message });
    }
  });
}

// Start only when run directly (the tests import createApp).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
  const jobs = new JsonStore<Job>(path.join(config.dataDir, "jobs"));
  const files = new FileStore();
  const runner = new JobRunner(jobs, sites, buildAgent(files));
  runner.recover();
  const server = createApp(runner, sites, files);
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`\nPort ${config.port} is already in use - another Livecrafts backend (or another program) is running.\n` +
        `  • Close the other terminal window running "npm start" (or press Ctrl+C there), then run npm start again.\n` +
        `  • Or start this one on another port:   $env:PORT=8792; npm start\n`);
      process.exit(1);
    }
    throw e;
  });
  const shutdown = async () => { await closeBrowser(); await hostinger.reset(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.listen(config.port, config.host, () => {
    console.log(`Livecrafts backend on http://${config.host}:${config.port}  (model: ${config.model})`);
    if (!config.apiToken) console.log("WARNING: LC_API_TOKEN is not set - fine on localhost, set it before exposing this server.");
    if (!process.env.OPENAI_API_KEY && !config.model.includes("/")) console.log("WARNING: OPENAI_API_KEY is not set - jobs will fail until it is.");
  });
}
