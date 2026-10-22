/** Does the SDK hand us the cached-token count anywhere? We know the API reports it (test/cache-raw.mts). */
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { systemPrompt } from "../src/agent.js";
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = openai((process.env.LC_MODEL || "gpt-5.5").replace(/^openai:/, ""));
const system = systemPrompt({ id: "s", name: "Probe", url: "https://example.com", username: "u", appPassword: "p", createdAt: "" } as any,
  { files: true, themeWrites: false, browser: true, hostinger: false, skills: "", mode: "auto" });
for (let i = 0; i < 2; i++) {
  const r: any = await generateText({ model, system, prompt: "Reply with exactly: OK", maxRetries: 0, providerOptions: { openai: { store: false } } } as any);
  console.log(`#${i + 1} usage keys:`, Object.keys(r.usage ?? {}).join(", "));
  console.log("   usage:", JSON.stringify(r.usage));
  console.log("   response.body usage:", JSON.stringify((r.response as any)?.body?.usage ?? null));
  console.log("   providerMetadata:", JSON.stringify(r.providerMetadata ?? null).slice(0, 300));
}
