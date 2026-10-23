import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { secrets, type ProviderId } from "./secrets.js";
import { CLAUDE_CLI_MODELS, claudeCliModel, claudeCliStatus, type CliStatus } from "./claudeCli.js";

/**
 * One place that turns "provider:model" into a model the agent can use, with the provider's key.
 *   openai:gpt-5.5   anthropic:claude-sonnet-5-5   openrouter:anthropic/claude-sonnet-5.5   groq:openai/gpt-oss-120b
 *   custom:<model>  (any OpenAI-compatible server: set its address + key in Integrations)
 * Backwards compatible: "gpt-5.5" means openai, "vendor/model" without a prefix means the Vercel AI Gateway.
 */
export const PROVIDERS: { id: ProviderId; name: string; needsBaseUrl?: boolean; needsNoKey?: boolean; examples: string[]; keyHelp: string }[] = [
  { id: "openai", name: "OpenAI", examples: ["gpt-5.5", "gpt-5.4-mini"], keyHelp: "platform.openai.com → API keys" },
  { id: "anthropic", name: "Anthropic (Claude)", examples: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"], keyHelp: "console.anthropic.com → API keys" },
  { id: "claudecli", name: "Claude CLI (this machine's subscription)", needsNoKey: true, examples: CLAUDE_CLI_MODELS, keyHelp: 'No API key: the Claude Code CLI on the backend machine answers, signed in with "claude auth login".' },
  { id: "openrouter", name: "OpenRouter", examples: ["anthropic/claude-sonnet-5.5", "openai/gpt-5.5", "google/gemini-3-pro"], keyHelp: "openrouter.ai → Keys" },
  { id: "groq", name: "Groq", examples: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], keyHelp: "console.groq.com → API Keys" },
  { id: "gateway", name: "Vercel AI Gateway", examples: ["anthropic/claude-sonnet-5.5", "openai/gpt-5.5"], keyHelp: "vercel.com/dashboard → AI Gateway → API keys" },
  { id: "custom", name: "Custom (OpenAI-compatible)", needsBaseUrl: true, examples: ["your-model-name"], keyHelp: "Any server with an OpenAI-compatible /v1/chat/completions API (LM Studio, vLLM, Together, Fireworks …)" },
];

export interface ModelSpec { provider: ProviderId; model: string }

/** Every provider id that may appear in a spec - the one list the parser, the routes and the UI all read. */
export const PROVIDER_IDS: ProviderId[] = PROVIDERS.map((p) => p.id);
const SPEC_RE = new RegExp(`^(${PROVIDER_IDS.join("|")}):(.+)$`);

export function parseModelSpec(spec: string): ModelSpec {
  const s = spec.trim();
  const m = s.match(SPEC_RE);
  if (m) return { provider: m[1] as ProviderId, model: m[2].trim() };
  if (s.includes("/")) return { provider: "gateway", model: s };
  return { provider: "openai", model: s };
}

export const specToString = (m: ModelSpec) => `${m.provider}:${m.model}`;

function need(p: ProviderId): string {
  const key = secrets.providerKey(p);
  if (!key && p !== "custom" && p !== "claudecli") throw new Error(`No API key for ${PROVIDERS.find((x) => x.id === p)?.name ?? p}. Add it in Integrations → AI models.`);
  return key;
}

export function resolveModel(spec: string): LanguageModel {
  const { provider, model } = parseModelSpec(spec);
  if (!model) throw new Error(`"${spec}" does not name a model.`);
  switch (provider) {
    case "openai": return createOpenAI({ apiKey: need("openai") })(model);
    case "anthropic": return createAnthropic({ apiKey: need("anthropic") })(model);
    // The local CLI: no key, no network call from here - it runs `claude --print` in the background.
    case "claudecli": return claudeCliModel(model) as unknown as LanguageModel;
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

/**
 * Status of every provider for the Integrations screen and the model picker (keys are never sent back).
 * Every provider answers the same three questions: can it answer now (`ready`), if not why (`reason`), and what
 * the person has to do about it (`fix`) - so the UI never has to special-case one provider's wording.
 */
export async function providerStatus() {
  const cli = await claudeCliStatus().catch((e): CliStatus => ({ installed: false, loggedIn: false, ready: false, error: String((e as Error).message) }));

  return PROVIDERS.map((p) => {
    const key = secrets.providerKey(p.id);
    const baseUrl = secrets.providerBaseUrl(p.id);
    // Each provider has its own idea of "configured": the CLI signs itself in, the custom one needs an address.
    const ready = p.id === "claudecli" ? cli.ready : p.id === "custom" ? !!baseUrl : !!key;
    const reason = ready ? undefined
      : p.id === "claudecli" ? (cli.error ?? "The Claude CLI cannot answer on this machine.")
      : p.id === "custom" && !baseUrl ? "This provider has no server address yet."
      : "No API key yet.";
    const fix = ready ? undefined
      : p.id === "claudecli" ? (cli.fix ?? 'Run "claude auth login" on the backend machine.')
      : `Add it in Integrations → AI models (${p.keyHelp}).`;

    return {
      ...p,
      /** Can it answer right now? */
      ready,
      /** Kept for older callers; the same thing as `ready`. */
      configured: ready,
      reason,
      fix,
      /** The built-in examples plus every model name the person added for this provider. */
      models: [...new Set([...p.examples, ...secrets.providerModels(p.id)])],
      keySource: p.id === "claudecli" ? (cli.ready ? "cli" : "none") : secrets.providerSource(p.id),
      baseUrl: p.needsBaseUrl ? baseUrl : undefined,
      ...(p.id === "claudecli" ? { cli } : {}),
    };
  });
}

/** A tiny real request, so "Save & test" proves the key and model work. */
export async function testModel(spec: string): Promise<{ ok: boolean; reply?: string; error?: string; ms: number }> {
  const t = Date.now();
  try {
    const r = await generateText({ model: resolveModel(spec), prompt: "Reply with exactly: OK", maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) } as any);
    return { ok: true, reply: r.text.trim().slice(0, 40), ms: Date.now() - t };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    // The Claude CLI already explains itself in words the person can act on - do not flatten it into "bad key".
    if (parseModelSpec(spec).provider === "claudecli") return { ok: false, error: msg.slice(0, 300), ms: Date.now() - t };
    const friendly = /401|invalid.*key|unauthorized|authentication/i.test(msg) ? "The provider rejected the API key."
      : /404|not.?found|does not exist|model_not_found/i.test(msg) ? "The provider does not know this model name."
      : /429|rate|quota|credit|billing/i.test(msg) ? "The provider refused for rate-limit, quota or billing reasons." : msg.slice(0, 300);
    return { ok: false, error: friendly, ms: Date.now() - t };
  }
}
