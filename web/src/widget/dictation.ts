import { chime } from "./voice";
import { Vad } from "./vad";
import { voiceLog } from "./voicelog";

/**
 * Dictation that writes while you talk.
 *
 * The microphone opens, a short beep says it is live, and from then on the words appear in the input box as they
 * are heard - sentence after sentence, until the person presses Stop. Nothing is ever sent on their behalf.
 *
 * What it replaces recorded the whole sentence, uploaded the file and waited, so there was nothing on screen
 * while you spoke and a second and a half of nothing after you stopped. The waiting is the thing people
 * complained about, and no amount of model accuracy fixes it.
 *
 *   mic -> AudioWorklet (PCM at 24kHz, resampled if the browser gave us another rate)
 *       -> this: a voice detector decides where sentences end
 *       -> our backend's /voice/stream -> the speech service
 *       <- words, while the sentence is still being spoken
 */
export type DictateState = "off" | "starting" | "listening" | "hearing" | "transcribing";

export interface DictationHandlers {
  onState: (s: DictateState) => void;
  /** The sentence being spoken right now, as it grows. Replaces whatever the last call passed. */
  onPartial: (text: string) => void;
  /** A finished sentence. It stays in the box and the next one continues after it. */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}

/** What the backend session is told to expect, and so what the worklet must produce. */
const RATE = 24_000;
/**
 * After this long with nothing said, stop sending until there is sound again.
 *
 * Audio is streamed CONTINUOUSLY rather than only once a detector believes you have started - see onPcm. That is
 * what makes words appear the moment you speak, but an open microphone in an empty room should not stream all
 * afternoon, so a long silence pauses it and any sound at all resumes it.
 */
const IDLE_PAUSE_MS = 12_000;

export class Dictation {
  /** Microphone level 0..1 for the waveform in the input box (read 20+ times a second; never a React render). */
  levelSink: ((level: number) => void) | null = null;

  private h: DictationHandlers;
  private state: DictateState = "off";
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;
  private vad: Vad | null = null;
  private quietMs = 0;
  private tickMs = 5;
  private partial = "";
  /** For the voice log: a run that produced nothing must say which stage produced nothing. */
  private sent = 0;
  private sentences = 0;
  private heard5s: number | null = null;

  constructor(h: DictationHandlers) { this.h = h; }

  get active() { return this.state !== "off"; }

  /** Open the microphone and the socket. false when it could not start (the reason went to onError). */
  async start(opts: { siteId?: string; pageUrl?: string; lang?: string } = {}): Promise<boolean> {
    if (this.state !== "off") return true;
    this.set("starting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.set("off");
      this.h.onError(micProblem(e));
      return false;
    }

    try {
      // Ask for the rate the service wants. Chrome gives it; Safari does not, and the worklet resamples instead.
      this.ctx = new AudioContext({ sampleRate: RATE });
      await this.ctx.resume().catch(() => {});
      // A plain file in public/, NOT a bundled module: Vite inlines a small module as a data: URL, and
      // addModule() refuses a data: URL in Safari and Firefox - which is precisely where this has to work.
      await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
      this.node = new AudioWorkletNode(this.ctx, "pcm-worklet", { processorOptions: { targetRate: RATE } });
      this.ctx.createMediaStreamSource(this.stream).connect(this.node);
      this.node.connect(this.ctx.destination); // keeps the graph running; the worklet emits no sound
    } catch (e) {
      this.stop();
      this.h.onError(`The microphone could not be prepared: ${(e as Error).message}`);
      return false;
    }

    // One reading per 128 samples at the context's own rate.
    this.tickMs = Math.max(1, Math.round((128 / (this.ctx.sampleRate || RATE)) * 1000));
    this.vad = new Vad({ tick: this.tickMs });
    this.node.port.onmessage = ({ data }) => {
      if (data.pcm) return this.onPcm(data.pcm as ArrayBuffer);
      if (typeof data.rate === "number") voiceLog.add("dictation.audio", { rate: data.rate, target: data.target, resampling: data.resampling });
      if (typeof data.db === "number") this.onLevel(data.db);
    };

    const q = new URLSearchParams();
    if (opts.siteId) q.set("siteId", opts.siteId);
    if (opts.pageUrl) q.set("pageUrl", opts.pageUrl);
    if (opts.lang) q.set("lang", opts.lang);
    else { const l = (navigator.language || "").slice(0, 2).toLowerCase(); if (/^[a-z]{2}$/.test(l)) q.set("lang", l); }

    this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice/stream?${q}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => this.fromServer(JSON.parse(e.data));
    this.ws.onerror = () => this.h.onError("The dictation connection failed.");
    this.ws.onclose = () => { if (this.state !== "off") this.h.onError("The dictation connection closed."); };

    voiceLog.start("classic", "dictation/stream");
    this.set("listening");
    chime(this.ctx, "start"); // the beep: they know the microphone is live before they speak
    return true;
  }

  /** Close everything. Whatever was already written stays in the box. */
  stop() {
    if (this.heard5s) { window.clearTimeout(this.heard5s); this.heard5s = null; }
    voiceLog.add("dictation.stop", { framesSent: this.sent, sentences: this.sentences });
    this.quietMs = 0;
    this.partial = "";
    try { this.ws?.send(JSON.stringify({ type: "stop" })); } catch { /* already gone */ }
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.vad = null;
    this.set("off");
    this.levelSink?.(0);
  }

  // ---------------------------------------------------------------- the microphone

  private onLevel(db: number) {
    this.levelSink?.(Math.max(0, Math.min(1, (db + 62) / 44)));
    // Once, after five seconds of an open microphone with nothing heard: the levels and the bar it had to cross,
    // so "it did nothing" can be read as either a deaf detector or a silent room.
    this.heard5s ??= window.setTimeout(() => {
      if (!this.sentences && this.vad) voiceLog.add("vad.nothing-after-5s", { floor: Math.round(this.vad.floor), bar: Math.round(this.vad.bar), lastDb: Math.round(db) });
    }, 5000);
    const edge = this.vad?.push(db);
    // Track silence only to pause an idle microphone; it is NOT a gate on sending (see onPcm).
    this.quietMs = this.vad?.speaking ? 0 : this.quietMs + (this.tickMs || 5);

    if (edge === "start") {
      voiceLog.add("vad.start", { db: Math.round(db), floor: Math.round(this.vad!.floor), bar: Math.round(this.vad!.bar) });
      this.set("hearing");
    }
    if (edge === "end") {
      // The sentence is over: everything sent since the last commit becomes one utterance.
      this.sentences++;
      voiceLog.add("vad.end", { framesSent: this.sent, sentence: this.sentences });
      try { this.ws?.send(JSON.stringify({ type: "commit" })); } catch { /* socket gone */ }
      this.set("transcribing");
    }
  }

  /**
   * Everything goes up, as it is recorded.
   *
   * This used to hold audio back until a detector decided someone had started talking, with a pre-roll to cover
   * its delay. That is one threshold too many: in a room whose background sits at -44dB the bar lands at -33dB,
   * a normal speaking voice with noise suppression sits right about there, and the opening words of a sentence
   * are the quietest part of it. The detector fired late or not at all, so the service never heard the start -
   * which feels like a microphone that is slow to pick you up AND transcribes badly, from one cause.
   *
   * The service transcribes what arrives, so sending continuously is what makes words appear as they are said.
   * The detector still decides where a sentence ENDS, which is the thing it is good at. Four seconds of room
   * noise transcribes as "" (stt-lab/scripts/check-noise.mts), so the silence between sentences costs nothing
   * but bandwidth - and an idle microphone pauses after IDLE_PAUSE_MS anyway.
   */
  private onPcm(buf: ArrayBuffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.quietMs > IDLE_PAUSE_MS) return; // nothing said for a while: stop until there is sound again
    this.sent++;
    this.ws.send(buf);
  }

  // ---------------------------------------------------------------- the words

  private fromServer(m: { type: string; text?: string; message?: string; model?: string }) {
    if (m.type === "error") return this.h.onError(m.message ?? "Dictation failed.");
    if (m.type === "ready") { voiceLog.add("dictation.ready", { model: m.model }); return; }
    if (m.type === "partial") {
      this.partial += m.text ?? "";
      this.h.onPartial(this.partial);
      return;
    }
    if (m.type === "final") {
      const text = (m.text ?? this.partial).trim();
      this.partial = "";
      voiceLog.add("heard", { text });
      if (text) this.h.onFinal(text);
      this.h.onPartial("");
      if (this.state === "transcribing") this.set("listening");
    }
  }

  private set(s: DictateState) {
    if (this.state === s) return;
    this.state = s;
    this.h.onState(s);
  }
}

function micProblem(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked. Allow it for this site (the icon left of the address bar → Microphone → Allow), then reload the page.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this computer.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `The microphone could not be opened: ${(e as Error)?.message ?? name}`;
}
