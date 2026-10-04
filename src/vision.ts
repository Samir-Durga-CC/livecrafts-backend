import fs from "node:fs";
import type { ModelMessage } from "ai";
import type { FileStore } from "./files.js";
import { screenshotPath } from "./browser.js";

/**
 * Lets the model SEE images, without storing image bytes in the saved conversation:
 *  - Saved user messages carry small markers "[[lc-image file_…]]" for attached images.
 *  - Tool results may carry `imageForModel: "shot_…" | "file_…"` (screenshots, viewed images).
 * Right before every model call (prepareStep) the markers become real image parts, and each tool image is shown in a
 * small user message right after that tool result. Only the most recent images are sent, to keep calls fast and cheap.
 */
export const IMAGE_MARKER = /^\[\[lc-image (file_[a-f0-9]+|shot_[a-f0-9]+)\]\]$/;
const VISUAL_TAG = "[[lc-visual]]";
const MAX_USER_IMAGES = 4;
const MAX_TOOL_IMAGES = 3;

export const imageMarker = (id: string) => `[[lc-image ${id}]]`;

type Loaded = { data: Uint8Array; mediaType: string } | { note: string };

export function loadImage(id: string, files: FileStore): Loaded {
  try {
    if (id.startsWith("shot_")) {
      const p = screenshotPath(id);
      if (!p) return { note: `(screenshot ${id} is no longer available)` };
      return { data: new Uint8Array(fs.readFileSync(p)), mediaType: "image/png" };
    }
    const { meta, buf } = files.read(id);
    if (meta.mime === "image/svg+xml") return { note: `(image ${id} is an SVG drawing and cannot be viewed as a picture; its file name is ${meta.filename})` };
    return { data: new Uint8Array(buf), mediaType: meta.mime };
  } catch { return { note: `(image ${id} is no longer available)` }; }
}

const isInjected = (m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "text" && String(m.content[0].text).startsWith(VISUAL_TAG);

function toolImages(m: any): { id: string; caption: string }[] {
  if (m.role !== "tool" || !Array.isArray(m.content)) return [];
  const out: { id: string; caption: string }[] = [];
  for (const p of m.content) {
    const v = p?.type === "tool-result" ? (p.output?.value ?? p.output) : null;
    if (v && typeof v === "object" && typeof v.imageForModel === "string") out.push({ id: v.imageForModel, caption: String(v.imageCaption ?? `Image from ${p.toolName}`) });
  }
  return out;
}

export function hydrateMessages(messages: ModelMessage[], files: FileStore): ModelMessage[] {
  const base = messages.filter((m) => !isInjected(m));

  // Which image OCCURRENCES are recent enough to send as pictures (newest first), keyed "message:part".
  let userBudget = MAX_USER_IMAGES, toolBudget = MAX_TOOL_IMAGES;
  const sendUser = new Set<string>(), sendTool = new Set<string>();
  for (let i = base.length - 1; i >= 0; i--) {
    const m: any = base[i];
    if (m.role === "user" && Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const p = m.content[j];
        if (p?.type === "text" && IMAGE_MARKER.test(String(p.text)) && userBudget > 0) { sendUser.add(`${i}:${j}`); userBudget--; }
      }
    }
    const t = toolImages(m);
    for (let k = t.length - 1; k >= 0; k--) if (toolBudget > 0) { sendTool.add(`${i}:${k}`); toolBudget--; }
  }

  const out: ModelMessage[] = [];
  for (const [i, m0] of base.entries()) {
    const m: any = m0;
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "text" && IMAGE_MARKER.test(String(p.text)))) {
      const content: any[] = [];
      for (const [j, p] of (m.content as any[]).entries()) {
        const id = p?.type === "text" ? String(p.text).match(IMAGE_MARKER)?.[1] : undefined;
        if (!id) { content.push(p); continue; }
        if (!sendUser.has(`${i}:${j}`)) { content.push({ type: "text", text: `(the person attached image ${id} earlier; it was shown to you before)` }); continue; }
        const img = loadImage(id, files);
        content.push({ type: "text", text: `Attached image ${id}:` });
        content.push("note" in img ? { type: "text", text: img.note } : { type: "file", data: { type: "data", data: img.data }, mediaType: img.mediaType });
      }
      out.push({ ...m, content });
      continue;
    }
    out.push(m);
    for (const [k, t] of toolImages(m).entries()) {
      if (!sendTool.has(`${i}:${k}`)) continue;
      const img = loadImage(t.id, files);
      out.push({
        role: "user",
        content: [
          { type: "text", text: `${VISUAL_TAG} ${t.caption} (${t.id}). This is what the tool saw - look at it carefully before you continue.` },
          "note" in img ? { type: "text", text: img.note } : { type: "file", data: { type: "data", data: img.data }, mediaType: img.mediaType },
        ],
      } as ModelMessage);
    }
  }
  return out;
}
