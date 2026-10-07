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
};
