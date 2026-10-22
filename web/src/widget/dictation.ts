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
 * How much of the audio BEFORE the detector believed you is kept.
 *
 * It has to cover the 150ms the detector waits above the bar, the frame it was in the middle of, and the quiet
 * attack of the first word. At 340ms a clean transcript came back 18% wrong, missing "Change the"; 900ms covers it.
 */
const PREROLL_MS = 900;
const PREROLL_FRAMES = Math.ceil((PREROLL_MS / 1000) * RATE / 1024);

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
  private streaming = false;
  private preroll: ArrayBuffer[] = [];
  private partial = "";

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
    this.vad = new Vad({ tick: Math.max(1, Math.round((128 / (this.ctx.sampleRate || RATE)) * 1000)) });
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
    this.streaming = false;
    this.preroll = [];
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
    const edge = this.vad?.push(db);
    if (edge === "start") {
      // Everything held back while the room was quiet, except the last part of a second: that is where the
      // beginning of the first word is, and the detector is always a little late to notice it.
      this.streaming = true;
      for (const f of this.preroll) this.ws?.send(f);
      this.preroll = [];
      this.set("hearing");
    }
    if (edge === "end") {
      // Nothing more goes up until the next sentence starts, so the buffer upstream holds speech and not the room.
      this.streaming = false;
      try { this.ws?.send(JSON.stringify({ type: "commit" })); } catch { /* socket gone */ }
      this.set("transcribing");
    }
  }

  private onPcm(buf: ArrayBuffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.streaming) return void this.ws.send(buf);
    this.preroll.push(buf);
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
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
