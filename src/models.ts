import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { secrets, type ProviderId } from "./secrets.js";

/**
 * One place that turns "provider:model" into a model the agent can use, with the provider's key.
 *   openai:gpt-5.5   anthropic:claude-sonnet-5-5   openrouter:anthropic/claude-sonnet-5.5   groq:openai/gpt-oss-120b
 *   custom:<model>  (any OpenAI-compatible server: set its address + key in Integrations)
 * Backwards compatible: "gpt-5.5" means openai, "vendor/model" without a prefix means the Vercel AI Gateway.
 */
export const PROVIDERS: { id: ProviderId; name: string; needsBaseUrl?: boolean; examples: string[]; keyHelp: string }[] = [
  { id: "openai", name: "OpenAI", examples: ["gpt-5.5", "gpt-5.4-mini"], keyHelp: "platform.openai.com → API keys" },
  { id: "anthropic", name: "Anthropic (Claude)", examples: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"], keyHelp: "console.anthropic.com → API keys" },
  { id: "openrouter", name: "OpenRouter", examples: ["anthropic/claude-sonnet-5.5", "openai/gpt-5.5", "google/gemini-3-pro"], keyHelp: "openrouter.ai → Keys" },
  { id: "groq", name: "Groq", examples: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], keyHelp: "console.groq.com → API Keys" },
  { id: "custom", name: "Custom (OpenAI-compatible)", needsBaseUrl: true, examples: ["your-model-name"], keyHelp: "Any server with an OpenAI-compatible /v1/chat/completions API (LM Studio, vLLM, Together, Fireworks …)" },
];

export interface ModelSpec { provider: ProviderId; model: string }

export function parseModelSpec(spec: string): ModelSpec {
  const s = spec.trim();
  const m = s.match(/^(openai|anthropic|openrouter|groq|custom|gateway):(.+)$/);
  if (m) return { provider: m[1] as ProviderId, model: m[2].trim() };
  if (s.includes("/")) return { provider: "gateway", model: s };
  return { provider: "openai", model: s };
}

export const specToString = (m: ModelSpec) => `${m.provider}:${m.model}`;

function need(p: ProviderId): string {
  const key = secrets.providerKey(p);
  if (!key && p !== "custom") throw new Error(`No API key for ${PROVIDERS.find((x) => x.id === p)?.name ?? p}. Add it in Integrations → AI models.`);
  return key;
}

export function resolveModel(spec: string): LanguageModel {
  const { provider, model } = parseModelSpec(spec);
  if (!model) throw new Error(`"${spec}" does not name a model.`);
  switch (provider) {
    case "openai": return createOpenAI({ apiKey: need("openai") })(model);
    case "anthropic": return createAnthropic({ apiKey: need("anthropic") })(model);
    case "groq": return createGroq({ apiKey: need("groq") })(model);
    case "openrouter":
      return createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: need("openrouter"), headers: { "X-Title": "Livecrafts" } })(model);
    case "custom": {
      const baseURL = secrets.providerBaseUrl("custom");
      if (!baseURL) throw new Error("The custom provider has no address. Add it in Integrations → AI models.");
      return createOpenAICompatible({ name: "custom", baseURL, apiKey: secrets.providerKey("custom") || undefined })(model);
    }
    case "gateway": return createGateway({ apiKey: need("gateway") })(model);
  }
}

/** Status of every provider for the Integrations screen (keys are never sent back). */
export function providerStatus() {
  return PROVIDERS.map((p) => ({
    ...p, configured: !!secrets.providerKey(p.id) || (p.id === "custom" && !!secrets.providerBaseUrl("custom")),
    keySource: secrets.providerSource(p.id), baseUrl: p.needsBaseUrl ? secrets.providerBaseUrl(p.id) : undefined,
  }));
}

/** A tiny real request, so "Save & test" proves the key and model work. */
export async function testModel(spec: string): Promise<{ ok: boolean; reply?: string; error?: string; ms: number }> {
  const t = Date.now();
  try {
    const r = await generateText({ model: resolveModel(spec), prompt: "Reply with exactly: OK", maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) } as any);
    return { ok: true, reply: r.text.trim().slice(0, 40), ms: Date.now() - t };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const friendly = /401|invalid.*key|unauthorized|authentication/i.test(msg) ? "The provider rejected the API key."
      : /404|not.?found|does not exist|model_not_found/i.test(msg) ? "The provider does not know this model name."
      : /429|rate|quota|credit|billing/i.test(msg) ? "The provider refused for rate-limit, quota or billing reasons." : msg.slice(0, 300);
    return { ok: false, error: friendly, ms: Date.now() - t };
  }
}
