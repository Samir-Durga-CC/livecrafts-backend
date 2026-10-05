import type http from "node:http";
import { newId } from "./store.js";

/**
 * "Eyes": the person's own browser, through the Livecrafts widget, used by the assistant to look at the live site.
 *
 * Why: the person's browser shows exactly what visitors see (logged in, real fonts, after any CDN/bot check), while a
 * server-side headless browser can be blocked by "checking your browser" pages. So when the widget is open on the site,
 * inspect / design / read / screenshot requests go to it; otherwise the headless browser is the fallback.
 *
 *   backend tool ──request (SSE)──▶ widget panel (iframe) ──postMessage──▶ widget.js on the page
 *   backend tool ◀──POST result─── widget panel          ◀──postMessage─── (reads the DOM / takes the screenshot)
 */
interface Client { id: string; siteId: string; res: http.ServerResponse; pageUrl: string; viewport: number; since: number }
interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; clientId: string }

export class Eyes {
  private clients = new Map<string, Client>();
  private pending = new Map<string, Pending>();

  /** A widget opened its live line (Server-Sent Events). Returns a function to call when it closes. */
  connect(siteId: string, res: http.ServerResponse, pageUrl: string, viewport: number): () => void {
    const id = newId("eyec");
    this.clients.set(id, { id, siteId, res, pageUrl, viewport, since: Date.now() });
    res.write(`event: hello\ndata: ${JSON.stringify({ id })}\n\n`);
    const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    return () => {
      clearInterval(ping);
      this.clients.delete(id);
      for (const [rid, p] of this.pending) if (p.clientId === id) { clearTimeout(p.timer); this.pending.delete(rid); p.reject(new Error("eyes-closed")); }
    };
  }

  /** The most recent widget for this site - preferring one that shows the requested page. */
  client(siteId: string, url?: string): Client | null {
    const list = [...this.clients.values()].filter((c) => c.siteId === siteId).sort((a, b) => b.since - a.since);
    if (!list.length) return null;
    const path = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); } catch { return u; } };
    return (url && list.find((c) => path(c.pageUrl) === path(url))) || list[0];
  }

  available(siteId: string) { return !!this.client(siteId); }
  status(siteId: string) { const c = this.client(siteId); return c ? { connected: true, pageUrl: c.pageUrl, viewport: c.viewport } : { connected: false }; }

  /** Ask the person's browser to do something. Rejects with "eyes-*" errors when it cannot (caller falls back). */
  request(siteId: string, action: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    const c = this.client(siteId, typeof args.url === "string" ? args.url : undefined);
    if (!c) return Promise.reject(new Error("eyes-none"));
    const id = newId("eye");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("eyes-timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, clientId: c.id });
      c.res.write(`event: request\ndata: ${JSON.stringify({ id, action, args })}\n\n`);
    });
  }

  /** The widget answered. */
  respond(id: string, body: { ok?: boolean; result?: any; error?: string }): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (body.ok === false) p.reject(new Error(body.error || "The browser could not do that."));
    else p.resolve(body.result ?? {});
    return true;
  }
}

export const eyes = new Eyes();

/** Run through the person's browser when the widget is open, otherwise (or if it cannot) with the fallback. */
export async function viaEyes<T>(siteId: string, action: string, args: Record<string, unknown>, fallback: () => Promise<T>): Promise<any> {
  if (eyes.available(siteId)) {
    try { return { ...(await eyes.request(siteId, action, args)), seenBy: "the person's browser (Livecrafts widget)" }; }
    catch (e) {
      const msg = String((e as Error).message);
      if (!/^eyes-(none|timeout|closed)$/.test(msg)) return { ok: false, error: msg };
    }
  }
  const r: any = await fallback();
  return r && typeof r === "object" ? { ...r, seenBy: "the server's headless browser" } : r;
}
