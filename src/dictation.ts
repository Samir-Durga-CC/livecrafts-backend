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
 *   LC_DICTATE_DELAY   minimal (default) | low | medium | high | xhigh
 */
const UPSTREAM = "wss://api.openai.com/v1/realtime?intent=transcription";
export const dictateModel = () => process.env.LC_DICTATE_MODEL || "gpt-live-transcribe";
/**
 * How long the service may wait before committing to a word. Measured on one line (test/dictation-delay.mts):
 *
 *   unset     first word 1307ms after speech starts, finished text  653ms after it ends
 *   minimal   first word  695ms                   , finished text  929ms
 *   low       first word 1211ms                   , finished text  778ms
 *   medium    first word 1384ms                   , finished text  759ms
 *
 * Dictation is watched while it is typed, so the first word is what the person is waiting for: minimal nearly
 * halves it, and pays about a quarter of a second on the end, which lands while they are still reading.
 */
export const dictateDelay = () => process.env.LC_DICTATE_DELAY || "minimal";
/** What the browser is told to send, and what the session is told to expect. One number, agreed in one place. */
export const DICTATE_RATE = 24_000;

export interface DictationHandlers {
  /** Words as they arrive, while the person is still speaking. */
  onPartial: (text: string, itemId?: string) => void;
  /** One finished utterance. */
  onFinal: (text: string, itemId?: string) => void;
  onError: (message: string) => void;
  onReady: (model: string) => void;
  /** The SERVICE's own view of whether someone is speaking - it is the one segmenting the audio. */
  onSpeech?: (speaking: boolean) => void;
}

/**
 * One dictation session: a socket upstream, audio pushed into it, and transcripts coming back.
 *
 * Audio that arrives before the upstream session is accepted is HELD, not dropped. Accepting takes the better
 * part of a second, which is exactly the second in which someone presses the button and starts talking - in the
 * lab, dropping it cost the first two words of every first sentence, and what came back was a sentence, just not
 * theirs.
 */
/**
 * Who decides where a sentence ends.
 *
 *   server  the service listens for the pause (gpt-4o-transcribe and friends)
 *   model   nobody is told anything - the model segments the stream itself
 *   client  the widget's own detector sends a commit, which is what produced fragments
 *
 * LC_DICTATE_TURNS overrides it; the default follows the model. gpt-live-transcribe refuses to be told ("Turn
 * detection is not supported for this transcription model") AND never finalises on its own - measured: partials
 * stream from 898ms and `completed` never arrives in a minute. So it is committed from the client, but only
 * after a pause long enough to be the end of dictation rather than a breath (web/src/widget/dictation.ts).
 */
export const turnMode = () => (process.env.LC_DICTATE_TURNS || (/live-transcribe/.test(dictateModel()) ? "client" : "server")) as "server" | "model" | "client";
function turnDetection(): Record<string, unknown> {
  const mode = turnMode();
  if (mode === "client") return { turn_detection: null };
  if (mode === "model") return {}; // say nothing: the model's own segmentation stands
  // Long silence: nothing waits on the end of a turn in dictation, so a breath must not end the sentence, and
  // the padding keeps the quiet opening consonants a bare threshold would clip.
  return { turn_detection: { type: "server_vad", threshold: 0.4, prefix_padding_ms: 400, silence_duration_ms: 800 } };
}

/**
 * Frames held while the session is being configured.
 *
 * ~43ms of audio a frame, so about fifty seconds. The old limit was 400 (~17s), which is short enough that a
 * slow acknowledgement and a talkative first sentence could overflow it and lose the start.
 */
const MAX_WAITING_FRAMES = 1_200;
/** If `session.updated` never arrives, send what is held anyway rather than hold it forever. */
const CONFIG_TIMEOUT_MS = 4_000;

export class Dictation {
  private up: WebSocket | null = null;
  private waiting: Buffer[] = [];
  private closed = false;
  private language = "";
  private siteWords = "";
  /** The service has ACKNOWLEDGED the transcription session. Audio sent before this is held, not appended. */
  private configured = false;
  private configTimer: NodeJS.Timeout | null = null;

  constructor(private h: DictationHandlers) {}

  get open() { return !this.closed && this.up?.readyState === WebSocket.OPEN; }

  /**
   * Open the upstream session. `siteWords` are the site's own names; `language` pins the script.
   *
   * The site's words are OPTIONAL here and can arrive later through `addSiteWords`: reading them means reading
   * the site, which takes a moment on a good day and can hang on a bad one, and nobody should wait for a web
   * server before their microphone starts working.
   */
  start(opts: { siteWords?: string; language?: string } = {}) {
    this.language = opts.language ?? "";
    const key = secrets.providerKey("openai");
    if (!key) return this.h.onError("Dictation needs an OpenAI API key (Integrations → AI models → OpenAI).");

    const up = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${key}` } });
    this.up = up;

    this.siteWords = opts.siteWords ?? "";
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
                delay: dictateDelay(),
              },
              /**
               * THE SERVICE decides where a sentence ends, not us.
               *
               * This used to be `null`, with the widget's own detector sending a commit whenever it believed a
               * sentence had finished. Every commit closes an utterance, so a detector that fires on a breath or
               * a gap between words slices the sentence into sub-second fragments - and a context-free fragment,
               * handed a list of the site's own vocabulary as keywords, comes back as that vocabulary: a person
               * saying "Hey there, how are you? This is something I wanted to ask you" got back "And section
               * something class make sure". The words it invented were ours, out of the keyword list.
               *
               * Measured against the same audio, one commit at the end transcribes perfectly
               * (test/dictation-check.mts). Server-side detection is that, decided continuously, by something
               * listening to the audio itself rather than to a level meter on a busy UI thread.
               *
               * silence_duration_ms is long for dictation: nothing waits on the end of a turn here, so a pause
               * for breath should not end the sentence. prefix_padding keeps the quiet opening consonants that a
               * threshold alone would clip.
               */
              ...turnDetection(),
            },
          },
        },
      }));
      /**
       * The socket being open is not the session being ready.
       *
       * `onReady` is what makes the widget beep and tell the person to speak, so it waits for the service to
       * acknowledge the configuration (`session.updated`) rather than for the TCP connection. Audio appended
       * before that acknowledgement is audio appended to a session whose format is not agreed yet.
       *
       * The timeout is the safety net: a service that accepts the socket and never answers must not leave a
       * person holding a microphone that will never beep.
       */
      this.configTimer = setTimeout(() => this.configure("timeout"), CONFIG_TIMEOUT_MS);
    });

    up.on("message", (raw) => {
      let e: any;
      try { e = JSON.parse(String(raw)); } catch { return; }
      if (e.type === "session.updated" || e.type === "transcription_session.updated") return this.configure("acknowledged");
      if (e.type === "input_audio_buffer.speech_started") return this.h.onSpeech?.(true);
      if (e.type === "input_audio_buffer.speech_stopped") return this.h.onSpeech?.(false);
      if (e.type === "conversation.item.input_audio_transcription.delta") this.h.onPartial(e.delta ?? "", e.item_id);
      else if (e.type === "conversation.item.input_audio_transcription.completed") this.h.onFinal(e.transcript ?? "", e.item_id);
      else if (e.type === "error") this.h.onError(String(e.error?.message ?? "the speech service refused the session"));
    });

    up.on("error", (e) => this.h.onError(`the speech service could not be reached: ${(e as Error).message}`));
    up.on("close", () => { this.closed = true; });
  }

  /**
   * The site's own words, once reading the site has finished - the session started without waiting for them.
   * Sent as an update, so they apply to everything said from here on; the first sentence may miss them, which is
   * a far better trade than a microphone that takes three seconds to open.
   */
  addSiteWords(siteWords: string) {
    if (!siteWords.trim() || siteWords === this.siteWords) return;
    this.siteWords = siteWords;
    if (this.up?.readyState !== WebSocket.OPEN) return;
    const language = (this.language || sttLanguage() || "").trim().toLowerCase();
    this.up.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: { input: { transcription: {
          model: dictateModel(),
          prompt: transcriptionPrompt(siteWords),
          keywords: siteKeywords(siteWords),
          ...(/^[a-z]{2}$/.test(language) ? { languages: [language] } : {}),
          delay: dictateDelay(),
        } } },
      },
    }));
  }

  /** The session is agreed: everything held goes up in order, and only then is anyone told to speak. */
  private configure(how: "acknowledged" | "timeout") {
    if (this.configured || this.closed) return;
    this.configured = true;
    if (this.configTimer) { clearTimeout(this.configTimer); this.configTimer = null; }
    for (const b of this.waiting.splice(0)) this.append(b);
    void how; // the distinction matters when reading a log, not here
    this.h.onReady(dictateModel());
  }

  /** A frame of 16-bit PCM at DICTATE_RATE. Held if the session is not accepted yet. */
  send(pcm: Buffer) {
    if (this.closed) return;
    if (this.configured && this.up?.readyState === WebSocket.OPEN && !this.waiting.length) return this.append(pcm);
    // A queue that only grows is a leak, not a buffer - so it is bounded, and it drops the OLDEST frame rather
    // than refusing the newest: what someone is saying now matters more than what they said a minute ago.
    this.waiting.push(pcm);
    if (this.waiting.length > MAX_WAITING_FRAMES) this.waiting.shift();
  }

  /**
   * Kept so the widget's older "that was a sentence" message is not an error, and deliberately does nothing.
   *
   * The service segments the audio itself now (see turn_detection above). A manual commit on top of that is
   * rejected outright when the buffer is empty, and when it is not, it cuts the sentence the service is in the
   * middle of - which is the bug this replaced.
   */
  commit() {
    if (turnMode() !== "client") return; // the service, or the model, decides where sentences end
    if (this.configured && this.up?.readyState === WebSocket.OPEN) this.up.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  stop() {
    this.closed = true;
    if (this.configTimer) { clearTimeout(this.configTimer); this.configTimer = null; }
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
