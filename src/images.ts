import { secrets } from "./secrets.js";

/**
 * Image generation for featured images and other site pictures: OpenAI's image API, with the same key as the OpenAI
 * models. The image comes back as bytes; the caller stores it and uploads it to the Media Library.
 *
 *   LC_IMAGE_MODEL    image model   (default gpt-image-1)
 *   LC_IMAGE_QUALITY  low | medium | high   (default medium - roughly $0.04 for a landscape image)
 */
const API = "https://api.openai.com/v1";
const imageModel = () => process.env.LC_IMAGE_MODEL || "gpt-image-1";
const quality = () => (["low", "medium", "high"].includes(process.env.LC_IMAGE_QUALITY ?? "") ? process.env.LC_IMAGE_QUALITY! : "medium");

export const IMAGE_SIZES = { landscape: "1536x1024", square: "1024x1024", portrait: "1024x1536" } as const;
export type ImageShape = keyof typeof IMAGE_SIZES;

export function imagesAvailable() { return !!secrets.providerKey("openai"); }

export async function generateImage(prompt: string, shape: ImageShape = "landscape", fetchImpl: typeof fetch = fetch): Promise<{ buf: Buffer; mime: string; model: string; revisedPrompt?: string }> {
  const key = secrets.providerKey("openai");
  if (!key) throw new Error("Generating images needs an OpenAI API key (Integrations → AI models → OpenAI). Upload an image or pick one from the Media Library instead.");
  const res = await fetchImpl(`${API}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: imageModel(), prompt, size: IMAGE_SIZES[shape], quality: quality(), n: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!res.ok) throw new Error(`Image generation failed (${res.status}): ${data?.error?.message ?? text.slice(0, 300)}`);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation returned no image.");
  return { buf: Buffer.from(b64, "base64"), mime: "image/png", model: imageModel(), revisedPrompt: data.data[0].revised_prompt };
}
