import { config } from "./config.js";
import type { Site } from "./types.js";

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
/** A Livecrafts overlay patch for one CSS selector: styles for all screens, tablet (≤1024px), mobile (≤767px), optional text. */
export interface Patch { styles?: Record<string, string>; styles_tablet?: Record<string, string>; styles_mobile?: Record<string, string>; text?: string }

/**
 * Talks to ONE WordPress site through the Livecrafts plugin REST API (and core REST for media / page lists),
 * authenticated with an Application Password. Reads are retried; writes are never retried automatically.
 */
export class Bridge {
  constructor(public readonly site: Site) {}

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

  async request<T = any>(method: "GET" | "POST" | "DELETE", route: string, opts: { query?: Query; json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
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
            ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.headers ?? {}),
          },
          body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body ? new Uint8Array(opts.body) : undefined,
          signal: AbortSignal.timeout(config.bridgeTimeoutMs),
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
        const need = /livecrafts\/v1\/(patches|save|revert)/.test(route) ? ["0.9", "manual style editing"]
          : /livecrafts\/v1\/assistant/.test(route) ? ["0.8", "the assistant settings"]
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
  map(args: { url?: string; post?: number }) { return this.request("GET", "livecrafts/v1/map", { query: { url: args.url, post: args.post } }); }
  readTarget(target: string) { return this.request("GET", "livecrafts/v1/debug/target", { query: { targetId: target } }); }
  setTarget(target: string, value: string) { return this.request("POST", "livecrafts/v1/target", { json: { targetId: target, value } }); }
  locate(post: number, texts: string[]) { return this.request("POST", "livecrafts/v1/debug/locate", { json: { post, texts } }); }
  undo(pageKey: string) { return this.request("POST", "livecrafts/v1/undo", { json: { pageKey } }); }
  listPages() { return this.request<any[]>("GET", "wp/v2/pages", { query: { per_page: 100, _fields: "id,link,title,status,modified" } }); }

  // ---- core content (pages / posts) through the standard WordPress REST API
  createPost(type: PostType, data: Record<string, unknown>) { return this.request("POST", `wp/v2/${type}`, { json: data }); }
  updatePost(type: PostType, id: number, data: Record<string, unknown>) { return this.request("POST", `wp/v2/${type}/${id}`, { json: data }); }
  /** Raw (editable) content, not the rendered HTML. */
  getPost(type: PostType, id: number) { return this.request("GET", `wp/v2/${type}/${id}`, { query: { context: "edit" } }); }
  /** force=false moves it to the Trash (recoverable). */
  trashPost(type: PostType, id: number) { return this.request("DELETE", `wp/v2/${type}/${id}`); }
  listPosts(type: PostType, search?: string) {
    return this.request<any[]>("GET", `wp/v2/${type}`, { query: { per_page: 50, search, status: "publish,draft,private", context: "edit", _fields: "id,link,title,status,modified,template" } });
  }

  // ---- navigation menus (classic themes: Appearance > Menus)
  menuLocations() { return this.request<Record<string, any>>("GET", "wp/v2/menu-locations"); }
  menus() { return this.request<any[]>("GET", "wp/v2/menus", { query: { per_page: 100, context: "edit" } }); }
  menuItems(menuId: number) { return this.request<any[]>("GET", "wp/v2/menu-items", { query: { menus: menuId, per_page: 100, context: "edit" } }); }
  createMenu(name: string, locations: string[]) { return this.request("POST", "wp/v2/menus", { json: { name, locations } }); }
  deleteMenu(id: number) { return this.request("DELETE", `wp/v2/menus/${id}`, { query: { force: "true" } }); }
  createMenuItem(data: Record<string, unknown>) { return this.request("POST", "wp/v2/menu-items", { json: { status: "publish", ...data } }); }
  deleteMenuItem(id: number) { return this.request("DELETE", `wp/v2/menu-items/${id}`, { query: { force: "true" } }); }

  // ---- style/text overlay patches (Livecrafts plugin 0.9+): safe CSS on top of any theme / Elementor / ACF, revertable
  getPatches(where: { url?: string; pageKey?: string }) {
    return this.request<{ ok: boolean; pageKey: string; page: Record<string, Patch>; site: Record<string, Patch> }>("GET", "livecrafts/v1/patches", { query: { url: where.url, pageKey: where.pageKey } });
  }
  /** Replace the whole patch of one selector (send the merged result). An empty patch removes it. */
  savePatch(key: string, selector: string, patch: Patch) {
    const scope = key === "site" ? { scope: "site" } : { scope: "page", pageKey: key };
    const empty = !patch.text && !["styles", "styles_tablet", "styles_mobile"].some((k) => Object.keys((patch as any)[k] ?? {}).length);
    if (empty) return this.request("POST", "livecrafts/v1/revert", { json: { ...scope, selector } });
    return this.request("POST", "livecrafts/v1/save", { json: { ...scope, selector, ...patch } });
  }

  // ---- active theme files (Livecrafts plugin 0.7+)
  themeFiles() { return this.request("GET", "livecrafts/v1/theme-files"); }
  readThemeFile(path: string) { return this.request<{ ok: boolean; path: string; content: string; sha1: string; bytes: number }>("GET", "livecrafts/v1/theme-file", { query: { path } }); }
  writeThemeFile(path: string, content: string, expectedSha1: string) { return this.request("POST", "livecrafts/v1/theme-file", { json: { path, content, expectedSha1 } }); }
  deleteThemeFile(path: string, expectedSha1: string) { return this.request("DELETE", "livecrafts/v1/theme-file", { query: { path, expectedSha1 } }); }

  async uploadMedia(buf: Buffer, filename: string, mime: string, title?: string, alt?: string) {
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
