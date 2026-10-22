/**
 * The dictation socket, driven the way the widget will drive it, with no microphone.
 *
 * A line is spoken by the TTS model as 24kHz PCM, pushed up /voice/stream in real time, and committed. It prints
 * when the first word came back (which should be while the audio is still playing) and when the finished text
 * did. Proving the backend path here means a failure in the browser later is the browser's.
 *
 *   node --env-file-if-exists=.env --import tsx test/dictation-check.mts ["a line to say"]
 */
import http from "node:http";
import path from "node:path";
import { WebSocket } from "ws";
import { createApp } from "../src/server.js";
import { JsonStore, newId } from "../src/store.js";
import { FileStore } from "../src/files.js";
import { buildAgent } from "../src/agent.js";
import { JobRunner } from "../src/jobs.js";
import { config } from "../src/config.js";
import { DICTATE_RATE } from "../src/dictation.js";
import type { Job, Site } from "../src/types.js";

const KEY = process.env.OPENAI_API_KEY ?? "";
if (!KEY) { console.error("OPENAI_API_KEY is not set."); process.exit(1); }
const LINE = process.argv.slice(2).find((a) => !a.startsWith("--")) || "Change the big AEROMATIC heading at the top to AEROMATIC LABS";

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const jobs = new JsonStore<Job>(path.join(config.dataDir, "jobs"));
const app = createApp(new JobRunner(jobs, sites, buildAgent(new FileStore())), sites, new FileStore());
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const port = (app.address() as any).port;
console.log(`backend on 127.0.0.1:${port}`);

const speech = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "onyx", input: LINE, response_format: "pcm" }),
});
if (!speech.ok) { console.error("tts failed:", (await speech.text()).slice(0, 200)); process.exit(1); }
const pcm = Buffer.from(await speech.arrayBuffer());
console.log(`saying "${LINE}" (${(pcm.length / 2 / DICTATE_RATE).toFixed(2)}s)`);

// The site is passed so the session gets the site's own words, exactly as the widget will.
const siteId = process.env.BENCH_SITE || sites.list()[0]?.id || "";
// The widget asks for /voice when it opens, which starts the read of the site's own words. Do the same here,
// or this measures a cold cache that production would never have.
if (!process.argv.includes("--cold")) {
  const t = Date.now();
  await fetch(`http://127.0.0.1:${port}/voice?siteId=${siteId}`).catch(() => null);
  await new Promise((r) => setTimeout(r, 2500)); // give that read a moment, as a person deciding to talk would
  console.log(`warmed the site's words (${Date.now() - t}ms, as the widget does on open)`);
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream?siteId=${siteId}&lang=en`);
let started = 0, ended = 0, first = 0, partial = "";

ws.on("open", () => console.log("socket open (sending audio as soon as the session is ready)"));
ws.on("message", async (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "error") { console.error("ERROR:", m.message); process.exit(1); }
  if (m.type === "partial") {
    if (!first) { first = Date.now(); console.log(`FIRST WORD  ${first - started}ms after the audio started - while it is still being spoken`); }
    partial += m.text;
    return;
  }
  if (m.type === "final") {
    console.log(`FINAL       ${Date.now() - ended}ms after the audio ended`);
    console.log(`HEARD       ${JSON.stringify(m.text || partial)}`);
    ws.close();
    app.close();
    process.exit(0);
  }
  if (m.type !== "ready") return;
  console.log(`session ready (${m.model})`);
  started = Date.now();
  const frame = DICTATE_RATE * 0.1 * 2; // 100ms of 16-bit samples, the way a worklet would deliver it
  for (let i = 0; i < pcm.length; i += frame) {
    ws.send(pcm.subarray(i, i + frame));
    await new Promise((r) => setTimeout(r, 100));
  }
  ended = Date.now();
  ws.send(JSON.stringify({ type: "commit" }));
});
ws.on("error", (e) => { console.error("socket:", (e as Error).message); process.exit(1); });
setTimeout(() => { console.error("nothing came back in 60s"); process.exit(1); }, 60_000);
