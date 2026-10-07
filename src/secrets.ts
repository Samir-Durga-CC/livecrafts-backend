import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Integration secrets (DEV storage): data/secrets.json, never committed (data/ is git-ignored).
 * An environment variable always wins over the file, so production can inject secrets without touching disk.
 * Before real customers: move this to an encrypted store / secret manager.
 */
export type ProviderId = "openai" | "anthropic" | "openrouter" | "groq" | "custom" | "gateway";
interface Secrets { hostingerToken?: string; providers?: Partial<Record<ProviderId, { apiKey?: string; baseUrl?: string }>>; sites?: Record<string, { secret?: string }> }
const file = () => path.join(config.dataDir, "secrets.json");

function read(): Secrets { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; } }
function write(s: Secrets) { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(s, null, 2)); }

/** The environment variable each provider's key comes from (it wins over a key saved in the app). */
export const PROVIDER_ENV: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY", custom: "LC_CUSTOM_API_KEY", gateway: "AI_GATEWAY_API_KEY",
};

export const secrets = {
  hostingerToken(): string { return process.env.HOSTINGER_API_TOKEN || read().hostingerToken || ""; },
  hostingerSource(): "env" | "saved" | "none" { return process.env.HOSTINGER_API_TOKEN ? "env" : read().hostingerToken ? "saved" : "none"; },
  setHostingerToken(t: string) { const s = read(); if (t) s.hostingerToken = t; else delete s.hostingerToken; write(s); },

  /** The secret a connected site signs its widget tokens with (POST /livecrafts/v1/connect). */
  siteSecret(siteId: string): string { return read().sites?.[siteId]?.secret || ""; },
  setSiteSecret(siteId: string, secret: string | null) {
    const s = read(); s.sites ??= {};
    if (secret) s.sites[siteId] = { ...s.sites[siteId], secret }; else delete s.sites[siteId];
    write(s);
  },

  providerKey(p: ProviderId): string { return process.env[PROVIDER_ENV[p]] || read().providers?.[p]?.apiKey || ""; },
  providerSource(p: ProviderId): "env" | "saved" | "none" { return process.env[PROVIDER_ENV[p]] ? "env" : read().providers?.[p]?.apiKey ? "saved" : "none"; },
  /** Only the custom (any OpenAI-compatible) provider needs an address. */
  providerBaseUrl(p: ProviderId): string { return (p === "custom" ? process.env.LC_CUSTOM_BASE_URL : "") || read().providers?.[p]?.baseUrl || ""; },
  setProvider(p: ProviderId, v: { apiKey?: string; baseUrl?: string } | null) {
    const s = read(); s.providers ??= {};
    if (!v) delete s.providers[p];
    else s.providers[p] = { ...s.providers[p], ...(v.apiKey !== undefined ? { apiKey: v.apiKey } : {}), ...(v.baseUrl !== undefined ? { baseUrl: v.baseUrl } : {}) };
    write(s);
  },
};
