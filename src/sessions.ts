/**
 * What one voice session already knows about the site, so the second thing the person says does not pay for the first
 * one again.
 *
 * WHY: every turn used to start from zero - site_status, read_notes and get_page_map, one after the other, before
 * anything happened. That is three round trips to WordPress plus three model steps for "make the heading bigger",
 * while the person stands in front of their site waiting for a voice to answer.
 *
 * The correctness point matters more than the saving: a cached PAGE MAP that the agent itself has just changed would
 * send the next request at a stale target. So every write invalidates the whole session - the cache only ever
 * survives reads.
 */
export class SiteCache {
  private entries = new Map<string, { at: number; value: Promise<unknown> }>();
  /** Counted so a slow session can be looked at: how often a turn was answered from what the session already knew. */
  hits = 0;
  misses = 0;

  constructor(private ttlMs = 10 * 60_000) {}

  /** Read it once per session. A read that fails is not remembered, so the next turn tries again. */
  async get<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) { this.hits++; return hit.value as Promise<T>; }
    this.misses++;
    const value = read();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.entries.get(key)?.value === value) this.entries.delete(key); });
    return value;
  }

  /** The site changed (the agent wrote something): nothing read from it can be trusted any more. */
  invalidate() { this.entries.clear(); }
}

/** One cache per voice session, kept between the turns of that session (the key is the site and the page). */
const sessions = new Map<string, { cache: SiteCache; touched: number }>();
const SESSION_TTL = 30 * 60_000;

export const voiceSessionKey = (siteId: string, pageUrl?: string) => `${siteId}|${pageUrl ?? ""}`;

/** The cache of this voice session, created on the first call (the realtime session route warms it before turn one). */
export function voiceSession(siteId: string, pageUrl?: string): SiteCache {
  for (const [k, s] of sessions) if (Date.now() - s.touched > SESSION_TTL) sessions.delete(k);
  const key = voiceSessionKey(siteId, pageUrl);
  const found = sessions.get(key);
  if (found) { found.touched = Date.now(); return found.cache; }
  const cache = new SiteCache();
  sessions.set(key, { cache, touched: Date.now() });
  return cache;
}
