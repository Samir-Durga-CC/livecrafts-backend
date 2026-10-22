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
 *
 * Half a minute, not twelve seconds: this also fires while someone is thinking mid-dictation, and a pause to
 * collect a thought must not be the moment the microphone quietly stops working.
 */
const IDLE_PAUSE_MS = 30_000;
/**
 * Frames recorded before the socket is open, kept rather than dropped.
 *
 * ~43ms of audio a frame (1024 samples at 24kHz), so this is about six seconds - more than the socket and the
 * upstream session have ever taken, and bounded because a queue that only grows is a leak.
 */
const MAX_PENDING_FRAMES = 140;
/**
 * If the backend never says the session is configured, start anyway after this long.
 *
 * The beep means "it is listening", so it waits for the real thing. But a service that never acknowledges must
 * not leave someone staring at "getting ready" with a working microphone in front of them.
 */
const READY_TIMEOUT_MS = 6_000;

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
  /** Which utterance `partial` belongs to: a new one must not be appended to the last one's tail. */
  private partialId = "";
  /** Recorded before the socket opened. Sent in order the moment it does - see onPcm. */
  private pendingPcm: ArrayBuffer[] = [];
  /** The backend has confirmed the speech session is configured and listening. */
  private ready = false;
  private readyTimer: number | null = null;
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
    /**
     * Dictation waits longer for the end of a sentence than the conversation does.
     *
     * Nothing is waiting on the end of a turn here - no agent has to answer, the words just keep arriving in the
     * box - so there is no reason to cut at the first 600ms gap. Someone dictating two or three sentences pauses
     * for breath inside them; a longer wait keeps those as one utterance, which the service also transcribes
     * better, and splitting still happens whenever a pause really is the end.
     */
    this.vad = new Vad({ tick: this.tickMs, endMs: 900 });
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
    // Whatever was recorded while this was connecting goes up first, in order: it is the start of the sentence.
    this.ws.onopen = () => {
      const queued = this.pendingPcm.splice(0);
      voiceLog.add("dictation.open", { queuedFrames: queued.length });
      for (const frame of queued) {
        if (this.ws?.readyState !== WebSocket.OPEN) break;
        this.sent++;
        this.ws.send(frame);
      }
    };
    this.ws.onmessage = (e) => this.fromServer(JSON.parse(e.data));
    this.ws.onerror = () => this.h.onError("The dictation connection failed.");
    this.ws.onclose = () => { if (this.state !== "off") this.h.onError("The dictation connection closed."); };

    voiceLog.start("classic", "dictation/stream");
    /**
     * The beep waits for the speech session, it does not announce the microphone.
     *
     * It used to sound here, the moment the socket object existed - before it had connected and before the
     * speech session upstream had been configured. People trust a beep, so they started talking into a second
     * or two of audio that had nowhere to go, and got back the tail of their own sentence: "ling the".
     *
     * Audio is recorded and held from this moment either way (onPcm), so nothing said early is lost; the beep
     * now means what it says, and `starting` stays on screen until it sounds.
     */
    this.readyTimer = window.setTimeout(() => {
      if (this.state === "starting") { voiceLog.add("dictation.ready-timeout", {}); this.live(); }
    }, READY_TIMEOUT_MS);
    return true;
  }

  /** The session is configured: beep once, and say so on screen. */
  private live() {
    if (this.ready || this.state === "off" || !this.ctx) return;
    this.ready = true;
    if (this.readyTimer) { window.clearTimeout(this.readyTimer); this.readyTimer = null; }
    this.set("listening");
    chime(this.ctx, "start"); // the beep: it is listening NOW, not merely opening
  }

  /** Close everything. Whatever was already written stays in the box. */
  stop() {
    if (this.heard5s) { window.clearTimeout(this.heard5s); this.heard5s = null; }
    if (this.readyTimer) { window.clearTimeout(this.readyTimer); this.readyTimer = null; }
    voiceLog.add("dictation.stop", { framesSent: this.sent, sentences: this.sentences });
    this.quietMs = 0;
    this.partial = "";
    this.partialId = "";
    this.pendingPcm = [];
    this.ready = false;
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
    // Track silence only to pause an idle microphone; it is NOT a gate on sending (see onPcm). Any sound over
    // the room's bar resumes it at once - waiting for the detector's 150ms of confirmed speech would spend the
    // first word of whatever broke the silence.
    const audible = this.vad?.speaking || (this.vad && db > this.vad.bar);
    this.quietMs = audible ? 0 : this.quietMs + (this.tickMs || 5);

    if (edge === "start") {
      voiceLog.add("vad.start", { db: Math.round(db), floor: Math.round(this.vad!.floor), bar: Math.round(this.vad!.bar) });
      if (this.ready) this.set("hearing"); // before the beep the screen keeps saying it is getting ready
    }
    if (edge === "end") {
      // The sentence is over: everything sent since the last commit becomes one utterance. Until the session is
      // configured there is nothing upstream to commit to, and committing an empty buffer is an error.
      if (!this.ready) return;
      this.sentences++;
      voiceLog.add("vad.end", { framesSent: this.sent, sentence: this.sentences, quietMs: this.quietMs });
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
    if (this.quietMs > IDLE_PAUSE_MS) return; // nothing said for a while: stop until there is sound again
    // The socket is still connecting: HOLD the audio. Dropping it threw away the opening words of the first
    // sentence, and a sentence missing its start transcribes as a fragment of itself.
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingPcm.length >= MAX_PENDING_FRAMES) this.pendingPcm.shift();
      this.pendingPcm.push(buf);
      return;
    }
    this.sent++;
    this.ws.send(buf);
  }

  // ---------------------------------------------------------------- the words

  private fromServer(m: { type: string; text?: string; message?: string; model?: string; id?: string }) {
    if (m.type === "error") return this.h.onError(m.message ?? "Dictation failed.");
    if (m.type === "ready") { voiceLog.add("dictation.ready", { model: m.model }); return this.live(); }
    if (m.type === "partial") {
      // Deltas belong to one utterance. When a new one starts, the growing text starts over - appending it to
      // the last utterance's tail is how a finished sentence turns back into a fragment on screen.
      const id = m.id ?? "";
      if (id !== this.partialId) { this.partialId = id; this.partial = ""; }
      this.partial += m.text ?? "";
      this.h.onPartial(this.partial);
      return;
    }
    if (m.type === "final") {
      const sameTurn = !m.id || !this.partialId || m.id === this.partialId;
      const text = (m.text ?? (sameTurn ? this.partial : "")).trim();
      this.partial = "";
      this.partialId = "";
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
