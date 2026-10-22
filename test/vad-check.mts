/**
 * Does the widget's voice detector notice that someone is talking?
 *
 * A user pressed the microphone, spoke, and nothing was ever transcribed - while the waveform showed a strong
 * signal and the session was open. That points at the detector: if it never says "start", no audio is ever sent
 * and no sentence is ever committed, which is silence from the user's side and an idle socket from ours.
 *
 * This feeds the REAL detector (web/src/widget/vad.ts) real speech, in the conditions that differ between a lab
 * run and a person at a desk: speech after a second of room, speech starting immediately, a noisy room, and a
 * quiet one.
 */
import { Vad } from "../web/src/widget/vad.js";

const KEY = process.env.OPENAI_API_KEY ?? "";
if (!KEY) { console.error("OPENAI_API_KEY is not set."); process.exit(1); }
const RATE = 24_000, BLOCK = 128, TICK = Math.max(1, Math.round((BLOCK / RATE) * 1000));

const r = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "onyx", input: "Change the big AEROMATIC heading at the top to AEROMATIC LABS", response_format: "pcm" }),
});
const speech = Buffer.from(await r.arrayBuffer());

/** A stretch of room noise at a given loudness, in 16-bit PCM. */
const room = (ms: number, dbfs: number) => {
  const n = Math.round(RATE * (ms / 1000));
  const amp = Math.pow(10, dbfs / 20) * 32767 * Math.SQRT2;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((Math.random() * 2 - 1) * amp))), i * 2);
  return b;
};

function run(label: string, pcm: Buffer) {
  const vad = new Vad({ tick: TICK });
  const edges: string[] = [];
  let firstStart = -1;
  for (let i = 0; i + BLOCK <= pcm.length / 2; i += BLOCK) {
    let sum = 0;
    for (let j = 0; j < BLOCK; j++) { const s = pcm.readInt16LE((i + j) * 2) / 32768; sum += s * s; }
    const db = 20 * Math.log10(Math.sqrt(sum / BLOCK) + 1e-9);
    const e = vad.push(db);
    if (e) { edges.push(`${e}@${Math.round((i / RATE) * 1000)}ms`); if (e === "start" && firstStart < 0) firstStart = i; }
  }
  const ok = edges.some((e) => e.startsWith("start"));
  console.log(`${ok ? "HEARD " : "DEAF  "} ${label.padEnd(42)} floor ${String(Math.round(vad.floor)).padStart(4)}dB  bar ${String(Math.round(vad.bar)).padStart(4)}dB  edges: ${edges.slice(0, 4).join(" ") || "(none - nothing was ever sent)"}`);
}

run("1s quiet room, then speech (the lab case)", Buffer.concat([room(1000, -60), speech]));
run("speech immediately, no lead-in", speech);
run("300ms room, then speech (press and talk)", Buffer.concat([room(300, -55), speech]));
run("noisy room -44dB, then speech", Buffer.concat([room(1000, -44), speech]));
run("quiet room -70dB, then speech", Buffer.concat([room(1000, -70), speech]));
