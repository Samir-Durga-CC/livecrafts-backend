/// <reference lib="dom" />
import type { Check } from "../verify.js";

/**
 * The real-browser checks for a library component - what a careful developer does by dragging the browser window
 * narrower and looking: does anything stick out, do things overlap, is any text covered by something else (a sticky
 * header, a cookie banner, a neighbouring section pulled over it), are buttons big enough to tap, is the text readable.
 *
 * `measureComponent` runs INSIDE the page (it is serialised by Playwright, so it must not use anything outside itself).
 * It is used by the automatic check after place_component (browser.ts / verify.ts) and by the library's own tests,
 * which run every component against hostile theme CSS at 320 / 390 / 768 / 1280 px.
 */
export interface ComponentReport {
  found: boolean;
  count: number;
  /** Things that stick out of their section or the screen. */
  overflow: string[];
  /** Pairs of siblings whose boxes overlap. */
  overlaps: string[];
  /** Text that something outside the component is drawn on top of. */
  covered: string[];
  /** Buttons smaller than 44 x 44 px. */
  smallTargets: string[];
  /** Text smaller than 14px. */
  smallText: string[];
  h1: number;
  imagesWithoutAlt: number;
  /** Sideways scrolling of the whole page, in px. */
  pageOverflowX: number;
  width: number;
  height: number;
}

export function measureComponent(selector: string): ComponentReport {
  const rep: ComponentReport = { found: false, count: 0, overflow: [], overlaps: [], covered: [], smallTargets: [], smallText: [], h1: 0, imagesWithoutAlt: 0, pageOverflowX: 0, width: 0, height: 0 };
  let roots: Element[] = [];
  try { roots = Array.from(document.querySelectorAll(selector)); } catch { return rep; }
  rep.count = roots.length;
  rep.found = roots.length > 0;
  rep.pageOverflowX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  const label = (el: Element | null) => (el ? el.tagName.toLowerCase() + (typeof (el as HTMLElement).className === "string" && (el as HTMLElement).className.trim() ? "." + (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".") : "") : "nothing");
  const shown = (el: Element) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
  const add = (list: string[], text: string) => { if (list.length < 6 && !list.includes(text)) list.push(text); };
  const vw = document.documentElement.clientWidth;

  for (const root of roots) {
    const rr = root.getBoundingClientRect();
    rep.width = Math.round(rr.width);
    rep.height = Math.round(rr.height);
    if (rr.right > vw + 1 || rr.left < -1) add(rep.overflow, `${label(root)} is ${Math.round(Math.max(rr.right - vw, -rr.left))}px outside the screen`);
    if (root.scrollWidth > root.clientWidth + 1) add(rep.overflow, `the content is ${root.scrollWidth}px wide in a ${root.clientWidth}px section`);
    rep.h1 += root.querySelectorAll("h1").length;
    rep.imagesWithoutAlt += root.querySelectorAll("img:not([alt])").length;

    const all = Array.from(root.querySelectorAll("*")).filter((e) => !/^(SCRIPT|STYLE|BR)$/.test(e.tagName) && shown(e));
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right > rr.right + 1 || r.left < rr.left - 1) add(rep.overflow, `${label(el)} sticks out of the section by ${Math.round(Math.max(r.right - rr.right, rr.left - r.left))}px`);
    }
    // siblings that overlap (a card over the next card, text over an image ...)
    for (const parent of [root, ...all]) {
      const kids = Array.from(parent.children).filter((k) => !/^(SCRIPT|STYLE|BR)$/.test(k.tagName) && shown(k));
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) add(rep.overlaps, `${label(kids[i])} overlaps ${label(kids[j])} (${Math.round(w)}x${Math.round(h)}px)`);
      }
    }
    // text that is drawn under something else
    const leaves = all.filter((e) => Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())).slice(0, 30);
    for (const el of leaves) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 40), 1), vw - 1), y = r.top + Math.min(r.height / 2, 10);
      if (y < 0 || y > window.innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (top && !root.contains(top)) add(rep.covered, `“${(el.textContent ?? "").trim().slice(0, 30)}” is covered by ${label(top)}`);
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 14) add(rep.smallText, `${label(el)} text is ${fs}px`);
    }
    for (const el of Array.from(root.querySelectorAll("button, input[type=submit], .lc-btn, .elementor-button, .wp-block-button__link")).filter(shown)) {
      const r = el.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) add(rep.smallTargets, `${label(el)} is ${Math.round(r.width)}x${Math.round(r.height)}px`);
    }
  }
  window.scrollTo(0, 0);
  return rep;
}

/** The report as checks the verifier shows to the model and the person. */
export function componentChecks(r: ComponentReport, device: string): Check[] {
  const name = (n: string) => `component ${n} (${device})`;
  if (!r.found) return [{ name: `component (${device})`, ok: false, detail: "The new section is not on the draft page (nothing matches its class)." }];
  const out: Check[] = [];
  out.push({ name: name("fits"), ok: !r.overflow.length && r.pageOverflowX <= 1, detail: r.overflow.length ? `Content sticks out on ${device}: ${r.overflow.join("; ")}.` : r.pageOverflowX > 1 ? `The page scrolls sideways by ${r.pageOverflowX}px on ${device}.` : `Fits its container on ${device} (${r.width}px wide).` });
  out.push({ name: name("overlap"), ok: !r.overlaps.length, detail: r.overlaps.length ? `Overlapping boxes on ${device}: ${r.overlaps.join("; ")}.` : `Nothing overlaps on ${device}.` });
  out.push({ name: name("covered"), ok: !r.covered.length, detail: r.covered.length ? `Something is drawn on top of the section on ${device}: ${r.covered.join("; ")}. Check headers, banners and negative margins around it.` : `No text is covered on ${device}.` });
  if (r.smallTargets.length) out.push({ name: name("tap size"), ok: false, detail: `Buttons smaller than 44px on ${device}: ${r.smallTargets.join("; ")}.` });
  if (r.smallText.length) out.push({ name: name("text size"), ok: null, detail: `Small text on ${device}: ${r.smallText.join("; ")}.` });
  if (r.h1) out.push({ name: name("headings"), ok: false, detail: "The section contains an h1; the page already has one." });
  if (r.imagesWithoutAlt) out.push({ name: name("images"), ok: false, detail: `${r.imagesWithoutAlt} image(s) without an alt attribute.` });
  return out;
}
