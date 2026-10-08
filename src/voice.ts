import { secrets } from "./secrets.js";

/**
 * Voice for the chat: speech to text (what the person says) and text to speech (the assistant's answer, read aloud).
 * OpenAI's audio API, with the same key as the OpenAI models. The browser records and plays; it never sees the key.
 *
 *   LC_STT_MODEL  transcription model   (default gpt-4o-mini-transcribe)
 *   LC_TTS_MODEL  speech model          (default gpt-4o-mini-tts)
 *   LC_TTS_VOICE  default voice         (default onyx)
 */
const API = "https://api.openai.com/v1";
const sttModel = () => process.env.LC_STT_MODEL || "gpt-4o-mini-transcribe";
const ttsModel = () => process.env.LC_TTS_MODEL || "gpt-4o-mini-tts";
export const VOICES = ["onyx", "ash", "echo", "fable", "sage", "alloy", "coral", "nova", "shimmer", "ballad", "verse"] as const;
const defaultVoice = () => (VOICES as readonly string[]).includes(process.env.LC_TTS_VOICE ?? "") ? process.env.LC_TTS_VOICE! : "onyx";

/** How the assistant sounds: calm, precise, professional - a capable studio assistant, not a cheerful chatbot. */
const STYLE = "Voice: a calm, confident, professional AI assistant with a refined, slightly British delivery. " +
  "Tone: composed, warm and precise, never bubbly. Pace: measured and clear, natural pauses between sentences. " +
  "Speak in the language of the text with natural native pronunciation and the same calm tone (Hindi text in Hindi, English in English). " +
  "Read web words naturally (say 'WordPress', 'Elementor'); do not read out symbols or URLs.";

/** Words the transcriber should expect (product and builder names it would otherwise mishear). */
const VOCAB = "Livecrafts, WordPress, Elementor, Gutenberg, ACF, hero section, header, footer, CTA button, Media Library, deploy, draft, revert, padding, margin, font size.";

const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/m4a": "m4a", "audio/x-m4a": "m4a" };

function key(): string {
  const k = secrets.providerKey("openai");
  if (!k) throw Object.assign(new Error("Voice needs an OpenAI API key (Integrations → AI models → OpenAI)."), { status: 503 });
  return k;
}

export function voiceInfo() {
  return { available: !!secrets.providerKey("openai"), provider: "openai", voice: defaultVoice(), voices: VOICES, sttModel: sttModel(), ttsModel: ttsModel() };
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  let msg = body.slice(0, 300);
  try { msg = JSON.parse(body).error?.message ?? msg; } catch { /* not JSON */ }
  const friendly = res.status === 401 ? "the OpenAI key was rejected" : res.status === 429 ? "OpenAI refused for rate-limit or billing reasons" : msg || `HTTP ${res.status}`;
  return Object.assign(new Error(`${what} failed: ${friendly}`), { status: res.status === 429 ? 429 : 502 });
}

/** Audio recorded in the browser -> text. Empty text = nothing was said (silence, a cough). */
export async function transcribe(audio: Buffer, mime: string): Promise<{ text: string; ms: number }> {
  const t = Date.now();
  const type = mime.split(";")[0].trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) throw Object.assign(new Error(`Unsupported audio format "${type || "unknown"}".`), { status: 415 });
  if (audio.length < 1200) return { text: "", ms: 0 }; // a header with no sound
  const form = new FormData();
  form.append("file", new File([new Uint8Array(audio)], `speech.${ext}`, { type }));
  form.append("model", sttModel());
  form.append("response_format", "json");
  form.append("prompt", `The speaker is editing their website with an AI assistant and may speak any language (English, Hindi, Hinglish, ...). Transcribe in the language spoken, in its own script; do not translate. Terms: ${VOCAB}`);
  const res = await fetch(`${API}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key()}` }, body: form, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw await failure(res, "Transcription");
  const j = (await res.json()) as { text?: string };
  return { text: cleanTranscript(j.text ?? ""), ms: Date.now() - t };
}

/** Transcribers sometimes "hear" these in silence or noise. They are never a real request. */
const PHANTOM = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by .*|music)$/i;
function cleanTranscript(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return PHANTOM.test(t) ? "" : t;
}

/** Text -> speech (mp3). The caller sends one or two sentences at a time so playback starts quickly. */
export async function speak(text: string, voice?: string): Promise<Buffer> {
  const input = text.replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!input) throw Object.assign(new Error("Nothing to say."), { status: 400 });
  const v = voice && (VOICES as readonly string[]).includes(voice) ? voice : defaultVoice();
  const body: Record<string, unknown> = { model: ttsModel(), input, voice: v, response_format: "mp3" };
  if (!/^tts-1/.test(ttsModel())) body.instructions = STYLE; // the tts-1 models do not take a style
  const res = await fetch(`${API}/audio/speech`, {
    method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw await failure(res, "Speech");
  return Buffer.from(await res.arrayBuffer());
}
