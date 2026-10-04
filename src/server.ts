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
import { secrets } from "./secrets.js";
import { closeBrowser, screenshotPath } from "./browser.js";

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
  const publicJob = (j: Job) => ({ id: j.id, siteId: j.siteId, prompt: j.prompt, status: j.status, pending: j.pending, result: j.result, error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt, lastEventSeq: j.events.at(-1)?.seq ?? 0, changes: j.changes ?? [] });

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
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = `${req.method} ${url.pathname}`;
    try {
      const isApi = /^\/(health|sites|jobs|files|integrations|screens)(\/|$)/.test(url.pathname);
      if (!isApi && req.method === "GET" && serveStatic(url.pathname, res)) return; // UI files are public; the API below is protected
      if (config.apiToken && route !== "GET /health" && req.headers.authorization !== `Bearer ${config.apiToken}`) return send(res, 401, { error: "Unauthorized" });

      if (route === "GET /health") return send(res, 200, { ok: true, model: config.model, authRequired: !!config.apiToken });

      // ---- sites
      if (route === "GET /sites") return send(res, 200, sites.list().map(publicSite));
      if (route === "POST /sites") {
        const b = await readJson(req);
        const siteUrl = String(b.url ?? "").trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(siteUrl) || !b.username || !b.appPassword) return send(res, 400, { error: "url (http/https), username and appPassword are required." });
        const site: Site = { id: newId("site"), name: String(b.name || new URL(siteUrl).host), url: siteUrl, username: String(b.username), appPassword: String(b.appPassword), createdAt: new Date().toISOString() };
        let info: any = null;
        try { info = await new Bridge(site).ping(); } catch (e) { return send(res, 400, { error: `Could not connect: ${(e as Error).message}` }); } // validate credentials BEFORE saving
        sites.put(site);
        const hostingNote = await linkSite(site); // automatic, best effort
        return send(res, 201, { ...publicSite(site), plugin: info, hostingNote });
      }
      let m = url.pathname.match(/^\/sites\/([\w-]+)$/);
      if (m && req.method === "DELETE") { sites.delete(m[1]); return send(res, 200, { ok: true }); }
      m = url.pathname.match(/^\/sites\/([\w-]+)\/link-hosting$/);
      if (m && req.method === "POST") {
        const s = sites.get(m[1]);
        if (!s) return send(res, 404, { error: "Unknown site" });
        const note = await linkSite(s);
        return note ? send(res, 400, { error: note }) : send(res, 200, publicSite(sites.get(m[1])!));
      }

      // ---- integrations: Hostinger (token + health check). The token is never sent back to the browser.
      if (route === "GET /integrations") return send(res, 200, { hostinger: lastHealth ?? (await checkHostinger()) });
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
      if (route === "GET /jobs") return send(res, 200, runner.list().map(publicJob));
      if (route === "POST /jobs") {
        const b = await readJson(req);
        if (!b.siteId || !b.prompt) return send(res, 400, { error: "siteId and prompt are required." });
        return send(res, 201, publicJob(runner.create(String(b.siteId), String(b.prompt), contextFor(b), fileIdsOf(b))));
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/messages$/);
      if (m && req.method === "POST") { // follow-up message in the same conversation
        const b = await readJson(req);
        if (!b.prompt) return send(res, 400, { error: "prompt is required." });
        return send(res, 200, publicJob(runner.continue(m[1], String(b.prompt), contextFor(b), fileIdsOf(b))));
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)$/);
      if (m && req.method === "GET") { const j = runner.get(m[1]); return j ? send(res, 200, { ...publicJob(j), events: j.events }) : send(res, 404, { error: "Unknown job" }); }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/approvals$/);
      if (m && req.method === "POST") {
        const b = await readJson(req);
        if (!b.approvalId || typeof b.approved !== "boolean") return send(res, 400, { error: "approvalId and approved (true/false) are required." });
        return send(res, 200, publicJob(runner.respond(m[1], String(b.approvalId), b.approved, b.reason ? String(b.reason) : undefined)));
      }
      m = url.pathname.match(/^\/jobs\/([\w-]+)\/changes\/(chg_[a-f0-9]+)\/revert$/);
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
