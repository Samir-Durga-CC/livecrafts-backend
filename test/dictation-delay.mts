/**
 * How fast can the words come back?
 *
 * The transcription session takes a `delay` setting - minimal | low | medium | high | xhigh - that trades
 * accuracy for how long the service waits before it will commit to a word. We were not setting it at all, so we
 * were getting whatever the default is. This says what each one costs and what it hears, on the same audio.
 */
import WebSocket from "ws";
const KEY = process.env.OPENAI_API_KEY!;
const RATE = 24_000;
const MODEL = process.env.LC_DICTATE_MODEL || "gpt-live-transcribe";
const LINE = process.argv.slice(2).find((a) => !a.startsWith("--")) || "Change the big AEROMATIC heading at the top to AEROMATIC LABS";

const r = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "onyx", input: LINE, response_format: "pcm" }),
});
const pcm = Buffer.from(await r.arrayBuffer());
console.log(`"${LINE}"  (${(pcm.length / 2 / RATE).toFixed(2)}s of audio)\n`);

const run = (delay?: string) => new Promise<void>((resolve) => {
  const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", { headers: { Authorization: `Bearer ${KEY}` } });
  let started = 0, ended = 0, first = 0, text = "";
  const done = () => { ws.close(); resolve(); };
  ws.on("open", () => ws.send(JSON.stringify({
    type: "session.update",
    session: { type: "transcription", audio: { input: {
      format: { type: "audio/pcm", rate: RATE },
      transcription: { model: MODEL, languages: ["en"], keywords: ["AEROMATIC", "Elementor"], ...(delay ? { delay } : {}) },
      turn_detection: null,
    } } },
  })));
  ws.on("message", async (raw) => {
    const e: any = JSON.parse(String(raw));
    if (e.type === "conversation.item.input_audio_transcription.delta") { if (!first) first = Date.now(); text += e.delta ?? ""; return; }
    if (e.type === "conversation.item.input_audio_transcription.completed") {
      console.log(`delay=${(delay ?? "(unset)").padEnd(8)} first word ${String(first ? first - started : -1).padStart(5)}ms after speech starts   final ${String(Date.now() - ended).padStart(5)}ms after it ends   "${e.transcript}"`);
      return done();
    }
    if (e.type === "error") { console.log(`delay=${delay}: ERROR ${JSON.stringify(e.error).slice(0, 160)}`); return done(); }
    if (e.type !== "session.updated" && e.type !== "session.created") return;
    if (started) return;
    started = Date.now();
    const frame = RATE * 0.1 * 2;
    // The API takes audio as a JSON event with base64, never as a binary frame.
    for (let i = 0; i < pcm.length; i += frame) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + frame).toString("base64") }));
      await new Promise((x) => setTimeout(x, 100));
    }
    ended = Date.now();
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  });
  ws.on("error", () => resolve());
  setTimeout(done, 45_000);
});

for (const d of [undefined, "minimal", "low", "medium"]) await run(d);
