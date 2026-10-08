import { api } from "../api";

/**
 * Hands-free voice for the chat: no button to press, no Enter.
 *
 *   listen    the microphone stays open; a small level detector notices when the person starts talking and when they
 *             have finished (a short pause), then that piece of audio is transcribed and handed over as a message
 *   speak     answers are read aloud sentence by sentence (the first sentence starts while the rest is prepared);
 *             while it speaks the microphone is not recorded (so it never hears itself), but talking over it
 *             interrupts it
 *
 * The backend does the speech work (OpenAI audio, the key stays on the server). Without it, the browser's own speech
 * recognition and voices are used where they exist.
 */
export type VoiceState = "off" | "starting" | "listening" | "hearing" | "transcribing" | "speaking";

export interface VoiceHandlers {
  onState: (s: VoiceState) => void;
  /** Final text of one thing the person said. */
  onUtterance: (text: string) => void;
  onError: (message: string) => void;
  /** The browser refused to play sound until the person taps once (autoplay rules). */
  onBlocked: (blocked: boolean) => void;
}

const TICK = 50;
const START_MS = 150;        // this long above the threshold = they started talking
const END_MS = 900;          // this long quiet after talking = they finished
const MIN_SPEECH_MS = 300;   // shorter = a click or a cough
const MAX_UTTERANCE_MS = 30_000;
const IDLE_SEGMENT_MS = 5_000; // an idle recording is restarted, so little silence is uploaded with the speech (faster)
const BARGE_IN_MS = 280;     // talking this long over the answer interrupts it

interface Segment { rec: MediaRecorder; parts: Blob[]; keep: boolean }

export class VoiceAgent {
  voice = "onyx";
  speakReplies = true;
  /** Mic level 0..1 for the animated orb (set by the UI; called 20 times a second). */
  levelSink: ((level: number) => void) | null = null;

  private h: VoiceHandlers;
  private state: VoiceState = "off";
  private server = true;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private seg: Segment | null = null;
  private timer = 0;
  private noise = -55;
  private above = 0;
  private below = 0;
  private talking = false;
  private talkMs = 0;
  private segMs = 0;
  private transcribing = 0;
  // speaking
  private queue: string[] = [];
  private playing = false;
  private audio: HTMLAudioElement | null = null;
  private finishClip: (() => void) | null = null;
  private abort = new AbortController();
  private prefetched = new Map<string, Promise<Blob>>();
  private idle: (() => void)[] = [];
  private unblockFn: (() => void) | null = null;
  // browser fallback
  private recognition: any = null;

  constructor(h: VoiceHandlers) { this.h = h; }

  get active() { return this.state !== "off"; }

  /** Open the microphone and start listening. false when it could not start (the reason went to onError). */
  async start(serverVoice: boolean): Promise<boolean> {
    if (this.state !== "off") return true;
    this.server = serverVoice;
    this.set("starting");
    if (!serverVoice) return this.startBrowser();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.set("off");
      this.h.onError(micProblem(e));
      return false;
    }
    if (typeof MediaRecorder === "undefined") { this.stop(); this.h.onError("This browser cannot record audio. Use Chrome, Edge or Safari."); return false; }
    this.ctx = new AudioContext();
    await this.ctx.resume().catch(() => {});
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.samples = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.newSegment();
    this.timer = window.setInterval(() => this.tick(), TICK);
    this.set("listening");
    this.chime("start");
    return true;
  }

  /** Close everything: microphone, recordings, sound. */
  stop() {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.stopSpeaking();
    this.endSegment(false);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null; this.analyser = null; this.samples = null;
    try { this.recognition?.abort(); } catch { /* already stopped */ }
    this.recognition = null;
    this.talking = false; this.above = 0; this.below = 0;
    this.set("off");
    this.levelSink?.(0);
    this.flushIdle();
  }

  /** Read text aloud (markdown is cleaned up first). Queued after anything still being said. */
  say(text: string) {
    if (!this.speakReplies || this.state === "off") return;
    const parts = speechChunks(text);
    if (!parts.length) return;
    this.queue.push(...parts);
    if (!this.playing) { this.playing = true; void this.playNext(); }
  }

  /** Stop talking now (the person interrupted, or asked for quiet). */
  stopSpeaking() {
    this.queue = [];
    this.abort.abort();
    this.abort = new AbortController();
    this.prefetched.clear();
    if (this.audio) { this.audio.pause(); this.audio.src = ""; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.finishClip?.();
    this.finishClip = null;
    this.unblockFn = null;
    this.h.onBlocked(false);
  }

  /** Resolves once nothing is being said or waiting to be said (at most maxMs). */
  whenIdle(maxMs = 60_000): Promise<void> {
    if (!this.playing && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => {
      const t = window.setTimeout(resolve, maxMs);
      this.idle.push(() => { window.clearTimeout(t); resolve(); });
    });
  }

  /** The person tapped "turn on sound": play what was waiting. */
  unblock() { const f = this.unblockFn; this.unblockFn = null; this.h.onBlocked(false); f?.(); }

  // ------------------------------------------------------------------ listening

  private set(s: VoiceState) { if (this.state !== s) { this.state = s; this.h.onState(s); } }

  private newSegment() {
    if (!this.stream || this.seg) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m));
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined); }
    catch { rec = new MediaRecorder(this.stream); }
    const seg: Segment = { rec, parts: [], keep: false };
    rec.ondataavailable = (e) => { if (e.data.size) seg.parts.push(e.data); };
    rec.onstop = () => { if (seg.keep && seg.parts.length) void this.transcribe(new Blob(seg.parts, { type: rec.mimeType || mime || "audio/webm" })); };
    rec.start(250);
    this.seg = seg;
    this.segMs = 0;
  }

  private endSegment(keep: boolean) {
    const seg = this.seg;
    this.seg = null;
    if (!seg) return;
    seg.keep = keep;
    try { if (seg.rec.state !== "inactive") seg.rec.stop(); } catch { /* already stopped */ }
  }

  private tick() {
    if (!this.analyser || !this.samples) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    const db = 20 * Math.log10(Math.sqrt(sum / this.samples.length) + 1e-9);
    this.levelSink?.(Math.max(0, Math.min(1, (db + 62) / 44)));

    if (this.state === "speaking") {
      // talking over the answer interrupts it (a stricter bar: the answer itself may leak into the microphone)
      const loud = db > Math.max(this.noise + 24, -34);
      this.above = loud ? this.above + TICK : 0;
      if (this.above >= BARGE_IN_MS) {
        this.stopSpeaking();
        this.newSegment();
        this.talking = true; this.talkMs = this.above; this.below = 0; this.above = 0;
        this.set("hearing");
      }
      return;
    }
    if (!this.seg) return;

    const threshold = Math.min(-26, Math.max(-52, this.noise + 11));
    this.segMs += TICK;
    if (!this.talking) {
      if (db > threshold) {
        this.above += TICK;
        if (this.above >= START_MS) { this.talking = true; this.talkMs = this.above; this.below = 0; this.set("hearing"); }
      } else {
        this.above = 0;
        this.noise = Math.max(-75, Math.min(-35, this.noise * 0.97 + db * 0.03)); // follow the room's background noise
        if (this.segMs > IDLE_SEGMENT_MS) { this.endSegment(false); this.newSegment(); }
      }
      return;
    }
    this.talkMs += TICK;
    this.below = db < threshold - 3 ? this.below + TICK : 0;
    if (this.below >= END_MS || this.talkMs >= MAX_UTTERANCE_MS) {
      const keep = this.talkMs - this.below >= MIN_SPEECH_MS;
      this.talking = false; this.above = 0; this.below = 0;
      this.endSegment(keep);
      this.newSegment();
      this.set(keep ? "transcribing" : "listening");
    }
  }

  private async transcribe(audio: Blob) {
    this.transcribing++;
    try {
      const text = (await api.transcribe(audio)).trim();
      if (text && this.state !== "off") { this.chime("heard"); this.h.onUtterance(text); }
    } catch (e) {
      if (this.state !== "off") this.h.onError((e as Error).message);
    } finally {
      this.transcribing--;
      if (!this.transcribing && this.state === "transcribing") this.set("listening");
    }
  }

  // ------------------------------------------------------------------ speaking

  private async playNext(): Promise<void> {
    // never talk over the person: wait until they finished their sentence (it is being recorded)
    while (this.talking && this.state !== "off") await new Promise((r) => window.setTimeout(r, 150));
    const text = this.queue.shift();
    if (!text || this.state === "off") return this.doneSpeaking();
    this.pauseListening();
    this.set("speaking");
    const signal = this.abort.signal;
    try {
      if (!this.server) await this.speakWithBrowser(text);
      else {
        const clip = await this.fetchSpeech(text, signal);
        if (this.queue[0]) void this.fetchSpeech(this.queue[0], signal).catch(() => {}); // prepare the next sentence meanwhile
        if (signal.aborted) return this.doneSpeaking();
        await this.play(clip);
      }
    } catch (e) {
      if (!signal.aborted && (this.state as VoiceState) !== "off") { this.queue = []; this.h.onError((e as Error).message); } // it may have been stopped meanwhile
    }
    if (signal.aborted && !this.queue.length) return this.doneSpeaking();
    return this.playNext();
  }

  private fetchSpeech(text: string, signal: AbortSignal): Promise<Blob> {
    let p = this.prefetched.get(text);
    if (!p) { p = api.speech(text, this.voice, signal); this.prefetched.set(text, p); }
    void p.finally(() => { if (this.prefetched.get(text) === p) window.setTimeout(() => this.prefetched.delete(text), 30_000); }).catch(() => {});
    return p;
  }

  private play(clip: Blob): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(clip);
      const audio = this.audio ?? (this.audio = new Audio());
      const done = () => { audio.onended = null; audio.onerror = null; URL.revokeObjectURL(url); this.finishClip = null; resolve(); };
      this.finishClip = done;
      audio.onended = done;
      audio.onerror = done;
      audio.src = url;
      audio.play().catch((e) => {
        if ((e as DOMException)?.name === "NotAllowedError") { // autoplay rules: wait for one tap
          this.unblockFn = () => { audio.play().catch(done); };
          this.h.onBlocked(true);
        } else done();
      });
    });
  }

  private doneSpeaking() {
    this.playing = false;
    if (this.state === "speaking") {
      if (this.server) { this.newSegment(); this.set("listening"); }
      else { this.set("listening"); this.listenWithBrowser(); }
    }
    this.flushIdle();
  }

  private pauseListening() {
    if (this.server) { this.endSegment(false); this.talking = false; this.above = 0; }
    else { try { this.recognition?.abort(); } catch { /* fine */ } }
  }

  private flushIdle() { const w = this.idle; this.idle = []; w.forEach((f) => f()); }

  /** Two short soft tones: listening started / I heard you. */
  private chime(kind: "start" | "heard") {
    const ctx = this.ctx;
    if (!ctx) return;
    const tones = kind === "start" ? [660, 880] : [880];
    tones.forEach((hz, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.09;
      o.type = "sine"; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.18);
    });
  }

  // ------------------------------------------------------------------ without the backend: the browser's own speech

  private startBrowser(): boolean {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR || !window.speechSynthesis) {
      this.set("off");
      this.h.onError("Voice needs an OpenAI key on the Livecrafts backend (or a browser with built-in speech recognition, like Chrome).");
      return false;
    }
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = navigator.language || "en-US";
    this.recognition.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) { const t = String(e.results[i][0].transcript).trim(); if (t) this.h.onUtterance(t); }
      }
    };
    this.recognition.onerror = (e: any) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { this.stop(); this.h.onError(micProblem({ name: "NotAllowedError" })); } };
    this.recognition.onend = () => { if (this.state === "listening") this.listenWithBrowser(); };
    this.set("listening");
    this.listenWithBrowser();
    return true;
  }

  private listenWithBrowser() { try { this.recognition?.start(); } catch { /* already listening */ } }

  private speakWithBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const prefer = [/Microsoft (Ryan|Thomas|George).*Natural/i, /Google UK English Male/i, /Daniel/i, /en-GB/i, /^en/i];
      for (const re of prefer) { const v = voices.find((x) => re.test(x.name) || re.test(x.lang)); if (v) { u.voice = v; break; } }
      u.rate = 1.0; u.pitch = 0.95;
      u.onend = () => resolve(); u.onerror = () => resolve();
      this.finishClip = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}

function micProblem(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked. Allow it for this site (the icon left of the address bar → Microphone → Allow), update the Livecrafts plugin to 0.11 or newer, then reload the page.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this computer.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `The microphone could not be opened: ${(e as Error)?.message ?? name}`;
}

/** Markdown -> plain words worth saying (no code, links or symbols). Long answers are cut to their start. */
export function speakable(md: string): string {
  let t = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/[*>|#]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/([.!?:;,])\s*\.(\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 700) {
    const sentences = t.match(/[^.!?]+[.!?]+/g) ?? [t];
    let out = "";
    for (const s of sentences) { if ((out + s).length > 450) break; out += s; }
    t = (out || t.slice(0, 450)).trim() + (/[\u0900-\u097F\u0600-\u06FF\u4e00-\u9fff]/.test(t) ? "" : " The rest is in the chat.");
  }
  return t;
}

/** Speakable text in pieces of one or two sentences: the first one is short, so the voice starts quickly. */
export function speechChunks(md: string): string[] {
  const t = speakable(md);
  if (!t) return [];
  const sentences = (t.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [t]).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    const last = out[out.length - 1];
    if (last && out.length > 1 && (last + " " + s).length <= 240) out[out.length - 1] = last + " " + s;
    else out.push(s);
  }
  return out;
}
