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
};
