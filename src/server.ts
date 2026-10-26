import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import { FileStore } from "./files.js";
import { Bridge, BridgeError } from "./bridge.js";
import { pluginJobs } from "./pluginJobs.js";
import { SectionError, addSection, catalogue, cleanLayout, pageInfo, previewDocument, siteLook } from "./sections/place.js";
import { buildAgent } from "./agent.js";
import { JobRunner } from "./jobs.js";
import type { Job, Site } from "./types.js";
import { hostinger, type HostingerHealth } from "./hostinger.js";
import { secrets, type ProviderId } from "./secrets.js";
import { PROVIDERS, providerStatus, testModel } from "./models.js";

/**
 * The Integrations routes come straight from the provider list, so adding a provider in models.ts is all it takes:
 * the hand-written list that used to be here was a second place to forget.
 */
const SETTABLE = PROVIDERS.filter((p) => !p.needsNoKey).map((p) => p.id).join("|");
const PROVIDER_RE = new RegExp(`^/integrations/models/(${SETTABLE})$`);
const PROVIDER_MODELS_RE = new RegExp(`^/integrations/models/(${PROVIDERS.map((p) => p.id).join("|")})/models$`);
/** The site look (brand colour, fonts) the section previews use, remembered for a few minutes per site. */
const sectionLooks = new Map<string, { at: number; value: Awaited<ReturnType<typeof siteLook>> }>();
import { claudeCliStatus } from "./claudeCli.js";
import { diffOf } from "./changes.js";
import { canUseSite, verifyWidgetToken, type Caller } from "./auth.js";
import { log } from "./usage.js";
import { eyes } from "./eyes.js";
import { assistantSettings, forgetAssistantSettings } from "./persona.js";
import { closeBrowser, screenshotPath } from "./browser.js";
import { speak, siteWordsFromMap, transcribe, voiceInfo } from "./voice.js";
import { Dictation, DICTATE_RATE, dictateModel } from "./dictation.js";
import { voiceSession } from "./sessions.js";
import { createSession as createRealtimeSession, realtimeAvailable, realtimeModel, realtimeVoice } from "./realtime.js";
import { defaultSpeedRuns, needsLocalRun, runSummary, runView, sameHost, type SpeedDevice, type SpeedRuns } from "./pagespeed.js";

export function createApp(runner: JobRunner, sites: JsonStore<Site>, files: FileStore, opts: { speed?: SpeedRuns } = {}) {
  const speed = opts.speed ?? defaultSpeedRuns();
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
    approvalMode: j.approvalMode ?? "every", model: j.model ?? null, layoutPicker: j.layoutPicker !== false, requestSeq: j.requestSeq ?? 1, pageUrl: j.pageUrl ?? null, actor: j.actor ?? null, usage: j.usage ?? null });
  /** Fetch the site secret its widget tokens are signed with (needs an administrator's Application Password). */
  const connectWidget = async (site: Site): Promise<string | null> => {
    try { const c = await new Bridge(site).connect(); secrets.setSiteSecret(site.id, c.secret); log("info", "site connected", { site: site.id, url: site.url, plugin: c.version }); return null; }
    catch (e) { log("warn", "site secret not available", { site: site.id, error: (e as Error).message }); return `The chat widget cannot sign in people on this site yet: ${(e as Error).message} (connect with an administrator's Application Password and Livecrafts 0.10+).`; }
  };
  const sameSite = (a: string, b: string) => a.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase() === b.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
  const requestOpts = (b: any, caller: Caller) => ({
    approvalMode: b.approvalMode, model: typeof b.model === "string" ? b.model.trim() : undefined, kind: ["new", "note", "edit"].includes(b.kind) ? b.kind : undefined,
    layoutPicker: b.layoutPicker === false ? false : undefined,
    pageUrl: typeof b.pageUrl === "string" && /^https?:\/\//.test(b.pageUrl) ? b.pageUrl : undefined,
    voice: b.voice === true,
    actor: caller.via === "widget" ? { token: caller.token, name: caller.user.name, login: caller.user.login } : undefined,
  });
  // What the chat inside the WordPress widget may call (with its signed per-person token).
  /**
   * What the widget's own token may call. Both template routes are read-only and were added for the layout
   * picker: the person in the widget is a signed-in editor of this site, the list only names templates and the
   * pages they are already on, and the render route returns a template filled with SAMPLE content, never theirs.
   */
  const WIDGET_ROUTES = /^(GET \/(health|sites|models|voice)|POST \/sites|POST \/voice\/(transcribe|speak|realtime\/session)|GET \/voice\/stream|GET \/sites\/[\w-]+\/(assistant|eyes|media|terms|pagespeed|templates|templates\/render|sections|sections\/preview)|POST \/sites\/[\w-]+\/sections\/add|(POST \/sites\/[\w-]+\/pagespeed|GET \/sites\/[\w-]+\/pagespeed\/speed_[a-f0-9]+|PUT \/sites\/[\w-]+\/pagespeed\/speed_[a-f0-9]+\/fix|GET \/sites\/[\w-]+\/plugins(\/(history|versions|jobs\/plj_[a-f0-9]+))?|POST \/sites\/[\w-]+\/plugins\/(update|rollback))|POST \/sites\/[\w-]+\/eyes\/eye_[a-f0-9]+|POST \/files|GET \/(files|screens)\/[\w-]+|GET \/jobs|POST \/jobs|(GET|DELETE) \/jobs\/[\w-]+|POST \/jobs\/[\w-]+\/(messages|approvals|stop|resume)|PUT \/jobs\/[\w-]+\/approval-mode|GET \/jobs\/[\w-]+\/(events|changes\/lc_\d+\/diff)|POST \/jobs\/[\w-]+\/(changes\/lc_\d+\/revert|requests\/\d+\/revert))$/;

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

  /**
   * Read the site ONCE for a voice session: status, notes and the page map, in parallel, into the session's cache
   * (sessions.ts). Every turn of that session then starts with all three in hand instead of fetching them again,
   * and the page map also gives the vocabulary hint the realtime engine needs to hear the site's own names.
   * Best effort: a site that cannot be reached must not stop the voice from starting.
   */
  async function warmVoiceSession(site: Site, pageUrl?: string): Promise<string> {
    const cache = voiceSession(site.id, pageUrl);
    const bridge = new Bridge(site);
    const url = pageUrl || bridge.homeUrl;
    const [map] = await Promise.all([
      cache.get(`map:${url}:draft`, () => bridge.map({ url, view: "draft" })).catch(() => null),
      cache.get("status", () => bridge.status()).catch(() => null),
    ]);
    const post = Number((map as any)?.post?.id) || undefined;
    await cache.get(`notes:${post ?? ""}`, () => bridge.notes(post)).catch(() => null);
    return map ? siteWordsFromMap(map) : "";
  }

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

  const server = http.createServer(async (req, res) => {
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
      // ---- plugin updates with backup + health check + rollback (Livecrafts plugin 0.19+). Live at once, so from the
      // widget only a signed-in person whose WordPress account may update plugins (the plugin checks that too).
      const pl = url.pathname.match(/^\/sites\/([\w-]+)\/plugins(?:\/(history|versions|update|rollback|jobs\/plj_[a-f0-9]+))?$/);
      if (pl) {
        const site = sites.get(pl[1]);
        if (!site || !canUseSite(caller, site.id)) return send(res, 404, { error: "Unknown site" });
        if (req.headers["x-livecrafts-widget"] && caller.via !== "widget") return send(res, 403, { error: "Plugin updates need you to be signed in to WordPress. Reload the page while logged in." });
        const b = new Bridge(site, caller.via === "widget" ? caller.token : undefined);
        const what = pl[2] ?? "";
        if (req.method === "GET" && what === "") return send(res, 200, await b.plugins(url.searchParams.get("refresh") === "1"));
        if (req.method === "GET" && what === "history") return send(res, 200, await b.pluginHistory());
        if (req.method === "GET" && what === "versions") return send(res, 200, await b.pluginVersions(String(url.searchParams.get("plugin") ?? "")));
        if (req.method === "GET" && what.startsWith("jobs/")) {
          const j = pluginJobs().get(what.slice(5));
          return j && j.siteId === site.id ? send(res, 200, j) : send(res, 404, { error: "Unknown update" });
        }
        if (req.method === "POST" && (what === "update" || what === "rollback")) {
          const body = await readJson(req);
          const plugin = String(body.plugin ?? "");
          if (!plugin || plugin.length > 200) return send(res, 400, { error: "Which plugin?" });
          if (what === "update") return send(res, 202, pluginJobs().start(site.id, b, plugin));   // poll GET plugins/jobs/<id>
          return send(res, 200, await b.rollbackPlugin(plugin, { backup: body.backup ? String(body.backup) : undefined, version: body.version ? String(body.version) : undefined }));
        }
        return send(res, 405, { error: "Not allowed" });
      }
      const tm = url.pathname.match(/^\/sites\/([\w-]+)\/terms$/);
      if (tm && req.method === "GET") { // the blog form's category picker
        const ts = sites.get(tm[1]);
        if (!ts || !canUseSite(caller, ts.id)) return send(res, 404, { error: "Unknown site" });
        const b = new Bridge(ts);
        const [categories, tags] = await Promise.all([b.terms("categories"), b.terms("tags")]);
        const view = (t: any) => ({ id: t.id, name: t.name, count: t.count });
        return send(res, 200, { categories: categories.map(view), tags: tags.slice(0, 60).map(view) });
      }
      const md = url.pathname.match(/^\/sites\/([\w-]+)\/media$/);
      if (md && req.method === "GET") { // the blog form's Media Library picker
        const ms = sites.get(md[1]);
        if (!ms || !canUseSite(caller, ms.id)) return send(res, 404, { error: "Unknown site" });
        const list = await new Bridge(ms).mediaList(url.searchParams.get("search") || undefined, Math.max(1, Number(url.searchParams.get("page")) || 1));
        return send(res, 200, list.map((m: any) => ({ id: m.id, url: m.media_details?.sizes?.medium?.source_url ?? m.source_url, full: m.source_url, alt: m.alt_text ?? "", title: m.title?.rendered ?? "" })));
      }
      // ---- PageSpeed reports (Google PageSpeed Insights, or Lighthouse on this machine for a local site)
      const ps = url.pathname.match(/^\/sites\/([\w-]+)\/pagespeed(?:\/(speed_[a-f0-9]+)(\/fix)?)?$/);
      if (ps) {
        const ss = sites.get(ps[1]);
        if (!ss || !canUseSite(caller, ss.id)) return send(res, 404, { error: "Unknown site" });
        if (ps[3]) {
          if (req.method !== "PUT") return send(res, 405, { error: "Use PUT" });
          const b = await readJson(req);
          const key = String(b.key ?? "");
          const status = b.status === null || b.status === "open" ? null : String(b.status);
          if (!/^(mobile|desktop):[\w-]{1,80}$/.test(key) || (status !== null && !["progress", "fixed", "done", "skipped"].includes(status))) return send(res, 400, { error: "Bad fix key or status" });
          const prev = speed.get(ps[2]!);
          if (!prev || prev.siteId !== ss.id) return send(res, 404, { error: "Unknown report" });
          const jobId = typeof b.jobId === "string" && /^job_[a-f0-9]+$/.test(b.jobId) ? b.jobId : undefined;
          const requestId = Number.isInteger(b.requestId) && b.requestId > 0 && b.requestId < 1e6 ? Number(b.requestId) : undefined;
          const r = speed.markFix(ps[2]!, key, status ? { status: status as "progress", jobId, requestId } : null);
          return r ? send(res, 200, runView(r)) : send(res, 404, { error: "Unknown fix" });
        }
        if (ps[2] && req.method === "GET") {
          const r = speed.get(ps[2]);
          return r && r.siteId === ss.id ? send(res, 200, runView(r)) : send(res, 404, { error: "Unknown report" });
        }
        if (!ps[2] && req.method === "GET") {
          const page = url.searchParams.get("url") || undefined;
          return send(res, 200, { runs: speed.history(ss.id, page).map(runSummary), google: { keySource: secrets.pagespeedSource() }, local: needsLocalRun(page || ss.url) });
        }
        if (!ps[2] && req.method === "POST") {
          const b = await readJson(req);
          const page = String(b.url || ss.url).trim();
          if (!sameHost(ss.url, page)) return send(res, 400, { error: "Only pages of this site can be tested." });
          const devices: SpeedDevice[] = b.device === "both" ? ["mobile", "desktop"] : b.device === "desktop" ? ["desktop"] : ["mobile"];
          const busy = speed.history(ss.id, page, 1)[0];
          if (busy?.status === "running") return send(res, 409, { error: "A report for this page is already running.", run: runSummary(busy) });
          return send(res, 202, runSummary(speed.start(ss.id, page, devices)));
        }
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
      // ---- Section Gallery: ready-made sections added with one click (no AI). See src/sections.
      m = url.pathname.match(/^\/sites\/([\w-]+)\/sections(\/preview|\/add)?$/);
      if (m) {
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        const b = new Bridge(s);
        try {
          if (!m[2] && req.method === "GET") { // the catalogue + how the open page is built and where a section can go
            const post = Number(url.searchParams.get("post") ?? 0) || 0;
            let page: any = null;
            if (post) page = await pageInfo(b, post).catch((e) => ({ builder: null, places: [], unsupported: (e as Error).message }));
            return send(res, 200, { ok: true, ...catalogue(), page });
          }
          if (m[2] === "/preview" && req.method === "GET") { // one section as a standalone page in this site's colours and fonts
            const id = String(url.searchParams.get("id") ?? "");
            if (!/^[a-z0-9-]{2,40}$/.test(id)) return send(res, 400, { error: "id must be a section id, e.g. hero-split" });
            const key = `look|${s.id}`;
            let look = sectionLooks.get(key);
            if (!look || Date.now() - look.at > 5 * 60_000) { look = { at: Date.now(), value: await siteLook(b) }; sectionLooks.set(key, look); }
            const measured = cleanLayout({ brand: { color: url.searchParams.get("brand"), on: url.searchParams.get("on"), radius: url.searchParams.get("radius") ?? undefined } });
            return send(res, 200, { ok: true, html: previewDocument(id, look.value, measured), look: look.value });
          }
          if (m[2] === "/add" && req.method === "POST") { // put it on the page as a draft
            const body = await readJson(req);
            const out = await addSection(b, { id: String(body.id ?? ""), postId: Number(body.post ?? 0) || 0, place: body.place ? String(body.place) : undefined, layout: body.layout });
            log("info", `section added: ${out.section}`, { site: s.id, post: body.post, place: out.place, builder: out.builder, layout: out.layout });
            return send(res, 200, out);
          }
        } catch (e) {
          if (e instanceof SectionError) return send(res, e.status, { error: e.message });
          if (e instanceof BridgeError) return send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { error: e.message });
          throw e;
        }
      }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/templates\/render$/);
      if (m && req.method === "GET") { // one template rendered with sample content (the component gallery)
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        const id = String(url.searchParams.get("id") ?? "");
        if (!/^[a-z0-9_-]{2,40}$/.test(id)) return send(res, 400, { error: "id must be a template id, e.g. testimonials" });
        const variant = String(url.searchParams.get("variant") ?? "");
        try { return send(res, 200, await new Bridge(s).renderTemplate(id, /^[a-z0-9_-]{0,20}$/.test(variant) ? variant : "")); }
        catch (e) {
          const msg = String((e as Error).message);
          // The route only exists from plugin 0.17.3: say that, instead of showing "rest_no_route" in every tile.
          return send(res, 502, {
            error: /rest_no_route|404|No route was found/i.test(msg)
              ? "This site's Livecrafts plugin is older than the gallery. Upload the latest plugin zip in WordPress → Plugins → Add New → Upload, then press Refresh."
              : msg,
          });
        }
      }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/templates$/);
      if (m && req.method === "GET") { // which templates of the site's template library exist and where each one is used
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        try { return send(res, 200, await new Bridge(s).templates()); }
        catch (e) {
          if (e instanceof BridgeError && e.status === 404) return send(res, 200, { ok: true, active: false, components: [], note: "The Livecrafts plugin on this site is older than 0.14, so it has no template library. Upload the new plugin zip." });
          return send(res, 200, { ok: false, active: false, components: [], error: (e as Error).message });
        }
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
      if (route === "GET /integrations") return send(res, 200, { hostinger: lastHealth ?? (await checkHostinger()), models: await providerStatus(), defaultModel: config.model, pagespeed: { keySource: secrets.pagespeedSource() } });
      if (route === "PUT /integrations/pagespeed") {
        const b = await readJson(req);
        const key = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(key)) return send(res, 400, { error: "That does not look like a Google API key (it starts with AIza…)." });
        if (secrets.pagespeedSource() === "env") return send(res, 409, { error: "LC_PAGESPEED_API_KEY is set in the backend .env, which always wins. Change it there." });
        secrets.setPagespeedKey(key);
        return send(res, 200, { ok: true, pagespeed: { keySource: secrets.pagespeedSource() } });
      }
      if (route === "DELETE /integrations/pagespeed") { secrets.setPagespeedKey(""); return send(res, 200, { ok: true, pagespeed: { keySource: secrets.pagespeedSource() } }); }

      // ---- AI providers: keys are stored on the backend only, never sent back
      // "Check again": re-reads the Claude CLI on this machine at once, so logging in does not need a restart.
      if (route === "POST /integrations/models/recheck") { await claudeCliStatus(true); return send(res, 200, { ok: true, models: await providerStatus() }); }

      // Add or drop a model name by hand, so a key can be used with models these lists have never heard of.
      m = url.pathname.match(PROVIDER_MODELS_RE);
      if (m && (req.method === "POST" || req.method === "DELETE")) {
        const id = m[1] as ProviderId;
        const b = await readJson(req);
        const name = typeof b.model === "string" ? b.model.trim() : "";
        if (!name) return send(res, 400, { error: "model is required (the model's name at this provider)." });
        if (name.includes(":")) return send(res, 400, { error: 'A model name cannot contain ":" - give the name only, the provider is already chosen.' });
        // Remove first, THEN read the status back - an object literal is built in writing order, so asking for the
        // status on the same line would report the list as it was a moment before.
        if (req.method === "DELETE") { secrets.removeProviderModel(id, name); return send(res, 200, { ok: true, models: await providerStatus() }); }
        if (b.test !== false) {
          const t = await testModel(`${id}:${name}`);
          if (!t.ok) return send(res, 400, { error: t.error, test: t });
        }
        secrets.addProviderModel(id, name);
        return send(res, 200, { ok: true, models: await providerStatus() });
      }

      m = url.pathname.match(PROVIDER_RE);
      if (m && req.method === "PUT") {
        const id = m[1] as ProviderId;
        const b = await readJson(req);
        const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : undefined;
        const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : undefined;
        if (baseUrl && !/^https?:\/\//.test(baseUrl)) return send(res, 400, { error: "The address must start with http:// or https://" });
        if (apiKey && secrets.providerSource(id) === "env") return send(res, 409, { error: "This provider's key is set in the backend .env, which always wins. Change it there." });
        const before = (await providerStatus()).find((x) => x.id === id);
        secrets.setProvider(id, { ...(apiKey ? { apiKey } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) });
        const testWith = typeof b.testModel === "string" && b.testModel.trim() ? `${id}:${b.testModel.trim()}` : null;
        if (testWith) {
          const t = await testModel(testWith);
          if (!t.ok && apiKey && before?.keySource !== "saved") secrets.setProvider(id, null); // do not keep a key that does not work
          if (!t.ok) return send(res, 400, { error: t.error, test: t });
          return send(res, 200, { ok: true, test: t, models: await providerStatus() });
        }
        return send(res, 200, { ok: true, models: await providerStatus() });
      }
      if (m && req.method === "DELETE") { secrets.setProvider(m[1] as ProviderId, null); return send(res, 200, { ok: true, models: await providerStatus() }); }
      if (route === "POST /integrations/models/test") {
        const b = await readJson(req);
        if (!b.model) return send(res, 400, { error: "model is required (provider:model)." });
        return send(res, 200, await testModel(String(b.model)));
      }
      if (route === "GET /models") {
        const providers = await providerStatus();
        // Ready to pick right now: every model of every provider that can answer, as "provider:model".
        const choices = providers.filter((p) => p.ready).flatMap((p) => p.models.map((model) => ({ id: `${p.id}:${model}`, provider: p.id, providerName: p.name, model })));
        return send(res, 200, { defaultModel: config.model, providers, choices });
      }
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
      if (route === "GET /voice") {
        /**
         * Warm the site's own words while the person is still deciding to press the button.
         *
         * They are what keeps "AEROMATIC" from being heard as "aromatic", but reading them means reading the
         * site - seconds on a slow host - and the dictation socket only waits 400ms for them before starting
         * without. The widget asks for this endpoint when it opens, so the read happens then and the cache is
         * warm by the time anybody speaks. Fire and forget: nothing here waits for it.
         */
        const ws = sites.get(String(url.searchParams.get("siteId") ?? ""));
        const wp = url.searchParams.get("pageUrl");
        if (ws) void warmVoiceSession(ws, wp && /^https?:\/\//.test(wp) ? wp.slice(0, 300) : undefined).catch(() => {});
        return send(res, 200, {
        ...voiceInfo(),
        realtime: { available: realtimeAvailable(), model: realtimeModel(), voice: realtimeVoice() },
        // Streaming dictation: words while you talk. The widget falls back to uploading a file when it is off.
        stream: { available: realtimeAvailable(), model: dictateModel(), rate: DICTATE_RATE },
        });
      }
      // A short-lived client secret for ONE realtime call. The API key never leaves this machine.
      if (route === "POST /voice/realtime/session") {
        const b = await readJson(req).catch(() => ({} as any));
        const site = typeof b.siteId === "string" ? sites.get(b.siteId) : undefined;
        const voicePage = typeof b.pageUrl === "string" && /^https?:\/\//.test(b.pageUrl) ? b.pageUrl.slice(0, 300) : undefined;
        // The site is read once here, so the first thing the person says does not wait for it - and its own words go
        // to the realtime model, which otherwise hears "AEROMATIC" as "aromatic".
        const siteWords = site ? await warmVoiceSession(site, voicePage) : "";
        try {
          return send(res, 200, await createRealtimeSession({
            botName: typeof b.botName === "string" ? b.botName.slice(0, 60) : undefined,
            siteName: site?.name,
            pageUrl: voicePage,
            siteWords,
          }));
        } catch (e) {
          return send(res, (e as any).status ?? 502, { error: (e as Error).message });
        }
      }
      if (route === "POST /voice/transcribe") {
        const buf = await readBody(req, 12_000_000);
        return send(res, 200, await transcribe(buf, String(req.headers["content-type"] ?? ""), "", String(url.searchParams.get("lang") ?? "")));
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

  /**
   * Dictation, streamed: /voice/stream.
   *
   * The widget opens this socket, says which site and page it is on, and then sends raw 16-bit PCM at
   * DICTATE_RATE as it records, with a "commit" whenever its own voice detector says a sentence ended. Words come
   * back as they are heard. The OpenAI key stays here (see dictation.ts).
   *
   * The site is named so the session can be given the site's OWN words - the page map is already read and cached
   * for every voice session, and it is the difference between "AEROMATIC" and "aromatic".
   */
  const wss = new WebSocketServer({ server, path: "/voice/stream" });
  wss.on("connection", async (client, req) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const site = sites.get(String(q.get("siteId") ?? ""));
    const pageUrl = q.get("pageUrl") && /^https?:\/\//.test(q.get("pageUrl")!) ? q.get("pageUrl")!.slice(0, 300) : undefined;
    const say = (o: Record<string, unknown>) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(o)); };

    const d = new Dictation({
      onReady: (model) => say({ type: "ready", model }),
      onSpeech: (speaking) => say({ type: "speech", speaking }),
      onPartial: (text, id) => say({ type: "partial", text, id }),
      onFinal: (text, id) => say({ type: "final", text, id }),
      onError: (message) => say({ type: "error", message }),
    });

    /**
     * The listener goes on NOW, before anything is awaited.
     *
     * Reading the site's words needs the site, which can take a second or be unreachable altogether - and ws
     * drops messages that arrive with no listener attached. Someone who presses the button and speaks straight
     * away would have had that first sentence thrown away here, with no error anywhere: an open socket, an idle
     * session and a person repeating themselves.
     */
    let frames = 0, commits = 0;
    const early: Array<{ bin: boolean; data: Buffer | string }> = [];
    let ready = false;
    const handle = (bin: boolean, data: Buffer | string) => {
      if (bin) { frames++; return d.send(data as Buffer); }
      let m: any;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === "commit") { commits++; d.commit(); }
      /**
       * "Stop" means the microphone is off, not that the last sentence is forfeit.
       *
       * The widget commits whatever it was in the middle of and says stop in the same breath. Tearing the
       * upstream session down here would cancel that transcript on its way back - the one sentence the person
       * most expects to see, because they pressed Stop as they finished saying it. The socket closing (below)
       * ends the session for good either way.
       */
      if (m.type === "stop") setTimeout(() => d.stop(), 1_500).unref?.();
    };
    client.on("message", (data, isBinary) => {
      if (!ready) { if (early.length < 500) early.push({ bin: isBinary, data: isBinary ? (data as Buffer) : String(data) }); return; }
      handle(isBinary, isBinary ? (data as Buffer) : String(data));
    });
    client.on("close", () => {
      log("info", "dictation closed", { site: site?.id, frames, commits });
      d.stop();
    });

    /**
     * The site's own words are worth a SHORT wait and no more.
     *
     * They are what keeps "AEROMATIC" from coming back as "aromatic", and they are usually already cached for
     * this site and page, which costs nothing. But reading them means talking to WordPress, which can hang when
     * the site is slow or archived, and nobody should wait on a web server before their microphone works. So:
     * wait a moment, start either way, and apply them later if they were slow - the first sentence then guesses
     * the brand names, which beats a microphone that takes five seconds to open.
     */
    const words = site ? warmVoiceSession(site, pageUrl).catch(() => "") : Promise.resolve("");
    const inTime = await Promise.race([words, new Promise<"">((r) => setTimeout(() => r(""), 400))]);
    d.start({ siteWords: inTime, language: q.get("lang") ?? undefined });
    ready = true;
    for (const e of early.splice(0)) handle(e.bin, e.data);
    if (!inTime) void words.then((w) => d.addSiteWords(w));
  });

  return server;
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
  // A crash is written to data/backend-errors.log (the window may be closed before anyone reads it). A failed promise
  // nobody waited for (e.g. a browser that could not be cleaned up) is logged but does not stop the backend.
  const crashLog = (kind: string, e: unknown) => {
    const line = `[${new Date().toISOString()}] ${kind}: ${(e as Error)?.stack ?? String(e)}\n`;
    try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.appendFileSync(path.join(config.dataDir, "backend-errors.log"), line); } catch { /* disk full / read-only: console only */ }
    console.error(line);
  };
  process.on("unhandledRejection", (e) => crashLog("unhandled promise rejection (backend keeps running)", e));
  process.on("uncaughtException", (e) => { crashLog("CRASH", e); process.exit(1); });
  process.on("SIGTERM", shutdown);
  server.listen(config.port, config.host, () => {
    console.log(`Livecrafts backend on http://${config.host}:${config.port}  (model: ${config.model})`);
    if (!config.apiToken) console.log("WARNING: LC_API_TOKEN is not set - fine on localhost, set it before exposing this server.");
    if (config.model.startsWith("claudecli:")) {
      void claudeCliStatus(true).then((c) => console.log(c.ready
        ? `Claude CLI ready (${c.version}, ${c.authMethod ?? "signed in"}) - it answers in the background, no API credit needed.`
        : `WARNING: LC_MODEL is ${config.model} but the Claude CLI cannot answer: ${c.error ?? "unknown reason"}
   -> ${c.fix ?? 'Run "claude auth login" on the backend machine.'}`));
    } else if (!process.env.OPENAI_API_KEY && !config.model.includes("/") && !config.model.includes(":")) {
      console.log("WARNING: OPENAI_API_KEY is not set - jobs will fail until it is (or switch the model, e.g. LC_MODEL=claudecli:sonnet).");
    }
  });
}
