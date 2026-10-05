import { Bridge, type Patch } from "./bridge.js";
import type { FileStore } from "./files.js";
import { newId } from "./store.js";
import { patchToCss, type ChangeRecord } from "./changes.js";

/**
 * Manual edits from the widget's Quick actions (no AI involved), and the shared "style overlay" used by the agent too.
 *
 * Why this cannot break a site:
 *  - Styles go into the Livecrafts overlay (CSS printed by the plugin, per page or site-wide, per screen size).
 *    No theme file, no PHP, no page-builder data is touched; works the same on Elementor, ACF and any theme;
 *    survives theme updates; removing the overlay restores the original look exactly.
 *  - Text and images are written into the REAL field they come from (the Elementor widget setting or the ACF field),
 *    through the plugin's validated + read-back write. Only plain text that lives in no field falls back to a text overlay.
 *  - Every manual edit is recorded in the change ledger, so it shows in Changes (with a diff) and can be reverted.
 */
export type Device = "all" | "tablet" | "mobile";
export const DEVICE_FIELD: Record<Device, keyof Patch> = { all: "styles", tablet: "styles_tablet", mobile: "styles_mobile" };

const clone = (p: Patch | undefined | null): Patch => JSON.parse(JSON.stringify(p ?? {}));
const norm = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

async function currentPatch(bridge: Bridge, key: string, selector: string, pageUrl?: string) {
  const r = await bridge.getPatches(key === "site" ? { pageKey: "site" } : key ? { pageKey: key } : { url: pageUrl });
  const pageKey = r.pageKey;
  const k = key === "site" ? "site" : pageKey;
  const cur = (k === "site" ? r.site : r.page)?.[selector] ?? null;
  return { key: k, current: cur as Patch | null };
}

export interface StyleArgs { pageUrl?: string; pageKey?: string; scope: "page" | "site"; selector: string; device: Device; styles: Record<string, string> }

/** Merge style changes into the overlay for one selector (empty value = remove that property). Verified by reading back. */
export async function applyStylePatch(bridge: Bridge, a: StyleArgs) {
  const selector = a.selector.trim();
  if (!selector || /[{};<\\,@]|\/\*/.test(selector)) throw new Error("That selector cannot be used (no commas, braces or @ rules - one selector per change).");
  const { key, current } = await currentPatch(bridge, a.scope === "site" ? "site" : a.pageKey ?? "", selector, a.pageUrl);
  const next = clone(current);
  const field = DEVICE_FIELD[a.device] as "styles" | "styles_tablet" | "styles_mobile";
  const block: Record<string, string> = { ...(next[field] ?? {}) };
  for (const [prop, val] of Object.entries(a.styles)) {
    const p = prop.trim().toLowerCase();
    const v = String(val ?? "").replace(/\s*!important\s*$/i, "").trim();
    if (!v) delete block[p]; else block[p] = v;
  }
  if (Object.keys(block).length) next[field] = block; else delete next[field];
  await bridge.savePatch(key, selector, next);
  // read back: the plugin drops properties/values it does not allow - say so instead of pretending
  const { current: saved } = await currentPatch(bridge, key, selector);
  const kept = (saved?.[field] ?? {}) as Record<string, string>;
  const dropped = Object.entries(block).filter(([p, v]) => kept[p] !== v).map(([p]) => p);
  if (JSON.stringify(saved ?? {}) === JSON.stringify(current ?? {})) {
    throw new Error(dropped.length ? `Nothing was saved: ${dropped.join(", ")} cannot be changed with the style layer. Ask the AI agent instead.` : "Nothing changed.");
  }
  return { ok: true, key, selector, device: a.device, previous: current, patch: saved, dropped,
    note: dropped.length ? `Not allowed in the overlay and skipped: ${dropped.join(", ")}.` : "Saved in the Livecrafts style overlay (no theme file touched)." };
}

const describe = (styles: Record<string, string>) => Object.entries(styles).map(([k, v]) => `${k} ${v || "(reset)"}`).join(", ");

function record(title: string, key: string, revert: ChangeRecord["revert"], diff: ChangeRecord["diff"], link?: string, note?: string): ChangeRecord {
  return { id: newId("chg"), tool: "manual", title, key, at: new Date().toISOString(), link, revert, diff, note };
}

export interface ElementorRef { post: number; id: string; widget?: string }
export interface ManualBody {
  kind: "style" | "text" | "image" | "hide" | "show";
  pageUrl: string; pageKey?: string; selector: string; label?: string;
  scope?: "page" | "site"; device?: Device; styles?: Record<string, string>;
  oldText?: string; newText?: string; hasChildren?: boolean;
  elementor?: ElementorRef | null; fileId?: string; imageSrc?: string;
}

/** Apply one manual edit. Returns the ledger record + a one-line summary for the chat. */
export async function applyManual(bridge: Bridge, files: FileStore, b: ManualBody): Promise<{ summary: string; record: ChangeRecord; note?: string }> {
  const where = b.label || b.selector;
  const device: Device = b.device ?? "all";
  const onDevice = device === "all" ? "" : ` on ${device}`;

  if (b.kind === "style" || b.kind === "hide" || b.kind === "show") {
    const styles = b.kind === "hide" ? { display: "none" } : b.kind === "show" ? { display: "" } : b.styles ?? {};
    if (!Object.keys(styles).length) throw new Error("No style changes to save.");
    const r = await applyStylePatch(bridge, { pageUrl: b.pageUrl, pageKey: b.pageKey, scope: b.scope ?? "page", selector: b.selector, device, styles });
    const what = b.kind === "hide" ? "Hide" : b.kind === "show" ? "Show" : "Style";
    const summary = `${what} ${where}${onDevice}${b.kind === "style" ? `: ${describe(styles)}` : ""}${r.key === "site" ? " (all pages)" : ""}`;
    return {
      summary, note: r.dropped.length ? r.note : undefined,
      record: record(summary, `patch:${r.key}:${r.selector}`, { kind: "patch", key: r.key, selector: r.selector, previous: r.previous },
        { label: `Style overlay · ${r.selector}${r.key === "site" ? " (all pages)" : ""}`, language: "css", before: patchToCss(r.selector, r.previous), after: patchToCss(r.selector, r.patch) }, b.pageUrl),
    };
  }

  const map: any = await bridge.map({ url: b.pageUrl });
  const fields: any[] = [...(map.acf ?? []), ...(map.elementor ?? [])];

  if (b.kind === "text") {
    const oldText = String(b.oldText ?? ""), newText = String(b.newText ?? "").trim();
    if (!newText) throw new Error("The new text is empty. To remove the element, use Hide.");
    if (norm(oldText) === norm(newText)) throw new Error("The text did not change.");
    // 1) the exact Elementor widget, 2) an ACF/Elementor field showing exactly this text
    const textLike = (f: any) => ["text", "textarea", "wysiwyg", "html", "url", "email"].includes(f.ftype) && typeof f.value === "string";
    let candidates = fields.filter((f) => textLike(f) && norm(f.value) === norm(oldText));
    if (b.elementor?.id) {
      const inWidget = candidates.filter((f) => f.kind === "el" && String(f.id) === String(b.elementor!.id));
      if (inWidget.length) candidates = inWidget;
    }
    if (candidates.length === 1) {
      const f = candidates[0];
      const previous = String(f.value);
      const isHtml = f.ftype === "wysiwyg" || f.ftype === "html";
      // keep the field's markup: replace the old words inside it when they appear literally, else keep one paragraph
      const value = !isHtml ? newText : previous.includes(oldText.trim()) ? previous.replace(oldText.trim(), escapeHtml(newText)) : `<p>${escapeHtml(newText)}</p>`;
      const res: any = await bridge.setTarget(f.tid, value);
      if (res?.ok === false) throw new Error(res.message ?? "The site did not accept the new text.");
      const summary = `Text of ${where}: “${short(oldText)}” → “${short(newText)}”`;
      return { summary, record: record(summary, `target:${f.tid}`, { kind: "content", target: f.tid, previous }, { label: `${f.kind === "el" ? "Elementor" : "ACF"} · ${f.label}`, before: previous, after: value }, b.pageUrl) };
    }
    if (candidates.length > 1) throw new Error("This text appears in more than one field on the page, so it is not safe to guess which one. Ask the AI agent to change it.");
    // 3) plain text with no field behind it (e.g. typed into a theme template): overlay, only for elements without inner markup
    if (b.hasChildren) throw new Error("This text is not stored in an editable field and contains formatting/links, so a manual overlay could break it. Ask the AI agent - it can edit the template safely.");
    const { key, current } = await currentPatch(bridge, b.pageKey ?? "", b.selector, b.pageUrl);
    const next = { ...clone(current), text: newText };
    await bridge.savePatch(key, b.selector, next);
    const summary = `Text of ${where} (page overlay): “${short(oldText)}” → “${short(newText)}”`;
    return {
      summary, note: "This text is not stored in a field, so it was saved as a page overlay. For a permanent change in the theme, ask the AI agent.",
      record: record(summary, `patch:${key}:${b.selector}`, { kind: "patch", key, selector: b.selector, previous: current }, { label: `Text overlay · ${b.selector}`, before: oldText, after: newText }, b.pageUrl),
    };
  }

  if (b.kind === "image") {
    if (!b.fileId) throw new Error("Choose an image first.");
    const base = (u: string) => decodeURIComponent(u.split("?")[0].split("/").pop() ?? "").replace(/-\d+x\d+(?=\.\w+$)/, "").toLowerCase();
    const images = fields.filter((f) => f.ftype === "image");
    let target = b.elementor?.id ? images.filter((f) => f.kind === "el" && String(f.id) === String(b.elementor!.id)) : [];
    if (!target.length && b.imageSrc) target = images.filter((f) => f.url && base(f.url) === base(b.imageSrc!));
    if (target.length !== 1) throw new Error(target.length ? "This image is used by more than one field. Ask the AI agent to replace it." : "This image is not stored in an editable Elementor/ACF image field (it may be part of the theme). Ask the AI agent to replace it.");
    const f = target[0];
    const { meta, buf } = files.read(b.fileId);
    const media = await bridge.uploadMedia(buf, meta.filename, meta.mime, meta.filename.replace(/\.\w+$/, ""));
    const res: any = await bridge.setTarget(f.tid, String(media.id));
    if (res?.ok === false) throw new Error(res.message ?? "The site did not accept the new image.");
    const summary = `Image of ${where} replaced with ${meta.filename}`;
    return { summary, record: record(summary, `target:${f.tid}`, { kind: "content", target: f.tid, previous: String(f.value ?? "") }, { label: `${f.kind === "el" ? "Elementor" : "ACF"} · ${f.label}`, before: f.url ?? "", after: media.url }, b.pageUrl) };
  }
  throw new Error("Unknown manual edit.");
}

const short = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > 60 ? t.slice(0, 59) + "…" : t; };
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
