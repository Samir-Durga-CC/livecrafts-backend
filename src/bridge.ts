import { config } from "./config.js";
import type { Site } from "./types.js";

export interface FileWriteOpts { ref?: string; rollbackOf?: number }

export class BridgeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain-text view of an HTML page (good enough to check "is this sentence on the page"). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8211;|&ndash;/g, "-")
    .replace(/\s+/g, " ").trim();
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

type Query = Record<string, string | number | undefined>;
export type PostType = "pages" | "posts";

/**
 * Talks to ONE WordPress site through the Livecrafts plugin REST API (and core REST for media / page lists),
 * authenticated with an Application Password. Reads are retried; writes are never retried automatically.
 */
export class Bridge {
  /** actorToken = the chat person's signed widget token: the plugin credits every change to them. */
  constructor(public readonly site: Site, private readonly actorToken?: string) {}

  get homeUrl() { return this.site.url + "/"; }

  private authHeader() {
    return "Basic " + Buffer.from(`${this.site.username}:${this.site.appPassword}`).toString("base64");
  }

  private buildUrl(route: string, query: Query | undefined, plain: boolean) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") q.set(k, String(v));
    if (!plain) return `${this.site.url}/wp-json/${route}${q.toString() ? "?" + q.toString() : ""}`;
    q.set("rest_route", "/" + route); // works even without pretty permalinks
    return `${this.site.url}/?${q.toString()}`;
  }

  async request<T = any>(method: "GET" | "POST" | "DELETE", route: string, opts: { query?: Query; json?: unknown; body?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const attempts = method === "GET" ? 3 : 1; // never auto-retry a write
    let plain = false;
    for (let i = 0; i < attempts; i++) {
      let res: Response;
      try {
        res = await fetch(this.buildUrl(route, opts.query, plain), {
          method,
          headers: {
            Authorization: this.authHeader(),
            Accept: "application/json",
            ...(this.actorToken && route.startsWith("livecrafts/") ? { "X-Livecrafts-Actor": this.actorToken } : {}),
            ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.headers ?? {}),
          },
          body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body ? new Uint8Array(opts.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? config.bridgeTimeoutMs),
        });
      } catch (e) {
        if (i < attempts - 1) { await sleep(400 * 2 ** i); continue; }
        throw new BridgeError(0, "network", `Cannot reach ${this.site.url}: ${(e as Error).message}`);
      }

      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = undefined; }

      if (res.ok && data !== undefined) return data as T;
      if (res.ok) throw new BridgeError(res.status, "not_json", `${this.site.url} returned a non-JSON answer (a security or cache plugin may be rewriting REST responses).`);

      if (res.status === 404 && data === undefined && !plain) { plain = true; i--; continue; } // pretty permalinks off -> retry once with ?rest_route=
      if ((res.status >= 500 || res.status === 429) && i < attempts - 1) { await sleep(400 * 2 ** i); continue; }

      let code: string = data?.code ?? "http_" + res.status;
      let msg: string = data?.message ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) msg += " - the Application Password was rejected or the user cannot edit pages (check username/password, that the site uses HTTPS, and that no security plugin disables Application Passwords).";
      if (res.status === 404 && code === "rest_no_route") {
        const need = /livecrafts\/v1\/(status|changes|post|pages|notes|resolve|preview-token|connect|releases)/.test(route) ? ["0.10", "drafts, history and notes"]
          : /livecrafts\/v1\/assistant/.test(route) ? ["0.8", "the assistant settings"]
          : /livecrafts\/v1\/plugins/.test(route) ? ["0.19", "plugin updates and rollback"]
          : /livecrafts\/v1\/theme-file/.test(route) ? ["0.7", "theme file editing"]
          : /^livecrafts\//.test(route) ? ["0.6", "Livecrafts"] : null;
        msg = need ? `This needs the Livecrafts plugin ${need[0]} or newer for ${need[1]}. Install the latest livecrafts.zip on the site (Plugins → Add New → Upload, replace current).` : msg;
        code = "plugin_outdated";
      }
      throw new BridgeError(res.status, code, msg);
    }
    throw new BridgeError(0, "unreachable", "request failed");
  }

  ping() { return this.request("GET", "livecrafts/v1/ping"); }

  // ---- plugin updates (Livecrafts plugin 0.19+): backup, update, health check, rollback. These go live at once.
  plugins(refresh = false) { return this.request<PluginList>("GET", "livecrafts/v1/plugins", { query: { refresh: refresh ? 1 : undefined }, timeoutMs: 90_000 }); }
  pluginHistory() { return this.request<{ history: PluginHistoryEntry[] }>("GET", "livecrafts/v1/plugins/history"); }
  pluginVersions(plugin: string) { return this.request<{ versions: string[]; note?: string }>("GET", "livecrafts/v1/plugins/versions", { query: { plugin }, timeoutMs: 60_000 }); }
  updatePlugin(plugin: string) { return this.request<PluginActionResult>("POST", "livecrafts/v1/plugins/update", { json: { plugin }, timeoutMs: 300_000 }); }
  /** Plugin 0.19.1+: one step of an update (prepare -> install). An older plugin ignores "step" and does it all in one go. */
  updatePluginStep(plugin: string, step: "prepare" | "install", job?: string) {
    return this.request<any>("POST", "livecrafts/v1/plugins/update", { json: { plugin, step, job }, timeoutMs: 300_000 });
  }
  /** Plugin 0.19.1+: repair an update whose install request was cut off (recover.php runs WordPress without plugins). */
  async recoverPlugin(url: string, job: string, key: string): Promise<PluginActionResult> {
    const site = new URL(this.site.url), u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== site.hostname.replace(/^www\./, "")) throw new BridgeError(400, "bad_recover_url", "The repair address is not on this site.");
    const res = await fetch(u, { method: "POST", body: new URLSearchParams({ job, key }), signal: AbortSignal.timeout(300_000) });
    const text = await res.text();
    let data: any; try { data = JSON.parse(text); } catch { throw new BridgeError(res.status, "not_json", "The repair file did not answer (a security plugin may block it)."); }
    if (!res.ok && !data?.message) throw new BridgeError(res.status, data?.gone ? "gone" : "recover_failed", data?.error ?? `HTTP ${res.status}`);
    return data as PluginActionResult;
  }
  rollbackPlugin(plugin: string, to: { backup?: string; version?: string } = {}) {
    return this.request<PluginActionResult>("POST", "livecrafts/v1/plugins/rollback", { json: { plugin, ...to }, timeoutMs: 300_000 });
  }
  /** Every editable value of a page (ACF, Elementor) + the Elementor outline. view "draft" (default) = what editors see. */
  map(args: { url?: string; post?: number; view?: "draft" | "live" }) { return this.request("GET", "livecrafts/v1/map", { query: { url: args.url, post: args.post, view: args.view } }); }
  readTarget(target: string) { return this.request("GET", "livecrafts/v1/debug/target", { query: { targetId: target } }); }
  locate(post: number, texts: string[]) { return this.request("POST", "livecrafts/v1/debug/locate", { json: { post, texts } }); }

  // ---- drafts, history, releases (Livecrafts plugin 0.10+). Every change is a draft until a person deploys.
  status() { return this.request<any>("GET", "livecrafts/v1/status"); }
  changes(q: { status?: string; post?: number; css?: boolean; source?: string; limit?: number; before?: number; release?: number } = {}) {
    return this.request<{ ok: boolean; changes: any[] }>("GET", "livecrafts/v1/changes", { query: { ...q, css: q.css ? 1 : undefined } });
  }
  change(id: number) { return this.request<{ ok: boolean; change: any }>("GET", `livecrafts/v1/changes/${id}`); }
  /** One draft change. The plugin validates it, stores it, rebuilds the preview and reads it back. */
  makeChange(c: { kind: string; post?: number; target: string; value: unknown; label?: string; ref?: string; source?: "assistant" | "widget" }) {
    return this.request<any>("POST", "livecrafts/v1/changes", { json: { source: "assistant", ...c } });
  }
  revert(id: number, ref?: string) { return this.request<any>("POST", `livecrafts/v1/changes/${id}/revert`, { json: { ref, source: "assistant" } }); }
  /** Blog posts can also carry featured_media, categories / tags (names or ids) and meta_description (plugin 0.15+). */
  createPage(p: { title: string; content?: string; type?: "page" | "post"; slug?: string; parent?: number; template?: string; excerpt?: string; ref?: string;
    featured_media?: number; categories?: (string | number)[]; tags?: (string | number)[]; meta_description?: string; create_terms?: string[] }) {
    return this.request<any>("POST", "livecrafts/v1/pages", { json: { source: "assistant", ...p } });
  }
  /** Categories / tags of a new post that was not deployed yet (plugin 0.15+). create_terms = new names the person agreed to. */
  postTerms(p: { post: number; categories?: string[]; tags?: string[]; create_terms?: string[] }) {
    return this.request<any>("POST", "livecrafts/v1/post-terms", { json: { source: "assistant", ...p } });
  }
  /** Title / content / excerpt / status of a page as editors see it (draft) or as visitors do (live). */
  post(id: number, view: "draft" | "live" = "draft") { return this.request<any>("GET", "livecrafts/v1/post", { query: { id, view } }); }
  releases(limit = 20) { return this.request<{ ok: boolean; releases: any[] }>("GET", "livecrafts/v1/releases", { query: { limit } }); }
  notes(post?: number) { return this.request<{ ok: boolean; site: any; page: any }>("GET", "livecrafts/v1/notes", { query: { post } }); }
  setNotes(post: number | undefined, text: string) { return this.request<any>("POST", "livecrafts/v1/notes", { json: { post: post ?? 0, text } }); }
  resolve(body: Record<string, unknown>) { return this.request<any>("POST", "livecrafts/v1/resolve", { json: body }); }
  /** A 10-minute, view-only token: <page>?lc_preview=<token> shows the page with its drafts. */
  previewToken() { return this.request<{ ok: boolean; token: string; param: string }>("POST", "livecrafts/v1/preview-token", { json: {} }); }
  /** The site secret its widget tokens are signed with (needs an administrator's Application Password). */
  connect(rotate = false) { return this.request<{ ok: boolean; secret: string; site: string; version: string }>("POST", "livecrafts/v1/connect", { json: { rotate } }); }
  /** Theme, builders, Elementor widgets / colours, ACF layouts, forms (Livecrafts plugin 0.12+). */
  siteProfile() { return this.request<any>("GET", "livecrafts/v1/site-profile"); }
  /** What the site already has that matches the terms (Elementor templates / sections / widgets, patterns, ACF layouts). */
  components(terms: string[]) { return this.request<any>("GET", "livecrafts/v1/components", { query: { terms: terms.join(",") } }); }
  /** The template library: every template with its attributes, and where each one is used (Livecrafts plugin 0.14+). */
  templates() { return this.request<any>("GET", "livecrafts/v1/templates"); }
  /** One template rendered with sample content, for the component gallery: { html, css[] }. */
  renderTemplate(id: string, variant?: string) {
    const q = new URLSearchParams({ id, ...(variant ? { variant } : {}) });
    return this.request<any>("GET", `livecrafts/v1/templates/render?${q}`);
  }
  componentSource(id: string) { return this.request<any>("GET", "livecrafts/v1/components/source", { query: { id } }); }
  /** One Media Library image (url + alt) from the core REST API. */
  mediaInfo(id: number) { return this.request<any>("GET", `wp/v2/media/${id}`, { query: { _fields: "id,source_url,alt_text,mime_type" } }); }
  assistantSettings() { return this.request<any>("GET", "livecrafts/v1/assistant"); }

  // ---- reading through the standard WordPress REST API
  listPages() { return this.request<any[]>("GET", "wp/v2/pages", { query: { per_page: 100, _fields: "id,link,title,status,modified" } }); }
  listPosts(type: PostType, search?: string) {
    return this.request<any[]>("GET", `wp/v2/${type}`, { query: { per_page: 50, search, status: "publish,draft,private", context: "edit", _fields: "id,link,title,status,modified,template" } });
  }
  menuLocations() { return this.request<Record<string, any>>("GET", "wp/v2/menu-locations"); }
  menus() { return this.request<any[]>("GET", "wp/v2/menus", { query: { per_page: 100, context: "edit" } }); }
  menuItems(menuId: number) { return this.request<any[]>("GET", "wp/v2/menu-items", { query: { menus: menuId, per_page: 100, context: "edit" } }); }
  /** Blog categories or tags, most used first. */
  terms(taxonomy: "categories" | "tags", search?: string) {
    return this.request<any[]>("GET", `wp/v2/${taxonomy}`, { query: { per_page: 100, search, orderby: "count", order: "desc", hide_empty: "false", _fields: "id,name,slug,count,parent" } });
  }
  /** Images in the Media Library, newest first. */
  mediaList(search?: string, page = 1) {
    return this.request<any[]>("GET", "wp/v2/media", { query: { media_type: "image", per_page: 24, page, search, _fields: "id,source_url,alt_text,title,media_details,date" } });
  }

  // ---- active theme files (Livecrafts plugin 0.7+)
  themeFiles() { return this.request("GET", "livecrafts/v1/theme-files"); }
  readThemeFile(path: string) { return this.request<{ ok: boolean; path: string; content: string; sha1: string; bytes: number }>("GET", "livecrafts/v1/theme-file", { query: { path } }); }
  /** The plugin records every write in the site's change ledger (the answer has `change`); rollbackOf = undo my own change at once, leaving no trace. */
  writeThemeFile(path: string, content: string, expectedSha1: string, o: FileWriteOpts = {}) { return this.request<{ ok: boolean; change?: any }>("POST", "livecrafts/v1/theme-file", { json: { path, content, expectedSha1, source: "assistant", ref: o.ref, rollback_of: o.rollbackOf } }); }
  deleteThemeFile(path: string, expectedSha1: string, o: FileWriteOpts = {}) { return this.request<{ ok: boolean; change?: any }>("DELETE", "livecrafts/v1/theme-file", { query: { path, expectedSha1, source: "assistant", ref: o.ref, rollback_of: o.rollbackOf } }); }

  async uploadMedia(buf: Buffer, filename: string, mime: string, title?: string, alt?: string) {
    // Images are stored as WebP (smaller, faster pages); the original is uploaded when conversion is not possible.
    const webp = await import("./browser.js").then((m) => m.toWebp(buf, mime)).catch(() => null);
    if (webp) { buf = webp; mime = "image/webp"; filename = filename.replace(/.[A-Za-z0-9]+$/, "") + ".webp"; }
    const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
    const media = await this.request("POST", "wp/v2/media", { body: buf, headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${safe}"` } });
    if (title || alt) await this.request("POST", `wp/v2/media/${media.id}`, { json: { ...(title ? { title } : {}), ...(alt ? { alt_text: alt } : {}) } }).catch(() => {});
    return { id: media.id as number, url: media.source_url as string, mime: media.mime_type as string, title: title ?? media?.title?.rendered, alt };
  }

  /** Only URLs on this site may be fetched (guards against the model being tricked into probing other hosts). */
  assertSameOrigin(url: string) {
    const u = new URL(url, this.homeUrl), s = new URL(this.homeUrl);
    if (u.origin !== s.origin) throw new BridgeError(400, "bad_url", `Only pages on ${s.origin} can be checked.`);
    return u;
  }

  /** Fetch the PUBLIC page the way a visitor gets it (no login, cache-busted) and check the text. */
  async verifyPage(url: string, expectPresent: string[], expectAbsent: string[]) {
    const u = this.assertSameOrigin(url);
    u.searchParams.set("lcv", String(Date.now()));
    const res = await fetch(u, { signal: AbortSignal.timeout(config.bridgeTimeoutMs), redirect: "follow" });
    const html = await res.text();
    const text = norm(htmlToText(html));
    const present = expectPresent.map((t) => ({ text: t, found: text.includes(norm(t)) }));
    const absent = expectAbsent.map((t) => ({ text: t, stillThere: text.includes(norm(t)) }));
    return {
      status: res.status, asVisitor: true,
      allPresentFound: present.every((p) => p.found), noneOfAbsentRemain: absent.every((a) => !a.stillThere),
      present, absent,
      note: "Checked the public HTML as a logged-out visitor. If a text is missing, it may be cached, built by JavaScript, or the edit did not apply.",
    };
  }
}

export interface PluginBackup { id: string; version: string; at: string; size: number }
export interface PluginInfo {
  plugin: string; slug: string; name: string; version: string; author: string; active: boolean; self: boolean; wporg: boolean; dbHeavy: boolean;
  update: { version: string; requires: string; requiresPhp: string; tested: string; compatible: boolean; package: boolean } | null;
  backups: PluginBackup[];
}
export interface PluginList { plugins: PluginInfo[]; wp: string; php: string; canModify: boolean; blocked: string; checkedAt: string | null }
export interface PluginHistoryEntry { at: string; by: string; plugin: string; name: string; action: "update" | "auto_rollback" | "rollback"; from: string; to: string; result: string; note?: string }
export interface PluginActionResult {
  ok: boolean; plugin: string; name: string; from: string; to: string; message: string; rolledBack?: boolean; verified?: boolean; dbHeavy?: boolean; backup?: string | null;
  health?: { ok: boolean | null; checks: Array<{ name: string; ok: boolean | null; detail: string }> };
}
