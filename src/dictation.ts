import { WebSocket } from "ws";
import { secrets } from "./secrets.js";
import { sttLanguage, transcriptionPrompt } from "./voice.js";

/**
 * Dictation that writes while you talk.
 *
 * WHAT WAS WRONG. Dictation recorded the whole sentence, uploaded the file, and waited: nothing on screen for a
 * second and a half after you stopped, and nothing at all while you spoke. A silence that long reads as "it did
 * not hear me", and people repeat themselves into it.
 *
 * WHAT THIS IS. OpenAI's realtime TRANSCRIPTION session: audio goes up while the person speaks and words come
 * back while they are still speaking. Measured in the stt-lab project on the same audio - first word about 1.4s
 * into a sentence, finished text 0.7s after the last word, against 1.6-2.2s after the last word with nothing
 * before it. It also takes the site's own words as `keywords` and the language as `languages`, which is what
 * stops "AEROMATIC" coming back as "aromatic" and English coming back in Devanagari.
 *
 * The browser never holds the API key: it talks to this backend, and this opens the upstream socket.
 *
 *   LC_DICTATE_MODEL   default gpt-live-transcribe
 */
const UPSTREAM = "wss://api.openai.com/v1/realtime?intent=transcription";
export const dictateModel = () => process.env.LC_DICTATE_MODEL || "gpt-live-transcribe";
/** What the browser is told to send, and what the session is told to expect. One number, agreed in one place. */
export const DICTATE_RATE = 24_000;

export interface DictationHandlers {
  /** Words as they arrive, while the person is still speaking. */
  onPartial: (text: string, itemId?: string) => void;
  /** One finished utterance. */
  onFinal: (text: string, itemId?: string) => void;
  onError: (message: string) => void;
  onReady: (model: string) => void;
}

/**
 * One dictation session: a socket upstream, audio pushed into it, and transcripts coming back.
 *
 * Audio that arrives before the upstream session is accepted is HELD, not dropped. Accepting takes the better
 * part of a second, which is exactly the second in which someone presses the button and starts talking - in the
 * lab, dropping it cost the first two words of every first sentence, and what came back was a sentence, just not
 * theirs.
 */
export class Dictation {
  private up: WebSocket | null = null;
  private waiting: Buffer[] = [];
  private closed = false;

  constructor(private h: DictationHandlers) {}

  get open() { return !this.closed && this.up?.readyState === WebSocket.OPEN; }

  /** Open the upstream session. `siteWords` are the site's own names; `language` pins the script. */
  start(opts: { siteWords?: string; language?: string } = {}) {
    const key = secrets.providerKey("openai");
    if (!key) return this.h.onError("Dictation needs an OpenAI API key (Integrations → AI models → OpenAI).");

    const up = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${key}` } });
    this.up = up;

    up.on("open", () => {
      const language = (opts.language || sttLanguage() || "").trim().toLowerCase();
      up.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: DICTATE_RATE },
              transcription: {
                model: dictateModel(),
                prompt: transcriptionPrompt(opts.siteWords ?? ""),
                // The site's own names, as a list the service is told to expect rather than a hint in prose.
                ...(opts.siteWords?.trim() ? { keywords: siteKeywords(opts.siteWords) } : {}),
                ...(/^[a-z]{2}$/.test(language) ? { languages: [language] } : {}),
              },
              // The browser decides when a sentence ended - it can see the room, and we can fix it.
              turn_detection: null,
            },
          },
        },
      }));
      for (const b of this.waiting.splice(0)) this.append(b);
      this.h.onReady(dictateModel());
    });

    up.on("message", (raw) => {
      let e: any;
      try { e = JSON.parse(String(raw)); } catch { return; }
      if (e.type === "conversation.item.input_audio_transcription.delta") this.h.onPartial(e.delta ?? "", e.item_id);
      else if (e.type === "conversation.item.input_audio_transcription.completed") this.h.onFinal(e.transcript ?? "", e.item_id);
      else if (e.type === "error") this.h.onError(String(e.error?.message ?? "the speech service refused the session"));
    });

    up.on("error", (e) => this.h.onError(`the speech service could not be reached: ${(e as Error).message}`));
    up.on("close", () => { this.closed = true; });
  }

  /** A frame of 16-bit PCM at DICTATE_RATE. Held if the session is not accepted yet. */
  send(pcm: Buffer) {
    if (this.closed) return;
    if (this.up?.readyState === WebSocket.OPEN && !this.waiting.length) return this.append(pcm);
    // ~17 seconds at 1024 samples a frame. A queue that only grows is a leak, not a buffer.
    if (this.waiting.length < 400) this.waiting.push(pcm);
  }

  /** "That was a sentence": everything buffered upstream becomes one utterance. */
  commit() {
    if (this.up?.readyState === WebSocket.OPEN) this.up.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  stop() {
    this.closed = true;
    this.waiting = [];
    try { this.up?.close(); } catch { /* already gone */ }
    this.up = null;
  }

  private append(pcm: Buffer) {
    this.up?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  }
}

/**
 * The site's words as a keyword LIST rather than a sentence.
 *
 * `siteWordsFromMap` builds "AEROMATIC, Request Consultation, Projects delivered, ..." for the prompt; the
 * realtime session wants them as separate entries. Long ones are dropped: a keyword list is for names, and a
 * whole paragraph in it dilutes the rest.
 */
function siteKeywords(siteWords: string, max = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of siteWords.split(",")) {
    const w = raw.trim();
    if (!w || w.length > 40) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
