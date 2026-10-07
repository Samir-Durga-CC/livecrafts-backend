/**
 * Talking to the WordPress page that holds the widget. Edits from the click panel, the site history, reverts and the
 * Media Library all go through the page itself (widget.js), so WordPress sees the logged-in person with their own
 * nonce - the backend is never in between, and the plugin only accepts an allowlist of routes this way.
 */
let origin = "";
let seq = 0;
const waiting = new Map<string, (d: any) => void>();

export function connectParent(parentOrigin: string) {
  origin = parentOrigin;
  window.addEventListener("message", (e) => {
    if (e.origin !== origin || !e.data || typeof e.data.id !== "string") return;
    if (e.data.type === "lc:wp-result" || e.data.type === "lc:media-result") waiting.get(e.data.id)?.(e.data);
  });
}

function ask<T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const id = `w${Date.now().toString(36)}${(seq++).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("The page did not answer. Reload it and try again.")); }, timeoutMs);
    waiting.set(id, (d) => { clearTimeout(timer); waiting.delete(id); resolve(d); });
    window.parent.postMessage({ ...msg, id }, origin);
  });
}

/** A Livecrafts REST call made by the page, as the logged-in person. Throws with WordPress's own message. */
export async function wp<T = any>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await ask<{ ok: boolean; data: any; error?: string }>({ type: "lc:wp", method, path, body }, 60_000);
  if (!r.ok) throw Object.assign(new Error(r.error || "WordPress refused it."), { data: r.data });
  return r.data as T;
}

export interface Attachment { id: number; url: string; alt: string; width?: number; height?: number; title?: string }

/** Open the WordPress Media Library (upload or choose). null when the person closed it. */
export async function pickMedia(): Promise<Attachment | null> {
  const r = await ask<{ ok: boolean; attachment?: Attachment; cancelled?: boolean; error?: string }>({ type: "lc:media" }, 30 * 60_000);
  if (r.ok && r.attachment) return r.attachment;
  if (r.cancelled) return null;
  throw new Error(r.error || "The Media Library could not be opened.");
}

export const tell = (msg: Record<string, unknown>) => { if (origin) window.parent.postMessage(msg, origin); };
