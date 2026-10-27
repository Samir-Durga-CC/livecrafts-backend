import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import type { PickedElement } from "./element";
import { pickMedia, uploadToMedia } from "./parent";

/**
 * One part of a ready-made section - the heading, a card, the picture, a button - edited on its own.
 *
 * On an Elementor (or blocks) page the whole section is one stored piece of HTML, so a click on any part of it
 * selected the section: content listed every text in it, "Hide" and "Remove" took the whole section away, and there
 * was no way to put a picture in it. Here the clicked element is found in that stored HTML and only it is edited:
 * its words, its link, its picture, or taking it out. Everything else in the section is written back untouched.
 *
 * Like SectionFields, nothing is applied from here: the edited section is handed up (onStage) and goes out with the
 * panel's one Apply.
 */

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const isLeaf = (el: Element) => Array.from(el.children).every((c) => /^(B|STRONG|EM|I|SPAN|BR|SMALL|SUP|SUB)$/.test(c.tagName));

/**
 * The clicked element inside the stored section, or null. The picker's selector was made on the live page, so it
 * may start above the stored markup: it is tried from the section down first, then with its leading steps dropped
 * one by one. A candidate has to be the same tag and carry the same words, so a look-alike is never edited instead.
 */
export function locatePart(root: Element, picked: PickedElement): Element | null {
  const tag = picked.tag.toLowerCase();
  const want = norm(picked.text ?? "").slice(0, 60);
  const fits = (el: Element) => el.tagName.toLowerCase() === tag && (!want || norm(el.textContent ?? "").startsWith(want));
  const steps = picked.selector.split(/\s*>\s*/);
  const tries: string[] = [];
  const at = steps.findIndex((s) => /^section\.lcs\b/.test(s));
  if (at >= 0) tries.push(steps.slice(at).join(" > "));
  for (let i = 0; i < steps.length; i++) tries.push(steps.slice(i).join(" > "));
  for (const t of tries) {
    let hits: Element[] = [];
    try { hits = Array.from(root.querySelectorAll(t)).filter(fits); } catch { continue; }
    if (hits.length === 1) return hits[0];
  }
  // Last: by what it is - same tag, same classes, same words - when exactly one element in the section matches.
  const cls = (picked.classes ?? "").split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c));
  const byKind = Array.from(root.getElementsByTagName(tag)).filter((el) => fits(el) && cls.every((c) => el.classList.contains(c)));
  return byKind.length === 1 ? byKind[0] : null;
}

/** Parse a stored section and find the clicked part in it. */
export function findPart(html: string, picked: PickedElement) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const node = locatePart(doc.body, picked);
  return { doc, node, isRoot: !!node && node.matches("section.lcs") };
}

const LABEL: Array<[RegExp, string]> = [
  [/\blcs-eyebrow\b/, "Label above the heading"], [/\blcs-h\b|\blcs-h2\b/, "Heading"], [/\blcs-h3\b/, "Title"],
  [/\blcs-lead\b/, "Intro"], [/\blcs-ico\b/, "Icon or number"], [/\blcs-btn\b/, "Button"], [/\blcs-media\b/, "Picture"],
  [/\blcs-check\b/, "List point"],
];
export const partName = (el: Element) => {
  const cls = el.getAttribute("class") ?? "";
  for (const [re, l] of LABEL) if (re.test(cls)) return l;
  if (el.tagName === "LI") return "Card";
  if (el.tagName === "IMG" || el.tagName === "FIGURE") return "Picture";
  if (el.tagName === "A") return "Link";
  if (/^H[1-6]$/.test(el.tagName)) return "Heading";
  return "Text";
};

export function SectionPart({ html, picked, disabled, canUpload, onStage, onProblem }: {
  html: string;
  picked: PickedElement;
  disabled: boolean;
  canUpload: boolean;
  onStage: (html: string | undefined) => void;
  onProblem: (message: string) => void;
}) {
  const found = useMemo(() => findPart(html, picked), [html, picked]);
  const node = found.node;
  const link = node ? (node.tagName === "A" ? node : node.closest("a")) : null;
  const imgSlot = node ? (node.tagName === "IMG" ? node : node.matches(".lcs-media, figure") ? node : node.closest(".lcs-media")) : null;
  // Only a part that has words gets a text box: an empty picture frame is a "leaf" too, and offered an empty one.
  const words = (node && isLeaf(node) && node.tagName !== "IMG" && (node.textContent ?? "").trim()) || null;
  const initialHref = link?.getAttribute("href") ?? "";
  const initialImg = imgSlot ? (imgSlot.tagName === "IMG" ? imgSlot.getAttribute("src") : imgSlot.querySelector("img")?.getAttribute("src")) ?? "" : "";

  const [text, setText] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const [image, setImage] = useState<{ url: string; alt: string } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [uploading, setUploading] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Every edit is applied to a fresh copy of the stored section, so undoing one in the field undoes it in the result.
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;
  useEffect(() => {
    if (!node) return;
    const dirty = (text !== null && text !== words) || (href !== null && href !== initialHref) || image !== null || removed;
    if (!dirty) { onStageRef.current(undefined); return; }
    const { doc, node: n } = findPart(html, picked);
    if (!n) return;
    if (removed) n.remove();
    else {
      if (text !== null && text !== words) n.textContent = text;
      const l = n.tagName === "A" ? n : n.closest("a");
      if (l && href !== null && href !== initialHref) l.setAttribute("href", href);
      if (image) {
        const slot = n.tagName === "IMG" ? n : n.matches(".lcs-media, figure") ? n : n.closest(".lcs-media");
        if (slot?.tagName === "IMG") { slot.setAttribute("src", image.url); slot.setAttribute("alt", image.alt); }
        else if (slot) {
          let img = slot.querySelector("img");
          if (!img) { img = doc.createElement("img"); slot.insertBefore(img, slot.firstChild); }
          slot.removeAttribute("aria-hidden"); // an empty frame was decoration; with a real picture it is content
          img.setAttribute("src", image.url);
          img.setAttribute("alt", image.alt);
        }
      }
    }
    onStageRef.current(doc.body.innerHTML);
  }, [text, href, image, removed, html, picked, node, words, initialHref]);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { onProblem("That is not an image file."); return; }
    setUploading(file.name); onProblem("");
    try { const att = await uploadToMedia(file, file.name); setImage({ url: att.url, alt: att.alt || "" }); }
    catch (e) { onProblem(`Upload failed: ${(e as Error).message}`); }
    finally { setUploading(""); }
  }

  if (!node) return <p className="muted small">This part could not be found in the section's stored content. Switch to "Whole section" to edit it there.</p>;
  const shown = image?.url ?? initialImg;
  return (
    <div className={`sf sp${removed ? " sp-removed" : ""}`}>
      <div className="sp-what"><b>{partName(node)}</b><span className="muted"> · only this part changes</span></div>
      {words !== null && (
        <label className={`sf-field${text !== null && text !== words ? " dirty" : ""}`}>
          <span className="ep-label">Text{text !== null && text !== words && <i className="sf-dot" />}</span>
          {(text ?? words).length > 70
            ? <textarea rows={3} value={text ?? words} disabled={disabled || removed} onChange={(e) => setText(e.target.value)} />
            : <input value={text ?? words} disabled={disabled || removed} onChange={(e) => setText(e.target.value)} />}
        </label>
      )}
      {link && (
        <label className={`sf-field${href !== null && href !== initialHref ? " dirty" : ""}`}>
          <span className="ep-label">Link{href !== null && href !== initialHref && <i className="sf-dot" />}</span>
          <input type="url" value={href ?? initialHref} disabled={disabled || removed} placeholder="https://… or /page" onChange={(e) => setHref(e.target.value)} />
        </label>
      )}
      {imgSlot && (
        <div className="ep-img">
          <div className="ep-img-head">
            {shown ? <img className="ep-thumb" src={shown} alt="" /> : <span className="ep-thumb empty"><Icon.Image size={16} /></span>}
            <span className="grow">{shown ? "Picture" : "No picture yet - add one"}{image && <i className="sf-dot" />}{uploading && <small className="ep-img-note">Uploading {uploading}…</small>}</span>
          </div>
          <div className="qa-row">
            {canUpload && <button type="button" className="btn accent sm" disabled={disabled || removed || !!uploading} onClick={() => input.current?.click()}><Icon.Upload size={14} /> Upload</button>}
            <button type="button" className={`btn sm ${canUpload ? "" : "accent"}`} disabled={disabled || removed || !!uploading}
              onClick={async () => { const m = await pickMedia().catch((e) => { onProblem((e as Error).message); return null; }); if (m) setImage({ url: m.url, alt: m.alt || "" }); }}>
              <Icon.Image size={14} /> Library
            </button>
          </div>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      )}
      <button type="button" className={`ep-btn${removed ? "" : " danger"}`} disabled={disabled} onClick={() => setRemoved((r) => !r)}>
        {removed ? "Keep this part" : `Remove this ${partName(node).toLowerCase()} from the section`}
      </button>
      {removed && <p className="muted small">It goes when you apply. The rest of the section stays.</p>}
    </div>
  );
}
