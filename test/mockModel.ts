/**
 * A stand-in language model for tests and the demo. You give it a function that decides the next "turn"
 * (some text and/or tool calls); it answers both the non-streaming and the STREAMING interface, splitting text into
 * word-sized pieces like a real model would.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

export const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

export interface Turn { content: any[]; finishReason: { unified: string; raw: undefined } }

export const call = (name: string, input: unknown): Turn => ({
  content: [{ type: "tool-call", toolCallId: "tc_" + Math.random().toString(36).slice(2, 8), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
});
export const say = (text: string): Turn => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined } });

function toChunks(turn: Turn): any[] {
  const chunks: any[] = [];
  turn.content.forEach((c, i) => {
    if (c.type === "text") {
      const id = "t" + i;
      chunks.push({ type: "text-start", id });
      for (const piece of String(c.text).match(/\S+\s*|\s+/g) ?? []) chunks.push({ type: "text-delta", id, delta: piece });
      chunks.push({ type: "text-end", id });
    } else chunks.push(c);
  });
  chunks.push({ type: "finish", finishReason: turn.finishReason, usage });
  return chunks;
}

export function mockModel(next: (opts: any) => Turn | Promise<Turn>, opts: { delayMs?: number } = {}) {
  return new MockLanguageModelV4({
    doGenerate: async (o: any) => ({ ...(await next(o)), usage, warnings: [] }) as any,
    doStream: async (o: any) => ({ stream: simulateReadableStream({ chunks: toChunks(await next(o)), chunkDelayInMs: opts.delayMs ?? 0 }) }) as any,
  });
}

/** Plays a fixed list of turns in order (the last one repeats). */
export const scripted = (steps: Array<() => Turn>) => { let i = 0; return mockModel(() => steps[Math.min(i++, steps.length - 1)]()); };
