/** Straight at the API, twice with an identical 4k-token prefix: what does usage really say about caching? */
import { systemPrompt } from "../src/agent.js";
const KEY = process.env.OPENAI_API_KEY!;
const model = (process.env.LC_MODEL || "gpt-5.5").replace(/^openai:/, "");
const system = systemPrompt({ id: "s", name: "Test Site", url: "https://example.com", username: "u", appPassword: "p", createdAt: "" } as any,
  { files: true, themeWrites: false, browser: true, hostinger: false, skills: "", mode: "auto" });

async function call(n: number, extra: Record<string, unknown>) {
  const t = Date.now();
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, instructions: system, input: "Reply with exactly: OK", max_output_tokens: 16, ...extra }),
  });
  const j: any = await r.json();
  const u = j.usage ?? {};
  console.log(`#${n} ${JSON.stringify(extra).padEnd(34)} ${String(Date.now() - t).padStart(5)}ms  input ${u.input_tokens}  cached ${u.input_tokens_details?.cached_tokens ?? "?"}  out ${u.output_tokens}`);
}
for (const extra of [{ store: false }, { store: false }, { store: false, prompt_cache_key: "livecrafts-test" }, { store: false, prompt_cache_key: "livecrafts-test" }]) {
  await call(1, extra);
}
