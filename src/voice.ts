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
const sttModel = () => process.env.LC_STT_MODEL || "gpt-4o-transcribe";
/** A language hint (ISO code, e.g. "en" or "hi") makes transcription markedly better for an accent. "" = detect. */
export const sttLanguage = () => (process.env.LC_STT_LANGUAGE ?? "").trim().toLowerCase();
const ttsModel = () => process.env.LC_TTS_MODEL || "gpt-4o-mini-tts";
export const VOICES = ["onyx", "ash", "echo", "fable", "sage", "alloy", "coral", "nova", "shimmer", "ballad", "verse"] as const;
/** How fast it talks (LC_TTS_SPEED, 0.5-2). The browser applies it too, so it works whichever model is used. */
export const speed = () => Math.min(2, Math.max(0.5, Number(process.env.LC_TTS_SPEED ?? 1.15) || 1.15));
const defaultVoice = () => (VOICES as readonly string[]).includes(process.env.LC_TTS_VOICE ?? "") ? process.env.LC_TTS_VOICE! : "onyx";

/** How the assistant sounds: calm, precise, professional - a capable studio assistant, not a cheerful chatbot. */
const STYLE = "Voice: a confident, professional AI assistant with a refined, slightly British delivery. " +
  "Tone: warm, precise and matter-of-fact, never bubbly. " +
  "Pace: BRISK - the natural, efficient speed of a colleague telling you what they just did, noticeably quicker than " +
  "a narrator. Keep the energy up, do not draw words out, and pause only briefly between sentences. " +
  "Speak in the language of the text with natural native pronunciation and the same calm tone (Hindi text in Hindi, English in English). " +
  "Read web words naturally (say 'WordPress', 'Elementor'); do not read out symbols or URLs.";

/** Words the transcriber should expect (product and builder names it would otherwise mishear). */
export const VOCAB = "Livecrafts, WordPress, Elementor, Gutenberg, ACF, hero section, header, footer, CTA button, Media Library, deploy, draft, revert, padding, margin, font size.";

/**
 * The hint a transcriber gets: how the person speaks, the product words, and the words of THIS site. Both engines use
 * it - Classic sends it with the audio, Realtime sends it in the session's transcription config - so there is one
 * vocabulary to keep current, not two that drift apart.
 */
export function transcriptionPrompt(siteWords = ""): string {
  // Do NOT list languages here. Naming Hindi and Hinglish was enough to make a quiet "hey there, how are you"
  // come back as Devanagari: a short or unclear recording follows whatever the prompt suggests. The language is
  // pinned with the `language` parameter instead (LC_STT_LANGUAGE, or the browser's), which is a far stronger hint.
  return "The speaker is dictating an instruction for their website editor. "
    + `Transcribe exactly what is said, in the language it was said in; never translate it, and never invent words for audio that is unclear or silent. Terms: ${VOCAB}`
    + (siteWords.trim() ? ` On this site: ${siteWords.trim().slice(0, 400)}` : "");
}

/**
 * The site's own words, from its page map (get_page_map): headings, button labels, the brand. VOCAB alone is generic,
 * so "change the AEROMATIC heading" comes back as "aromatic" and the edit targets nothing.
 * Short on purpose - a transcription prompt is a hint, and a long one starts to dilute.
 */
export function siteWordsFromMap(map: any, limit = 400): string {
  const texts: string[] = [];
  const push = (v: unknown) => { const t = String(v ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); if (t && t.length <= 60) texts.push(t); };
  for (const e of (map?.elementor ?? []) as any[]) if (e?.ftype !== "image") push(e.value);
  for (const e of (map?.acf ?? []) as any[]) if (e?.kind === "acf" && e?.ftype !== "image") push(e.value);
  for (const e of (map?.elementor_outline ?? []) as any[]) push(e?.text);
  push(map?.post?.title);
  // Proper nouns and short labels first: those are what a transcriber gets wrong and what an edit is aimed at.
  const seen = new Set<string>();
  const ranked = texts
    .filter((t) => { const k = t.toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); })
    .sort((a, b) => Number(/[A-Z]{2,}/.test(b)) - Number(/[A-Z]{2,}/.test(a)) || a.length - b.length);
  const out: string[] = [];
  let n = 0;
  for (const t of ranked) { if (n + t.length + 2 > limit) break; out.push(t); n += t.length + 2; }
  return out.join(", ");
}

const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/m4a": "m4a", "audio/x-m4a": "m4a" };

function key(): string {
  const k = secrets.providerKey("openai");
  if (!k) throw Object.assign(new Error("Voice needs an OpenAI API key (Integrations → AI models → OpenAI)."), { status: 503 });
  return k;
}

export function voiceInfo() {
  return { available: !!secrets.providerKey("openai"), provider: "openai", voice: defaultVoice(), voices: VOICES, sttModel: sttModel(), ttsModel: ttsModel(), speed: speed(), language: sttLanguage() || "auto" };
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  let msg = body.slice(0, 300);
  try { msg = JSON.parse(body).error?.message ?? msg; } catch { /* not JSON */ }
  const friendly = res.status === 401 ? "the OpenAI key was rejected" : res.status === 429 ? "OpenAI refused for rate-limit or billing reasons" : msg || `HTTP ${res.status}`;
  return Object.assign(new Error(`${what} failed: ${friendly}`), { status: res.status === 429 ? 429 : 502 });
}

/** Audio recorded in the browser -> text. Empty text = nothing was said (silence, a cough). */
/**
 * @param siteWords Words from the site the person is editing - section names, menu titles, headings, the brand.
 *   VOCAB alone is generic, so "change the AEROMATIC heading" is heard as "aromatic" and the edit targets nothing.
 *   Keep it short (a few hundred characters): a transcription prompt is a hint, and a long one starts to dilute.
 */
export async function transcribe(audio: Buffer, mime: string, siteWords = "", language = ""): Promise<{ text: string; ms: number }> {
  const t = Date.now();
  const type = mime.split(";")[0].trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) throw Object.assign(new Error(`Unsupported audio format "${type || "unknown"}".`), { status: 415 });
  if (audio.length < 1200) return { text: "", ms: 0 }; // a header with no sound
  const form = new FormData();
  form.append("file", new File([new Uint8Array(audio)], `speech.${ext}`, { type }));
  form.append("model", sttModel());
  form.append("response_format", "json");
  // LC_STT_LANGUAGE wins; otherwise the language the caller asked for (the widget sends the browser's). Without
  // either, the model picks a language from two seconds of audio and sometimes picks the wrong script entirely.
  const lang = sttLanguage() || (/^[a-z]{2}$/.test(language.trim().toLowerCase()) ? language.trim().toLowerCase() : "");
  if (lang) form.append("language", lang);
  form.append("prompt", transcriptionPrompt(siteWords));
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
  else body.speed = speed();                                 // ... and they take a speed instead
  const res = await fetch(`${API}/audio/speech`, {
    method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw await failure(res, "Speech");
  return Buffer.from(await res.arrayBuffer());
}
