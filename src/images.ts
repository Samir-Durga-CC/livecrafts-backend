import { secrets } from "./secrets.js";
import { log } from "./usage.js";

/**
 * Image generation for featured images and other site pictures: OpenAI's image API, with the same key as the OpenAI
 * models. The image comes back as bytes; the caller stores it and uploads it to the Media Library.
 *
 *   LC_IMAGE_MODEL    image model   (default: chosen from the account's own model list, see imageModelFor)
 *   LC_IMAGE_QUALITY  low | medium | high   (default medium - roughly $0.04 for a landscape image)
 */
const API = "https://api.openai.com/v1";

/**
 * Which image model to call. This was hardcoded to gpt-image-1 until OpenAI shut that model down (2026-10-23), and
 * from that day every image request failed with "The model 'gpt-image-1' does not exist" - the name was fine, the
 * model was gone. The account's model list says what it still serves and when each model will stop, so the choice
 * is read from there: LC_IMAGE_MODEL if it is set, otherwise the first of PREFERRED this account has that is not past
 * its shutdown date. A model due to stop within a month is logged, so the next retirement is a warning in the log
 * rather than an outage. The list is read at most every six hours.
 */
const PREFERRED = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini"];
let chosen: { model: string; at: number } | null = null;

export interface ListedModel { id: string; shutdown_date?: string | null }

/** The pick itself, from the account's model list and today's date - kept apart so it can be tested without OpenAI. */
export function chooseImageModel(list: ListedModel[], today: string): ListedModel | undefined {
  const served = list.filter((m) => !(m.shutdown_date && m.shutdown_date <= today));
  // The preferred names first; failing all of them, the newest plain "gpt-image-N" (no -mini, no named variants).
  return PREFERRED.map((id) => served.find((m) => m.id === id)).find(Boolean)
    ?? served.filter((m) => /^gpt-image-\d+(\.\d+)?$/.test(m.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}

async function imageModelFor(key: string, fetchImpl: typeof fetch): Promise<string> {
  if (process.env.LC_IMAGE_MODEL) return process.env.LC_IMAGE_MODEL;
  if (chosen && Date.now() - chosen.at < 6 * 3600_000) return chosen.model;
  let model = PREFERRED[0];
  try {
    const res = await fetchImpl(`${API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const list: ListedModel[] = res.ok ? (((await res.json()) as any)?.data ?? []) : [];
    const pick = chooseImageModel(list, new Date().toISOString().slice(0, 10));
    if (pick) {
      model = pick.id;
      const days = pick.shutdown_date ? (Date.parse(pick.shutdown_date) - Date.now()) / 86_400_000 : Infinity;
      if (days < 30) log("warn", "the image model is about to be shut down", { model, shutdown: pick.shutdown_date, override: "set LC_IMAGE_MODEL" });
    }
  } catch { /* the list could not be read: the first preferred model is still the best guess */ }
  chosen = { model, at: Date.now() };
  return model;
}
const quality = () => (["low", "medium", "high"].includes(process.env.LC_IMAGE_QUALITY ?? "") ? process.env.LC_IMAGE_QUALITY! : "medium");

export const IMAGE_SIZES = { landscape: "1536x1024", square: "1024x1024", portrait: "1024x1536" } as const;
export type ImageShape = keyof typeof IMAGE_SIZES;

export function imagesAvailable() { return !!secrets.providerKey("openai"); }

export async function generateImage(prompt: string, shape: ImageShape = "landscape", fetchImpl: typeof fetch = fetch): Promise<{ buf: Buffer; mime: string; model: string; revisedPrompt?: string }> {
  const key = secrets.providerKey("openai");
  if (!key) throw new Error("Generating images needs an OpenAI API key (Integrations → AI models → OpenAI). Upload an image or pick one from the Media Library instead.");
  const model = await imageModelFor(key, fetchImpl);
  const res = await fetchImpl(`${API}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: IMAGE_SIZES[shape], quality: quality(), n: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!res.ok) {
    if (/does not exist|not found|deprecated|shut ?down/i.test(String(data?.error?.message ?? ""))) chosen = null; // ask the list again next time
    throw new Error(`Image generation failed (${res.status}) with ${model}: ${data?.error?.message ?? text.slice(0, 300)}`);
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation returned no image.");
  return { buf: Buffer.from(b64, "base64"), mime: "image/png", model, revisedPrompt: data.data[0].revised_prompt };
}
