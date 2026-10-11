import path from "node:path";

// Node 22 can load a .env file natively: `node --env-file=.env`. The npm scripts already do this.
export const config = {
  port: Number(process.env.PORT ?? 8790),
  host: process.env.HOST ?? "127.0.0.1", // keep local until real auth exists
  dataDir: path.resolve(process.env.LC_DATA_DIR ?? "./data"),
  model: process.env.LC_MODEL ?? "gpt-5.5",
  apiToken: process.env.LC_API_TOKEN ?? "",
  maxSteps: Number(process.env.LC_MAX_STEPS ?? 30),
  jobTimeoutMs: Number(process.env.LC_JOB_TIMEOUT_MS ?? 5 * 60_000),
  bridgeTimeoutMs: Number(process.env.LC_BRIDGE_TIMEOUT_MS ?? 30_000),
  /** Theme file writes go LIVE at once (they cannot be drafts), so the assistant gets them only when this is "1". */
  allowThemeWrites: process.env.LC_ALLOW_THEME_FILES === "1",
  /** Check every change in a real browser (draft view, live view, health, diff). "0" turns it off (e.g. no browser). */
  verifyChanges: process.env.LC_VERIFY_CHANGES !== "0",
  /**
   * How the server's browser identifies itself to the site, so a host/CDN/WAF rule can let it through (bot protection
   * otherwise shows it a "checking your browser" page and the assistant cannot see the page). LC_BROWSER_HEADERS is JSON,
   * e.g. {"X-Livecrafts-Check":"<secret>"} - add a rule on the host that allows requests carrying that header.
   */
  browserHeaders: parseHeaders(process.env.LC_BROWSER_HEADERS),
  browserUserAgent: process.env.LC_BROWSER_USER_AGENT ?? "",
};

function parseHeaders(raw?: string): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw);
    return Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && typeof v === "string")) as Record<string, string>;
  } catch { console.warn("LC_BROWSER_HEADERS is not valid JSON: ignored."); return {}; }
}
