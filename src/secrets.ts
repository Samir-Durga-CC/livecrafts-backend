import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Integration secrets (DEV storage): data/secrets.json, never committed (data/ is git-ignored).
 * An environment variable always wins over the file, so production can inject secrets without touching disk.
 * Before real customers: move this to an encrypted store / secret manager.
 */
interface Secrets { hostingerToken?: string }
const file = () => path.join(config.dataDir, "secrets.json");

function read(): Secrets { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; } }
function write(s: Secrets) { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(s, null, 2)); }

export const secrets = {
  hostingerToken(): string { return process.env.HOSTINGER_API_TOKEN || read().hostingerToken || ""; },
  hostingerSource(): "env" | "saved" | "none" { return process.env.HOSTINGER_API_TOKEN ? "env" : read().hostingerToken ? "saved" : "none"; },
  setHostingerToken(t: string) { const s = read(); if (t) s.hostingerToken = t; else delete s.hostingerToken; write(s); },
};
