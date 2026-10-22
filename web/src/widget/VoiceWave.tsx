import { useEffect, useRef } from "react";
import type { VoiceState } from "./voice";

/** Anything that reports a microphone level: the old recorder, or streaming dictation. */
export interface LevelSource { levelSink: ((level: number) => void) | null }

/**
 * The microphone, drawn in the input box: one bar per sample, newest on the right, scrolling left as you talk.
 *
 * It is the only thing on screen that proves the microphone is open and hearing YOU - a label that says "Listening"
 * says the same whether the mic is live or dead. Dictation types into the box a sentence at a time, so without this
 * there are seconds of nothing while you are mid-sentence.
 *
 * The level arrives 20 times a second (VoiceAgent.levelSink). React never re-renders for it: the samples go into a
 * ring buffer and one animation frame writes a CSS variable per bar, so talking costs no renders.
 */
const BARS = 32;

export function VoiceWave({ agent, state }: { agent: LevelSource | null; state: VoiceState }) {
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!agent || !host.current) return;
    const bars = Array.from(host.current.children) as HTMLElement[];
    const level = new Array<number>(BARS).fill(0);
    let fresh = true;
    agent.levelSink = (l) => { level.push(l); level.shift(); fresh = true; };
    let raf = requestAnimationFrame(function draw() {
      raf = requestAnimationFrame(draw);
      if (!fresh) return;
      fresh = false;
      for (let i = 0; i < bars.length; i++) bars[i].style.setProperty("--h", level[i].toFixed(3));
    });
    return () => { cancelAnimationFrame(raf); agent.levelSink = null; };
  }, [agent]);

  return (
    <span ref={host} className={`c-wave ${state}`} role="img"
      aria-label={state === "hearing" ? "Hearing you" : state === "transcribing" ? "Writing that down" : "Listening"}>
      {Array.from({ length: BARS }, (_, i) => <i key={i} />)}
    </span>
  );
}
