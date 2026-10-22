/**
 * When is someone talking?
 *
 * The detector this replaces measured the room's noise floor ONLY while it believed nobody was talking. In a room
 * whose background sits above the bar that is a trap with no way out: "talking" never ends, so the floor is never
 * updated again, so talking never ends. The person waits, chunk after chunk, and silence gets transcribed into
 * words nobody said - which is exactly what a user reported, a minute of waiting for a sentence in the wrong
 * language.
 *
 * This one keeps a rolling window of the last few seconds and takes a low percentile of it as the floor, WHETHER
 * OR NOT it thinks someone is speaking. Speech is full of short gaps - between words, inside words - so the
 * quietest tenth of a window estimates the room well even mid-sentence, and a floor that is wrong corrects itself
 * within one window instead of never.
 *
 * Measured against real speech (stt-lab/scripts/check-client.mts): it fires 219ms after the first word actually
 * starts, and ends 438ms after the last one, with no mid-sentence cuts.
 */
export class Vad {
  private tick: number;
  private margin: number;
  private startMs: number;
  private endMs: number;
  private size: number;
  private ring: number[] = [];
  private above = 0;
  private below = 0;
  private peak = -99;
  /** The room, and the line speech has to cross - shown in diagnostics, so a bad room can be seen rather than guessed. */
  floor = -60;
  bar = -49;
  speaking = false;

  /**
   * @param tick    ms between readings (how often the worklet reports)
   * @param window  how far back the floor is measured over
   * @param margin  dB above the floor that counts as speech
   * @param startMs this long above the bar = they started
   * @param endMs   this long below it = they finished
   */
  constructor({ tick = 5, window = 3000, margin = 11, startMs = 150, endMs = 600 } = {}) {
    this.tick = tick; this.margin = margin; this.startMs = startMs; this.endMs = endMs;
    this.size = Math.max(50, Math.round(window / tick));
  }

  /** One reading. Returns the edge it crossed - "start", "end" - or "", which is most of the time. */
  push(db: number): "" | "start" | "end" {
    this.ring.push(db);
    if (this.ring.length > this.size) this.ring.shift();
    // The quietest tenth of the window is the room. Sorting a few hundred numbers a few times a second costs
    // nothing, and it is honest: no decay constant to tune, and no state that can get stuck.
    const sorted = [...this.ring].sort((a, b) => a - b);
    this.floor = sorted[Math.floor(sorted.length * 0.1)] ?? -60;
    this.bar = Math.min(-26, Math.max(-55, this.floor + this.margin));

    if (!this.speaking) {
      this.above = db > this.bar ? this.above + this.tick : 0;
      if (this.above >= this.startMs) { this.speaking = true; this.above = 0; this.below = 0; this.peak = db; return "start"; }
      return "";
    }
    this.peak = Math.max(this.peak - 0.02, db);
    // Finished = quiet for this room, OR clearly quieter than this sentence has been. The second test is what
    // works in a room with a fan, where the background alone never drops under the first.
    const quiet = db < this.bar - 3 || db < this.peak - 18;
    this.below = quiet ? this.below + this.tick : 0;
    if (this.below >= this.endMs) { this.speaking = false; this.below = 0; this.peak = -99; return "end"; }
    return "";
  }

  reset() { this.ring = []; this.speaking = false; this.above = 0; this.below = 0; this.peak = -99; }
}
