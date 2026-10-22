/**
 * A flight recorder for voice sessions.
 *
 * Voice problems are almost impossible to describe in words - "it cut me off", "it did not hear me" - and nobody can
 * debug from a recording of the room. What settles it is the event stream: when speech started and stopped, what the
 * service transcribed, when a reply began, when it was interrupted, how long the real work took, and every error.
 *
 * Everything is kept in the browser until the person presses Download. Nothing is sent anywhere, and the connection
 * key is never written down.
 */
export interface VoiceLogEntry { t: number; kind: string; data?: Record<string, unknown> }

const MAX = 600;

class VoiceLog {
  private entries: VoiceLogEntry[] = [];
  private t0 = Date.now();
  engine: "realtime" | "classic" | "none" = "none";
  model = "";

  start(engine: "realtime" | "classic", model = "") {
    this.entries = [];
    this.t0 = Date.now();
    this.engine = engine;
    this.model = model;
    this.add("session.start", { engine, model, ua: navigator.userAgent.slice(0, 120) });
  }

  add(kind: string, data?: Record<string, unknown>) {
    if (this.engine === "none") return;
    this.entries.push({ t: Date.now() - this.t0, kind, ...(data && Object.keys(data).length ? { data } : {}) });
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
  }

  /** The numbers that decide whether voice is good: turn-taking, interruption, and how long the work took. */
  private metrics() {
    const at = (k: string) => this.entries.filter((e) => e.kind === k);
    const pairs: number[] = [];
    let lastStop: number | null = null;
    for (const e of this.entries) {
      if (e.kind === "speech.stopped") lastStop = e.t;
      if ((e.kind === "reply.first-audio" || e.kind === "reply.started") && lastStop !== null) {
        pairs.push(e.t - lastStop);
        lastStop = null;
      }
    }
    const round = (n: number) => Math.round(n);
    return {
      turns: at("speech.stopped").length,
      replies: at("reply.started").length,
      interruptions: at("speech.started").filter((e) => (e.data as any)?.whileSpeaking).length,
      errors: at("error").length,
      heard: at("heard").map((e) => String((e.data as any)?.text ?? "")).slice(-12),
      answerDelayMs: pairs.length ? { median: round(pairs.sort((a, b) => a - b)[Math.floor(pairs.length / 2)]), worst: round(Math.max(...pairs)), n: pairs.length } : null,
      workMs: at("work.done").map((e) => (e.data as any)?.ms).filter((n) => typeof n === "number"),
    };
  }

  dump() {
    return {
      recordedAt: new Date().toISOString(),
      engine: this.engine,
      model: this.model,
      metrics: this.metrics(),
      events: this.entries,
    };
  }

  /** Save it next to their downloads, ready to hand over. */
  download() {
    const blob = new Blob([JSON.stringify(this.dump(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `livecrafts-voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async copy(): Promise<boolean> {
    try { await navigator.clipboard.writeText(JSON.stringify(this.dump(), null, 2)); return true; }
    catch { return false; }
  }
}

export const voiceLog = new VoiceLog();
