import crypto from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import type { Bridge } from "./bridge.js";
import { BridgeError } from "./bridge.js";
import type { RemoteFiles } from "./hostinger.js";

/**
 * Safe file editing on a WordPress site.
 *
 * Rules (enforced here AND by the plugin, not just asked of the model):
 *  - Paths are relative to the WordPress folder, no "..", no absolute paths.
 *  - Only files of a THEME: wp-content/themes/<theme>/... Never wp-config.php, plugins, core.
 *  - Static files (css/js/json/txt/svg) can always be edited. Template files (php/html) only through the Livecrafts
 *    plugin 0.7+, which reads exact bytes, refuses PHP with a syntax error and only touches the active theme.
 *  - One exact, unique snippet is replaced (find -> replace). 0 or 2+ matches = refused, nothing written.
 *  - A backup is stored before writing; the change is read back to prove it is live; the page is loaded afterwards and
 *    if it broke (server error, PHP error, page cut off) the original file is put back automatically.
 */

const THEME_FILE = /^wp-content\/themes\/[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/i;
export const STATIC_EDITABLE = /\.(css|js|json|txt|svg)$/i;
export const TEMPLATE_EDITABLE = /\.(php|html)$/i;
/** Kept for callers/tests: static theme files that any connection can edit. */
export const EDITABLE = /^wp-content\/themes\/[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(css|js|json|txt|svg)$/i;
export const READABLE = /^wp-content\/(themes|plugins)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/i;
const STATIC_EXT = /\.(css|js|json|txt|svg|html?)$/i;

export const sha1 = (s: string) => crypto.createHash("sha1").update(s, "utf8").digest("hex");

export interface Backup {
  id: string; siteId: string; path: string; before: string; after: string; createdAt: string; restoredAt?: string;
  created?: boolean; // the edit CREATED this file (undo = delete it)
}

export function cleanPath(p: string): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").split(/[?#]/)[0];
  if (!s || s.includes("..") || s.includes("\0") || /^[a-z]+:/i.test(s)) throw new Error(`Invalid path "${p}". Use a path inside the WordPress folder, e.g. wp-content/themes/my-theme/style.css`);
  return s;
}

/** Theme files through the Livecrafts plugin (exact bytes, PHP syntax check, active theme only). */
export function pluginFiles(bridge: Bridge): RemoteFiles {
  let supported: boolean | null = null;
  const unsupported = (e: unknown) => e instanceof BridgeError && (e.code === "rest_no_route" || e.code === "plugin_outdated" || e.status === 404 && /no route/i.test(e.message));
  return {
    async list(dir) {
      const r: any = await bridge.themeFiles();
      const prefix = dir.replace(/\/+$/, "");
      return (r.files ?? []).filter((f: any) => !prefix || f.path.startsWith(prefix + "/") || prefix === "wp-content/themes" || prefix === "wp-content")
        .map((f: any) => ({ name: f.path.split("/").pop(), path: f.path, type: "file", bytes: f.bytes }));
    },
    async readViaApi(rel) { return (await bridge.readThemeFile(rel)).content; },
    async upload(rel, content) { const cur = await bridge.readThemeFile(rel).catch(() => null); await bridge.writeThemeFile(rel, content, cur ? cur.sha1 : "new"); },
    async readExact(rel) {
      if (supported === false) return null;
      try { const r = await bridge.readThemeFile(rel); supported = true; return { content: r.content, sha1: r.sha1 }; }
      catch (e) {
        if (unsupported(e)) { supported = false; return null; }
        if (e instanceof BridgeError && e.code === "livecrafts_not_found") throw new Error(`File not found: ${rel}`);
        throw e;
      }
    },
    async write(rel, content, expectedSha1) { await bridge.writeThemeFile(rel, content, expectedSha1); },
    async remove(rel, s) { await bridge.deleteThemeFile(rel, s); },
  };
}

/**
 * Use the plugin when it supports theme files (exact + PHP), otherwise the hosting account (static files only).
 * The choice is made per call, so updating the plugin starts working without restarting anything.
 */
export function combineRemotes(primary: RemoteFiles, fallback: RemoteFiles | null): RemoteFiles {
  // The plugin answers (file found, or "not found" from a plugin that knows the route) -> plugin; an old plugin -> hosting.
  const pick = async (rel: string) => (await primary.readExact!(rel).then((r) => r !== null, (e) => { if (/File not found/.test(String(e?.message))) return true; throw e; })) ? primary : fallback;
  return {
    list: async (dir) => { try { return await primary.list(dir); } catch (e) { if (fallback) return fallback.list(dir); throw e; } },
    readViaApi: async (rel, a, b) => { try { return await primary.readViaApi(rel, a, b); } catch (e) { if (fallback) return fallback.readViaApi(rel, a, b); throw e; } },
    upload: async (rel, c) => { const r = await pick(rel).catch(() => fallback); if (!r) throw new Error("No way to write files: update the Livecrafts plugin to 0.7+ or connect Hostinger."); return r.upload(rel, c); },
    readExact: (rel) => primary.readExact!(rel),
    write: (rel, c, s) => primary.write!(rel, c, s),
    remove: (rel, s) => primary.remove!(rel, s),
  };
}

export interface SiteFileDeps {
  siteId: string;
  siteUrl: string;               // https://example.com/sub (no trailing slash)
  remote: RemoteFiles;
  fetchImpl?: typeof fetch;
  backups?: JsonStore<Backup>;
}

interface Health { ok: boolean; reason?: string; complete?: boolean }

export class SiteFiles {
  private fetch: typeof fetch;
  private backups: JsonStore<Backup>;
  constructor(private d: SiteFileDeps) {
    this.fetch = d.fetchImpl ?? fetch;
    this.backups = d.backups ?? new JsonStore<Backup>(path.join(config.dataDir, "backups"));
  }

  publicUrl(rel: string) { return `${this.d.siteUrl}/${rel}`; }

  /** Exact current bytes of a static file, as served to visitors (cache-busted). */
  async readPublic(rel: string): Promise<string> {
    const res = await this.fetch(`${this.publicUrl(rel)}?lcv=${Date.now()}`, { signal: AbortSignal.timeout(config.bridgeTimeoutMs), headers: { "Cache-Control": "no-cache" } });
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200) throw new Error(`Could not read ${rel} (HTTP ${res.status}). Check the path - it is relative to the WordPress folder.`);
    if (/text\/html/i.test(type) && !/\.html?$/i.test(rel)) throw new Error(`${rel} returned an HTML page instead of the file (probably a 404 page). Check the path.`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error(`${rel} is too large to edit safely here.`);
    return text;
  }

  /** Exact content: from the plugin if it can, else (static files) from the public URL. */
  private async current(rel: string): Promise<{ content: string; sha1: string | null; exact: boolean }> {
    const r = this.d.remote.readExact ? await this.d.remote.readExact(rel) : null;
    if (r) return { content: r.content, sha1: r.sha1, exact: true };
    if (!STATIC_EDITABLE.test(rel)) throw new Error(`Editing ${rel} needs the Livecrafts plugin 0.7 or newer on the site (it reads and checks template files safely). Ask the person to update the plugin.`);
    return { content: await this.readPublic(rel), sha1: null, exact: false };
  }

  private async put(rel: string, content: string, expectedSha1: string | null) {
    if (expectedSha1 !== null && this.d.remote.write) return this.d.remote.write(rel, content, expectedSha1);
    return this.d.remote.upload(rel, content);
  }

  async list(dir: string) {
    const rel = dir ? cleanPath(dir) : "";
    if (rel && !/^wp-content(\/|$)/.test(rel)) throw new Error("Only folders inside wp-content can be listed.");
    return { ok: true, directory: rel || ".", items: await this.d.remote.list(rel) };
  }

  async read(rel0: string, fromLine?: number, maxLines?: number) {
    const rel = cleanPath(rel0);
    if (!READABLE.test(rel)) throw new Error("Only files inside wp-content/themes or wp-content/plugins can be read.");
    const exact = THEME_FILE.test(rel) && this.d.remote.readExact ? await this.d.remote.readExact(rel).catch((e) => { if (/File not found/.test(String(e?.message))) throw e; return null; }) : null;
    const text = exact ? exact.content : STATIC_EXT.test(rel) ? await this.readPublic(rel) : null;
    if (text === null) {
      return { ok: true, path: rel, editable: false, note: "Read through the hosting API (may be partial). Update the Livecrafts plugin to 0.7+ to edit template files.", content: (await this.d.remote.readViaApi(rel, fromLine, maxLines)).slice(0, 60_000) };
    }
    const lines = text.split("\n");
    const from = Math.max(1, fromLine ?? 1), to = Math.min(lines.length, from - 1 + (maxLines ?? 600));
    const editable = THEME_FILE.test(rel) && (STATIC_EDITABLE.test(rel) || (!!exact && TEMPLATE_EDITABLE.test(rel)));
    return { ok: true, path: rel, totalLines: lines.length, fromLine: from, toLine: to, editable, content: lines.slice(from - 1, to).join("\n") };
  }

  private checkEditable(rel: string) {
    if (!THEME_FILE.test(rel) || !(STATIC_EDITABLE.test(rel) || TEMPLATE_EDITABLE.test(rel))) {
      throw new Error(`Only theme files can be edited (wp-content/themes/<theme>/…php|html|css|js|json|txt|svg). "${rel}" is not allowed.`);
    }
    if (/(^|\/)functions\.php$/i.test(rel)) throw new Error("functions.php is not edited from the chat (one mistake there takes the whole site down). Put new code in a template part instead, or ask a developer.");
  }

  /** Replace exactly one occurrence of `find` with `replace`, verify it is live, keep a backup, roll back if the page breaks. */
  async edit(rel0: string, find: string, replace: string, healthUrls: string | string[]) {
    const rel = cleanPath(rel0);
    this.checkEditable(rel);
    if (!find) throw new Error("`find` must be the exact existing text to replace.");
    if (find === replace) throw new Error("`replace` is identical to `find` - nothing to change.");

    const cur = await this.current(rel);
    const before = cur.content;
    const count = before.split(find).length - 1;
    if (count === 0) throw new Error(`The text to replace was not found in ${rel}. Read the file again and copy the exact snippet (spaces and line breaks matter).`);
    if (count > 1) throw new Error(`The text to replace appears ${count} times in ${rel}. Include more surrounding lines so it is unique.`);
    const at = before.indexOf(find);
    const after = before.slice(0, at) + replace + before.slice(at + find.length);
    return this.apply(rel, before, after, cur.sha1, cur.exact, false, healthUrls);
  }

  /** Create a NEW theme file (e.g. a template part for a new section). Refused if it already exists. */
  async create(rel0: string, content: string, healthUrls: string | string[]) {
    const rel = cleanPath(rel0);
    this.checkEditable(rel);
    if (!this.d.remote.readExact || !this.d.remote.write) throw new Error("Creating files needs the Livecrafts plugin 0.7 or newer.");
    const existing = await this.d.remote.readExact(rel).catch((e) => { if (/File not found/.test(String(e?.message))) return null; throw e; });
    if (existing) throw new Error(`${rel} already exists - use edit_file to change it.`);
    return this.apply(rel, "", content, "new", true, true, healthUrls);
  }

  private async apply(rel: string, before: string, after: string, expectedSha1: string | null, exact: boolean, created: boolean, healthUrls: string | string[]) {
    const urls = Array.isArray(healthUrls) ? healthUrls : [healthUrls];
    const baseline = await Promise.all(urls.map((u) => this.pageHealth(u)));
    const backup = this.backups.put({ id: newId("bak"), siteId: this.d.siteId, path: rel, before, after, createdAt: new Date().toISOString(), created });
    await this.put(rel, after, expectedSha1);

    // Prove it is live: read the file back (a CDN or server cache may lag for a moment on public URLs).
    let live = false;
    for (let i = 0; i < 3 && !live; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      try { live = exact ? (await this.d.remote.readExact!(rel))?.content === after : (await this.readPublic(rel)) === after; } catch { /* retry */ }
    }

    // The pages must still load. If one does not, put the old file back immediately.
    const broken = await this.firstBroken(urls, baseline);
    if (broken) {
      if (created && this.d.remote.remove) await this.d.remote.remove(rel, sha1(after)).catch(() => this.put(rel, "", null));
      else await this.put(rel, before, exact ? sha1(after) : null);
      this.backups.put({ ...backup, restoredAt: new Date().toISOString() });
      return { ok: false, error: `The page ${broken.url} broke after the change (${broken.reason}). The original was restored automatically - nothing changed on the site.`, path: rel, backupId: backup.id, rolledBack: true };
    }
    return {
      ok: true, path: rel, backupId: backup.id, verifiedLive: live, created,
      publicUrl: STATIC_EDITABLE.test(rel) ? this.publicUrl(rel) : undefined, linesChanged: after.split("\n").length - (created ? 0 : before.split("\n").length) ,
      note: live ? "The file on the server now contains the change and the page still loads." : "Saved, but the public file still served the old version (server/CDN cache). It should update shortly; verify on the page.",
    };
  }

  async restore(backupId: string, healthUrls: string | string[]) {
    const b = this.backups.get(backupId);
    if (!b || b.siteId !== this.d.siteId) throw new Error("Unknown backup id for this site.");
    const exact = this.d.remote.readExact ? await this.d.remote.readExact(b.path).catch(() => null) : null;
    if (b.created) {
      if (!this.d.remote.remove) throw new Error("Removing a created file needs the Livecrafts plugin 0.7+.");
      if (exact) await this.d.remote.remove(b.path, exact.sha1);
    } else {
      await this.put(b.path, b.before, exact ? exact.sha1 : null);
    }
    let live = false;
    for (let i = 0; i < 3 && !live; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      try {
        if (b.created) live = !(await this.d.remote.readExact!(b.path).catch(() => null));
        else live = exact ? (await this.d.remote.readExact!(b.path))?.content === b.before : (await this.readPublic(b.path)) === b.before;
      } catch { /* retry */ }
    }
    this.backups.put({ ...b, restoredAt: new Date().toISOString() });
    const broken = await this.firstBroken(Array.isArray(healthUrls) ? healthUrls : [healthUrls]);
    return { ok: !broken, path: b.path, verifiedLive: live, removed: !!b.created, ...(broken ? { error: `Restored, but ${broken.url} still does not load (${broken.reason}).` } : {}) };
  }

  getBackup(id: string) { return this.backups.get(id); }

  private async firstBroken(urls: string[], baseline?: Health[]) {
    for (let i = 0; i < urls.length; i++) {
      const h = await this.pageHealth(urls[i]);
      if (!h.ok) return { url: urls[i], reason: h.reason };
      if (baseline?.[i]?.ok && baseline[i].complete && !h.complete) return { url: urls[i], reason: "the page is cut off - the HTML ends early, usually a broken template" };
    }
    return null;
  }

  private async pageHealth(url: string): Promise<Health> {
    try {
      const u = new URL(url); u.searchParams.set("lcv", String(Date.now()));
      const res = await this.fetch(u, { signal: AbortSignal.timeout(config.bridgeTimeoutMs) });
      const body = await res.text();
      if (res.status >= 500) return { ok: false, reason: `HTTP ${res.status}` };
      if (/There has been a critical error|<b>Fatal error<\/b>|Fatal error:|Parse error:/i.test(body)) return { ok: false, reason: "PHP error on the page" };
      return { ok: true, complete: /<\/body>/i.test(body) };
    } catch (e) { return { ok: false, reason: (e as Error).message }; }
  }
}
