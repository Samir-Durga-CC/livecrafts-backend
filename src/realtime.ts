import { secrets } from "./secrets.js";
import { sttLanguage, transcriptionPrompt } from "./voice.js";

/**
 * Voice through OpenAI's Realtime API: the person and the model talk to each other directly over WebRTC.
 *
 * WHY: the old voice mode decides for itself when a sentence has ended, by watching the microphone level. That is the
 * part that kept breaking - it waited thirty seconds, or cut a sentence in half, or would not hear "yes" over its own
 * answer. The Realtime API does turn-taking on the server, listens while it speaks, and stops the moment it is
 * interrupted. We stop guessing.
 *
 * WHAT IT DOES AND DOES NOT DO: the realtime model only holds the CONVERSATION. It gets one tool - do_on_site - which
 * hands the request to the Livecrafts agent that already exists, with its thirty tools, approvals, drafts and checks.
 * So the voice stays responsive while a build takes a minute, and nothing about how the site is edited changes.
 *
 * The browser never sees the API key: it gets a short-lived client secret minted here.
 *
 *   LC_REALTIME_MODEL   default gpt-realtime-2.1
 *   LC_REALTIME_VOICE   default marin
 */
const API = "https://api.openai.com/v1";
export const realtimeModel = () => process.env.LC_REALTIME_MODEL || "gpt-realtime-2.1";
export const realtimeVoice = () => process.env.LC_REALTIME_VOICE || "marin";

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes((value ?? "").trim()) ? ((value as string).trim() as T) : fallback;

/**
 * How the service decides a turn has ended, and how much it cleans up the microphone first. These are the three
 * settings that decide whether voice feels right, so they are all changeable without a rebuild:
 *
 *   LC_REALTIME_VAD        semantic (default) | server
 *   LC_REALTIME_EAGERNESS  auto (default) | low | medium | high   - semantic only; low lets people think mid-sentence
 *   LC_REALTIME_SILENCE_MS how long a pause ends a turn           - server only (default 600)
 *   LC_REALTIME_THRESHOLD  how loud speech must be, 0-1           - server only (default 0.5)
 *   LC_REALTIME_NOISE      near_field (default) | far_field | off - a headset is near, a laptop mic is far
 */
export function audioInput(opts: { siteWords?: string } = {}) {
  const server = pick(process.env.LC_REALTIME_VAD, ["semantic", "server"] as const, "semantic") === "server";
  const turn_detection = server
    ? {
        type: "server_vad",
        threshold: Math.min(1, Math.max(0, Number(process.env.LC_REALTIME_THRESHOLD ?? 0.5) || 0.5)),
        prefix_padding_ms: 300,
        silence_duration_ms: Math.max(200, Number(process.env.LC_REALTIME_SILENCE_MS ?? 600) || 600),
        // Answer by itself when a turn ends, and stop talking the moment they start. Without these two the model
        // reads a long answer to the end while the person is already talking over it.
        create_response: true,
        interrupt_response: true,
      }
    : {
        type: "semantic_vad",
        eagerness: pick(process.env.LC_REALTIME_EAGERNESS, ["auto", "low", "medium", "high"] as const, "auto"),
        create_response: true,
        interrupt_response: true,
      };

  const noise = pick(process.env.LC_REALTIME_NOISE, ["near_field", "far_field", "off"] as const, "near_field");
  return {
    turn_detection,
    // Cleaned up BEFORE turn detection sees it, so a noisy room produces fewer false starts and better words.
    ...(noise === "off" ? {} : { noise_reduction: { type: noise } }),
    // The same vocabulary hint and language the Classic path gives the transcriber (voice.ts). Without them this
    // engine hears "AEROMATIC" as "aromatic" and the edit is aimed at nothing.
    transcription: {
      model: process.env.LC_STT_MODEL || "gpt-4o-transcribe",
      prompt: transcriptionPrompt(opts.siteWords ?? ""),
      ...(sttLanguage() ? { language: sttLanguage() } : {}),
    },
  };
}

/** What the person says goes to this one tool; everything the site can do is behind it. */
export const DO_ON_SITE = {
  type: "function" as const,
  name: "do_on_site",
  description:
    "Do something on the person's website, or answer a question about it: change text, add or remove a section, " +
    "build a page, check how it looks, undo a change. Pass what they asked for in their own words. " +
    "The work takes time - say one short line first so they know you are on it, then call this.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "What they asked for, in their own words, as a complete instruction." },
    },
    required: ["request"],
  },
};

/** How the voice behaves. Short, spoken, and never pretending the work is done before it is. */
export function instructions(opts: { botName?: string; siteName?: string; pageUrl?: string; siteWords?: string } = {}) {
  const name = opts.botName?.trim() || "Livecrafts";
  return [
    `You are ${name}, the voice of a website editor. The person is looking at their own site and talking to you.`,
    "",
    "HOW YOU SPEAK",
    "- One or two short sentences. No lists, no URLs, no code, no markdown. This is speech, not a document.",
    "- Answer in the language they used (Hindi in Hindi, Hinglish in Hinglish, English in English).",
    "- Warm and matter-of-fact, at the pace of a colleague. Never gushing.",
    "",
    "HOW YOU WORK",
    "- Anything that touches the site - changing words, adding or removing a section, building a page, checking how it",
    "  looks, undoing something - goes through do_on_site. You never do it yourself and never guess the result.",
    "- Before calling it, say ONE short line so they know you heard ('Right, adding that now').",
    "- The call can take a minute. When it comes back, say what actually happened in one sentence.",
    "- NEVER say something is done, added, changed or checked until do_on_site has come back and said so.",
    "- If they interrupt you, stop and listen. They are allowed to change their mind mid-sentence.",
    "",
    "WHAT YOU DECIDE YOURSELF",
    "- Colour, spacing, layout, which template: never ask. The editor takes those from the site.",
    "- Ask only for facts you cannot know: the exact words, a phone number, which page they mean. One question at a time,",
    "  because this is a conversation - not a form.",
    opts.siteName ? `\nThe site is "${opts.siteName}".` : "",
    opts.pageUrl ? `They are looking at: ${opts.pageUrl}` : "",
  ].join("\n");
}

export interface RealtimeSession { value: string; expiresAt?: number; model: string; voice: string; tuning?: Record<string, unknown> }

/**
 * A client secret the browser can use for ONE realtime call. Short-lived by design: if it leaks it is worthless in
 * minutes, and it can never be used for anything but a realtime session.
 */
export async function createSession(opts: { botName?: string; siteName?: string; pageUrl?: string; siteWords?: string } = {}): Promise<RealtimeSession> {
  const key = secrets.providerKey("openai");
  if (!key) throw Object.assign(new Error("Realtime voice needs an OpenAI API key (Integrations → AI models → OpenAI)."), { status: 503 });

  const body = {
    session: {
      type: "realtime",
      model: realtimeModel(),
      instructions: instructions(opts),
      tools: [DO_ON_SITE],
      tool_choice: "auto",
      // The server decides when a turn has ended, from the meaning of what was said - not from how loud the room is.
      // That, and being interrupted properly, is the reason to use the Realtime API at all.
      audio: { input: audioInput({ siteWords: opts.siteWords }), output: { voice: realtimeVoice() } },
    },
  };

  const res = await fetch(`${API}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
    const friendly = res.status === 401 ? "the OpenAI key was rejected"
      : res.status === 403 ? "this OpenAI account cannot use the Realtime API yet"
      : res.status === 429 ? "OpenAI refused for rate-limit or billing reasons"
      : msg || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Realtime voice could not start: ${friendly}`), { status: res.status === 429 ? 429 : 502 });
  }

  const j = (await res.json()) as any;
  const value = j?.value ?? j?.client_secret?.value;
  if (!value) throw Object.assign(new Error("OpenAI returned no client secret for the realtime session."), { status: 502 });
  const input = audioInput({ siteWords: opts.siteWords });
  return {
    value, expiresAt: j?.expires_at, model: realtimeModel(), voice: realtimeVoice(),
    // Echoed back so a saved voice log says which settings produced it.
    tuning: { turnDetection: input.turn_detection, noiseReduction: (input as any).noise_reduction?.type ?? "off",
      language: sttLanguage() || "auto", siteWords: (opts.siteWords ?? "").slice(0, 200) },
  };
}

/** Whether realtime voice can be offered at all (the Integrations screen and the widget ask this). */
export const realtimeAvailable = () => !!secrets.providerKey("openai");
