import { Bridge } from "./bridge.js";
import type { Persona } from "./agent.js";
import type { Site } from "./types.js";

/**
 * Assistant settings that the site owner sets in WordPress (Settings → Livecrafts): bot name, welcome message,
 * extra instructions, model and default approval mode. Read from the plugin (0.8+) and cached for a minute.
 * Older plugins simply have none - the defaults apply.
 */
export interface AssistantSettings extends Persona { welcome?: string; approvalMode?: string; accent?: string }

const cache = new Map<string, { at: number; value: AssistantSettings | null }>();
const TTL = 60_000;

export async function assistantSettings(site: Site, opts: { fresh?: boolean } = {}): Promise<AssistantSettings | null> {
  const hit = cache.get(site.id);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL) return hit.value;
  let value: AssistantSettings | null = null;
  try {
    const r: any = await new Bridge(site).request("GET", "livecrafts/v1/assistant");
    value = {
      botName: str(r?.botName, 60), welcome: str(r?.welcome, 500), instructions: str(r?.instructions, 4000),
      model: str(r?.model, 120), approvalMode: str(r?.approvalMode, 10), accent: /^#[0-9a-f]{3,8}$/i.test(String(r?.accent ?? "")) ? r.accent : undefined,
    };
  } catch { value = null; }
  cache.set(site.id, { at: Date.now(), value });
  return value;
}

export const forgetAssistantSettings = (siteId: string) => cache.delete(siteId);

function str(v: unknown, max: number) { const s = typeof v === "string" ? v.trim() : ""; return s ? s.slice(0, max) : undefined; }
