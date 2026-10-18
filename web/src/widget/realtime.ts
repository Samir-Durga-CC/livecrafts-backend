import { api } from "../api";

/**
 * Voice through OpenAI's Realtime API: the microphone and the model are joined by WebRTC, and the SERVER decides when
 * a turn has ended.
 *
 * This replaces the part of the old voice mode that kept breaking. There is no level meter here, no threshold, no
 * "has it been quiet for 900 milliseconds": the model listens while it speaks, works out that a sentence has finished
 * from what was actually said, and stops the moment it is talked over.
 *
 * It holds the conversation only. Everything that touches the site goes through one tool, do_on_site, which this
 * class hands to `onRequest` - the Livecrafts agent that already exists, with its tools, approvals, drafts and
 * checks. So the voice stays responsive while a build takes a minute.
 */
export type RealtimeState = "off" | "starting" | "listening" | "hearing" | "thinking" | "speaking";

export interface RealtimeHandlers {
  onState: (s: RealtimeState) => void;
  /** What the person said, once the server has transcribed it. */
  onHeard: (text: string) => void;
  /** What the assistant is saying, as it says it. */
  onSaying: (text: string) => void;
  onError: (message: string) => void;
  /** The browser would not play sound until the person taps once. */
  onBlocked: (blocked: boolean) => void;
  /** do_on_site: run it through the real agent and come back with one short sentence about what happened. */
  onRequest: (request: string) => Promise<string>;
}

const CALLS = "https://api.openai.com/v1/realtime/calls";

export class RealtimeVoice {
  private h: RealtimeHandlers;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private state: RealtimeState = "off";
  /** Microphone level 0..1 for the orb. The server does the listening; this is only so the UI looks alive. */
  levelSink: ((level: number) => void) | null = null;
  private meter = 0;
  private ctx: AudioContext | null = null;
  private saying = "";
  private running = new Set<string>();

  constructor(h: RealtimeHandlers) { this.h = h; }

  get active() { return this.state !== "off"; }

  private set(s: RealtimeState) { if (this.state !== s) { this.state = s; this.h.onState(s); } }

  /** Open the microphone, get a short-lived key from our backend, and connect. */
  async start(opts: { siteId?: string; botName?: string; pageUrl?: string } = {}): Promise<boolean> {
    if (this.state !== "off") return true;
    this.set("starting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      this.set("off");
      this.h.onError(micProblem(e));
      return false;
    }

    let session: { value: string; model: string };
    try {
      session = await api.realtimeSession(opts);
    } catch (e) {
      this.stopTracks();
      this.set("off");
      this.h.onError((e as Error).message);
      return false;
    }

    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      // What the model says comes back as a normal audio track.
      const el = new Audio();
      el.autoplay = true;
      this.audio = el;
      pc.ontrack = (e) => {
        el.srcObject = e.streams[0];
        el.play().catch(() => this.h.onBlocked(true)); // autoplay rules: one tap needed
      };

      for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (e) => { try { this.event(JSON.parse(e.data)); } catch { /* not ours */ } };
      dc.onopen = () => this.set("listening");

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          if (this.state !== "off") this.h.onError("The voice connection dropped. Turn voice on again.");
          this.stop();
        }
      };

      this.startMeter();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(CALLS, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${session.value}`, "Content-Type": "application/sdp" },
      });
      if (!res.ok) throw new Error(`the voice service refused the connection (HTTP ${res.status})`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      return true;
    } catch (e) {
      this.stop();
      this.h.onError(`Voice could not connect: ${(e as Error).message}`);
      return false;
    }
  }

  /** Close everything. */
  stop() {
    this.send({ type: "response.cancel" });
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.dc = null; this.pc = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio = null; }
    this.stopMeter();
    this.stopTracks();
    this.saying = "";
    this.set("off");
  }

  /** The person tapped to allow sound. */
  unblock() { this.audio?.play().then(() => this.h.onBlocked(false)).catch(() => {}); }

  /** Stop talking right now (the orb is also an interrupt button). */
  interrupt() { this.send({ type: "response.cancel" }); this.set("listening"); }
  /** The panel calls this on either engine. */
  stopSpeaking() { this.interrupt(); }
  /** The old engine reports what it is hearing so the panel can explain silence; the server listens for this one. */
  readonly level = { db: 0, threshold: -99, recording: true, heardAt: Date.now() };

  /** Have it say something of ours, in its own voice - used for "this is how fast I'll speak" and the like. */
  say(text: string) {
    if (!text.trim()) return;
    this.send({ type: "response.create", response: { output_modalities: ["audio"], instructions: `Say exactly this, and nothing else: ${text}` } });
  }

  private stopTracks() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }

  /** A small level meter, purely so the orb breathes with the person's voice. */
  private startMeter() {
    if (!this.stream) return;
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.meter = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
        this.levelSink?.(Math.max(0, Math.min(1, (db + 62) / 44)));
      }, 50);
    } catch { /* the orb simply will not pulse */ }
  }

  private stopMeter() {
    if (this.meter) window.clearInterval(this.meter);
    this.meter = 0;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.levelSink?.(0);
  }

  private send(ev: unknown) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(ev));
  }

  /** Everything the server tells us. Only the events that change what the person sees are handled. */
  private event(ev: any) {
    switch (ev?.type) {
      case "input_audio_buffer.speech_started":
        // They started talking - over the answer, if it was still going. The server stops it for us.
        this.saying = "";
        this.set("hearing");
        break;
      case "input_audio_buffer.speech_stopped":
        this.set("thinking");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) this.h.onHeard(String(ev.transcript).trim());
        break;
      case "response.created":
        this.saying = "";
        this.set("thinking");
        break;
      case "response.output_audio_transcript.delta":
        this.saying += String(ev.delta ?? "");
        this.h.onSaying(this.saying);
        this.set("speaking");
        break;
      case "response.output_audio_transcript.done":
        if (ev.transcript) { this.saying = String(ev.transcript); this.h.onSaying(this.saying); }
        break;
      case "response.done":
        void this.finish(ev);
        break;
      case "error":
        this.h.onError(String(ev.error?.message ?? "The voice service reported a problem."));
        break;
    }
  }

  /** A finished turn: if it asked for work, run it and give the answer back so it can report it out loud. */
  private async finish(ev: any) {
    const calls = (ev?.response?.output ?? []).filter((o: any) => o?.type === "function_call");
    if (!calls.length) { if (this.state !== "hearing") this.set("listening"); return; }

    for (const call of calls) {
      if (this.running.has(call.call_id)) continue;
      this.running.add(call.call_id);
      this.set("thinking");
      let result: string;
      try {
        const args = JSON.parse(call.arguments || "{}");
        result = await this.h.onRequest(String(args.request ?? "").trim());
      } catch (e) {
        result = `That did not work: ${(e as Error).message}`;
      } finally {
        this.running.delete(call.call_id);
      }
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ result }) } });
    }
    // Now let it tell them what happened.
    this.send({ type: "response.create" });
  }
}

function micProblem(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError") return "The microphone is blocked. Allow it for this site in the browser's address bar, then turn voice on again.";
  if (name === "NotFoundError") return "No microphone was found. Plug one in or pick one in the system settings.";
  return `The microphone could not be opened: ${(e as Error)?.message ?? e}`;
}
