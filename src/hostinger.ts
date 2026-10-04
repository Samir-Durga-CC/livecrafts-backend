import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { secrets } from "./secrets.js";
import type { Site } from "./types.js";

/**
 * Hostinger, through Hostinger's own MCP server (@hostinger/mcp, installed as a dependency and run as a child process).
 * That server exposes three generic tools - search / execute / multi-execute - and every API operation is addressed by
 * name through `execute`. We call it directly from code (no model in between) and only hand the model narrow,
 * guarded tools built on top of it (see tools.ts) - never the raw "execute anything" tool.
 */
export interface HostingerHealth {
  configured: boolean; connected: boolean; tokenSource: "env" | "saved" | "none";
  websites?: number; accounts?: string[]; error?: string; checkedAt: string;
}

export interface Placement { provider: "hostinger"; username: string; domain: string; dir: string }

const require = createRequire(import.meta.url);

export class HostingerClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readOnlyCache = new Map<string, boolean>();
  private stderrTail: string[] = [];

  /** Spawn the MCP server (once) and connect. Restarted automatically after an error or a token change. */
  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const token = secrets.hostingerToken();
    if (!token) throw new Error("Hostinger is not connected - add an API token in Settings → Integrations.");
    this.connecting = (async () => {
      const serverJs = path.join(path.dirname(require.resolve("@hostinger/mcp/package.json")), "src", "servers", "all.js");
      const transport = new StdioClientTransport({
        command: process.execPath, args: [serverJs],
        env: { ...(process.env as Record<string, string>), HOSTINGER_API_TOKEN: token },
        stderr: "pipe", // keep the server's own logs out of our console, but remember the tail for error messages
      });
      transport.stderr?.on("data", (c: Buffer) => {
        for (const l of c.toString().split("\n")) if (l.trim()) { this.stderrTail.push(l); if (this.stderrTail.length > 20) this.stderrTail.shift(); }
      });
      const client = new Client({ name: "livecrafts-backend", version: "0.1.0" });
      transport.onclose = () => { this.client = null; };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Drop the connection (e.g. after the token changed); the next call reconnects. */
  async reset() { const c = this.client; this.client = null; this.readOnlyCache.clear(); await c?.close().catch(() => {}); }

  private async call(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await this.connect();
        const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
        const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (res.isError) throw new Error(text || "Hostinger returned an error");
        return text;
      } catch (e) {
        lastErr = e;
        const msg = String((e as Error).message);
        if (/not connected|Connection closed|EPIPE|spawn/i.test(msg) && attempt === 0) { await this.reset(); continue; }
        break;
      }
    }
    const hint = this.stderrTail.slice(-3).join(" | ");
    throw new Error(String((lastErr as Error)?.message ?? lastErr) + (hint && !/401|Unauthenticated/i.test(String(lastErr)) ? ` (server log: ${hint.slice(0, 300)})` : ""));
  }

  /** Run one Hostinger API operation. Returns the parsed JSON body. */
  async execute(operation: string, params: Record<string, unknown> = {}): Promise<any> {
    const text = await this.call("execute", { operation, params });
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Raw text search over the API catalogue (what the operations are and whether they are read-only). */
  search(query: string, limit = 5): Promise<string> { return this.call("search", { query, limit }); }

  /** True only if Hostinger's own catalogue marks the operation read-only. Unknown => false (deny). */
  async isReadOnly(operation: string): Promise<boolean> {
    if (this.readOnlyCache.has(operation)) return this.readOnlyCache.get(operation)!;
    const text = await this.search(operation.replace(/[_-]/g, " "), 20);
    let ro = false;
    try {
      const list = JSON.parse(text);
      const hit = (Array.isArray(list) ? list : []).find((x: any) => x.operation === operation);
      ro = !!hit && hit.readOnly === true && hit.destructive !== true;
    } catch {
      const m = new RegExp(`"operation"\\s*:\\s*"${operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^}]*?"readOnly"\\s*:\\s*true`).test(text);
      ro = m && !new RegExp(`"operation"\\s*:\\s*"${operation}"[^}]*?"destructive"\\s*:\\s*true`).test(text);
    }
    this.readOnlyCache.set(operation, ro);
    return ro;
  }

  async health(): Promise<HostingerHealth> {
    const base = { configured: !!secrets.hostingerToken(), tokenSource: secrets.hostingerSource(), checkedAt: new Date().toISOString() };
    if (!base.configured) return { ...base, connected: false };
    try {
      const res = JSON.parse(await this.call("execute", { operation: "hosting_websites_list", params: { per_page: 100 } }, 25_000));
      const list: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      return { ...base, connected: true, websites: res?.meta?.total ?? list.length, accounts: [...new Set(list.map((w) => String(w.username)))] };
    } catch (e) {
      const msg = String((e as Error).message);
      const error = /401|Unauthenticated/i.test(msg) ? "Hostinger rejected this API token (401). Check it was copied completely and has not expired or been deleted in hPanel."
        : /403/.test(msg) ? "This token has no access to hosting websites (403)."
        : /timed? ?out/i.test(msg) ? "Hostinger did not answer in time. Check the internet connection and try again."
        : msg.slice(0, 400);
      return { ...base, connected: false, error };
    }
  }

  /** Work out where a WordPress site lives on Hostinger: account username, website domain, and sub-folder. */
  async findPlacement(siteUrl: string): Promise<Placement | null> {
    const u = new URL(siteUrl);
    const host = u.hostname.replace(/^www\./, "");
    const res = await this.execute("hosting_websites_list", { per_page: 100, domain: host });
    const list: any[] = Array.isArray(res?.data) ? res.data : [];
    const w = list.find((x) => String(x.domain).replace(/^www\./, "") === host);
    if (!w) return null;
    return { provider: "hostinger", username: String(w.username), domain: String(w.domain), dir: u.pathname.replace(/^\/+|\/+$/g, "") };
  }

  /** A per-site file system view (paths relative to the WordPress install folder). */
  filesFor(site: Site): RemoteFiles | null {
    const p = site.hosting;
    if (!p || p.provider !== "hostinger") return null;
    const abs = (rel: string) => (p.dir ? `${p.dir}/${rel}` : rel).replace(/\/+/g, "/").replace(/^\//, "");
    return {
      list: async (dir) => {
        const res = await this.execute("hosting_files_list-website-and-directories", { username: p.username, domain: p.domain, directory: abs(dir || "."), max_depth: 1, max_items: 200 });
        const items: any[] = Array.isArray(res?.items) ? res.items : [];
        const strip = (s: string) => (p.dir && s.startsWith(p.dir + "/") ? s.slice(p.dir.length + 1) : s);
        return items.map((i) => ({ name: String(i.name), path: strip(String(i.path)), type: String(i.type), bytes: i.size_bytes ?? null }));
      },
      readViaApi: async (rel, fromLine, maxLines) => {
        const res = await this.execute("hosting_files_website-content", { username: p.username, domain: p.domain, path: abs(rel), ...(fromLine ? { from_line: fromLine } : {}), ...(maxLines ? { max_lines: maxLines } : {}) });
        return typeof res === "string" ? res : res?.content ?? res?.text ?? JSON.stringify(res);
      },
      upload: async (rel, content) => {
        const creds = await this.execute("hosting_files_generate-upload-url", { username: p.username, domain: p.domain });
        if (!creds?.url || !creds?.auth_key || !creds?.rest_auth_key) throw new Error("Hostinger did not return upload credentials.");
        const body = Buffer.from(content, "utf8");
        const dest = `${creds.url}/${abs(rel).split("/").map(encodeURIComponent).join("/")}?override=true`;
        const h = { "X-Auth": creds.auth_key, "X-Auth-Rest": creds.rest_auth_key, "Tus-Resumable": "1.0.0" };
        const c = await fetch(dest, { method: "POST", headers: { ...h, "Upload-Length": String(body.length), "Upload-Offset": "0" } });
        if (c.status !== 201) throw new Error(`Upload could not start (HTTP ${c.status}).`);
        if (body.length) {
          const up = await fetch(dest, { method: "PATCH", headers: { ...h, "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" }, body });
          if (up.status !== 204) throw new Error(`Upload failed (HTTP ${up.status}).`);
        }
      },
    };
  }
}

export interface RemoteFiles {
  list(dir: string): Promise<{ name: string; path: string; type: string; bytes: number | null }[]>;
  readViaApi(rel: string, fromLine?: number, maxLines?: number): Promise<string>;
  upload(rel: string, content: string): Promise<void>;
  /** Exact bytes + fingerprint (Livecrafts plugin 0.7+). Without it only static files can be edited. */
  readExact?(rel: string): Promise<{ content: string; sha1: string } | null>;
  /** Write with a fingerprint check ("new" = create a new file). PHP is syntax-checked by the plugin before writing. */
  write?(rel: string, content: string, expectedSha1: string): Promise<void>;
  /** Delete a file only if it still has exactly this fingerprint (used to undo "create file"). */
  remove?(rel: string, sha1: string): Promise<void>;
}

export const hostinger = new HostingerClient();
