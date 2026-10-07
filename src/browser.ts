/// <reference lib="dom" />
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { config } from "./config.js";
import { newId } from "./store.js";

/**
 * A real browser for the agent (headless Edge/Chrome already on the machine via playwright-core - no download).
 *  - inspect: what an element actually looks like (computed styles) AND which CSS rule / file sets each style.
 *    That is how the agent finds the right place to edit instead of guessing or adding overrides.
 *  - screenshot: a picture of the page (or one element) at desktop / tablet / mobile size, shown in the chat.
 * Only URLs on the site's own origin are allowed.
 */
let browserP: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const tries: Array<() => Promise<Browser>> = [];
  if (process.env.LC_BROWSER_PATH) tries.push(() => chromium.launch({ executablePath: process.env.LC_BROWSER_PATH, headless: true }));
  tries.push(() => chromium.launch({ channel: "msedge", headless: true }), () => chromium.launch({ channel: "chrome", headless: true }), () => chromium.launch({ headless: true }));
  let last: unknown;
  for (const t of tries) { try { return await t(); } catch (e) { last = e; } }
  throw new Error("No browser available for page checks. Install Microsoft Edge or Google Chrome, or set LC_BROWSER_PATH. (" + String((last as Error)?.message ?? last).split("\n")[0] + ")");
}

async function getBrowser() {
  if (!browserP) browserP = launch().catch((e) => { browserP = null; throw e; });
  const b = await browserP;
  if (!b.isConnected()) { browserP = null; return getBrowser(); }
  return b;
}

export async function closeBrowser() { if (browserP) { const b = await browserP.catch(() => null); browserP = null; await b?.close().catch(() => {}); } }

export const DEVICES = { desktop: { width: 1366, height: 850 }, tablet: { width: 820, height: 1180 }, mobile: { width: 390, height: 844 } } as const;
export type Device = keyof typeof DEVICES;

function sameOrigin(siteUrl: string, url?: string, preview?: string) {
  const s = new URL(siteUrl + "/");
  const u = new URL(url || s.href, s.href);
  if (u.origin !== s.origin) throw new Error(`Only pages on ${s.origin} can be opened.`);
  u.searchParams.set("lcv", String(Date.now())); // never a cached copy
  if (preview) u.searchParams.set("lc_preview", preview); // the draft view (a short-lived, view-only token from the plugin)
  return u.href;
}

/** Page address without our own parameters (never show a preview token). */
export const cleanUrl = (u: string) => { try { const x = new URL(u); x.searchParams.delete("lcv"); x.searchParams.delete("lc_preview"); return x.href; } catch { return u; } };

/** How a page is looked at: preview = a preview token (draft view); none = as a visitor (live site). */
export interface View { preview?: string }

async function openPage(siteUrl: string, url: string | undefined, device: Device, view: View = {}, before?: (page: Page) => void) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: DEVICES[device], deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  // The server runs through tsx/esbuild, which wraps named functions in __name(); code sent to the page needs it too.
  await ctx.addInitScript("window.__name = window.__name || ((f) => f);");
  const page = await ctx.newPage();
  before?.(page);
  const target = sameOrigin(siteUrl, url, view.preview);
  const response = await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.goto(target, { waitUntil: "load", timeout: 30_000 }));
  const status = response ? response.status() : null;
  // Hosting/CDN bot protection shows a "checking your browser" page to automated browsers - say so, never pretend
  const check = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 600), size: document.body?.innerText.length ?? 0 })).catch(() => null);
  if (check && /just a moment|checking (your|the) browser|verify(ing)? (that )?you are (a )?human|attention required|ddos protection|security check|enable javascript and cookies/i.test(check.title + " " + check.text) && check.size < 3000) {
    await ctx.close();
    throw new Error("BOT_CHECK: the site's bot protection showed a 'checking your browser' page to the server's browser, so it cannot see the page. Ask the person to open the Livecrafts widget on this page (then you look through their own browser), or to allow this computer in their hosting security settings.");
  }
  return { ctx, page, status };
}

const PROPS = ["color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform", "text-align", "margin", "padding", "border-radius", "display"];

export async function inspectElement(siteUrl: string, a: { url?: string; text?: string; selector?: string; device?: Device }, view: View = {}) {
  if (!a.text && !a.selector) throw new Error("Give the visible text of the element (text) or a CSS selector.");
  const { ctx, page } = await openPage(siteUrl, a.url, a.device ?? "desktop", view);
  try {
    const found = await page.evaluate(({ text, selector, PROPS }) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      let els: Element[] = [];
      if (selector) { try { els = Array.from(document.querySelectorAll(selector)); } catch { return { error: "Invalid CSS selector." }; } }
      else if (text) {
        const t = norm(text);
        const all = Array.from(document.body.querySelectorAll("*")).filter((e) => !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(e.tagName));
        els = all.filter((e) => Array.from(e.childNodes).some((n) => n.nodeType === 3 && norm(n.textContent || "").includes(t)));
      }
      const out = els.slice(0, 3).map((el) => {
        const cs = getComputedStyle(el);
        const computed: Record<string, string> = {};
        for (const p of PROPS) computed[p] = cs.getPropertyValue(p);
        const rules: any[] = [];
        const visit = (list: CSSRuleList, sheet: CSSStyleSheet, media?: string) => {
          for (const r of Array.from(list)) {
            if (r instanceof CSSMediaRule) { if (window.matchMedia(r.conditionText).matches) visit(r.cssRules, sheet, r.conditionText); continue; }
            if (!(r instanceof CSSStyleRule)) continue;
            let hit = false; try { hit = el.matches(r.selectorText); } catch { /* unsupported selector */ }
            if (!hit) continue;
            const decl: Record<string, string> = {};
            for (const p of PROPS) { const v = r.style.getPropertyValue(p); if (v) decl[p] = v + (r.style.getPropertyPriority(p) ? " !important" : ""); }
            if (Object.keys(decl).length) rules.push({ selector: r.selectorText, stylesheet: sheet.href || "inline <style> in the page", media: media || undefined, declarations: decl });
          }
        };
        for (const sheet of Array.from(document.styleSheets)) { try { visit(sheet.cssRules, sheet as CSSStyleSheet); } catch { rules.push({ stylesheet: (sheet as CSSStyleSheet).href, note: "cross-origin stylesheet: cannot read its rules" }); } }
        return {
          tag: el.tagName.toLowerCase(), id: el.id || undefined, classes: Array.from(el.classList).join(" ") || undefined,
          text: norm(el.textContent || "").slice(0, 120), inlineStyle: el.getAttribute("style") || undefined, computed, rules,
        };
      });
      return { count: els.length, elements: out };
    }, { text: a.text, selector: a.selector, PROPS });
    if ((found as any).error) return { ok: false, error: (found as any).error };
    // Turn stylesheet URLs into paths the file tools understand (relative to the WordPress folder).
    for (const el of (found as any).elements) for (const r of el.rules) {
      if (typeof r.stylesheet === "string" && r.stylesheet.startsWith(siteUrl + "/")) r.file = r.stylesheet.slice(siteUrl.length + 1).split("?")[0];
    }
    return { ok: true, url: cleanUrl(page.url()), ...found, howToRead: "computed = what the visitor sees. rules = every CSS rule that sets those properties, in cascade order (later ones win unless !important). Edit the rule in `file` that sets the property." };
  } finally { await ctx.close(); }
}

/**
 * The site's design language, measured on the live page: fonts and sizes per heading level, the colour palette,
 * buttons, container width, spacing, CSS variables and the breakpoints the theme uses. New work should match these.
 */
export async function analyzeDesign(siteUrl: string, a: { url?: string; device?: Device }, view: View = {}) {
  const { ctx, page } = await openPage(siteUrl, a.url, a.device ?? "desktop", view);
  try {
    const data = await page.evaluate(() => {
      const cs = (el: Element) => getComputedStyle(el);
      const pick = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = cs(el);
        return { family: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(), size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, letterSpacing: s.letterSpacing, textTransform: s.textTransform };
      };
      const typography: Record<string, unknown> = {};
      for (const t of ["h1", "h2", "h3", "h4", "p", "a", "li", "button"]) typography[t] = pick(t);

      const count = (m: Map<string, number>, k: string) => { if (k && !/rgba\(0, 0, 0, 0\)|transparent/.test(k)) m.set(k, (m.get(k) ?? 0) + 1); };
      const text = new Map<string, number>(), bg = new Map<string, number>(), radius = new Map<string, number>(), gaps = new Map<string, number>();
      const all = Array.from(document.body.querySelectorAll("*")).filter((e) => !e.closest("[data-livecrafts]")).slice(0, 3000);
      for (const el of all) {
        const s = cs(el);
        if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) count(text, s.color);
        count(bg, s.backgroundColor);
        if (s.borderRadius !== "0px") count(radius, s.borderRadius);
        for (const k of ["paddingTop", "paddingBottom"] as const) if (/^(section|header|footer)$/i.test(el.tagName) || /section|container|wrap/i.test(el.className?.toString?.() ?? "")) count(gaps, s[k]);
      }
      const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([v, c]) => ({ value: v, uses: c }));

      const btn = document.querySelector("a.btn, .btn, .button, .wp-block-button__link, .elementor-button, button:not([data-livecrafts] *)");
      const button = btn ? (() => { const s = cs(btn); return { selector: btn.className ? "." + String(btn.className).trim().split(/\s+/).join(".") : btn.tagName.toLowerCase(), background: s.backgroundColor, color: s.color, padding: s.padding, radius: s.borderRadius, font: `${s.fontWeight} ${s.fontSize} ${s.fontFamily.split(",")[0]}`, textTransform: s.textTransform }; })() : null;

      let container = 0;
      for (const el of all) { const s = cs(el); if (s.maxWidth !== "none" && /px$/.test(s.maxWidth)) { const v = parseFloat(s.maxWidth); if (v >= 900 && v <= 1600) { container = v; break; } } }

      const vars: Record<string, string> = {};
      const media = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const r of Array.from(rules)) {
          if (r instanceof CSSMediaRule) { const m = r.conditionText.match(/(max|min)-width:\s*([\d.]+)px/); if (m) media.add(`${m[1]}-width ${m[2]}px`); }
          if (r instanceof CSSStyleRule && /^(:root|html|body)$/.test(r.selectorText.trim())) {
            for (let i = 0; i < r.style.length; i++) { const p = r.style[i]; if (p.startsWith("--") && Object.keys(vars).length < 60) vars[p] = r.style.getPropertyValue(p).trim(); }
          }
        }
      }
      const builder = document.querySelector("[data-elementor-id]") ? "elementor" : document.querySelector(".wp-block-group, .wp-site-blocks") ? "blocks" : "classic theme";
      return {
        builder, typography, textColors: top(text, 6), backgrounds: top(bg, 6), radii: top(radius, 4), sectionSpacing: top(gaps, 4),
        button, containerMaxWidth: container ? container + "px" : null, cssVariables: vars, breakpoints: [...media].slice(0, 12),
      };
    });
    return { ok: true, url: cleanUrl(page.url()), ...data, howToUse: "Reuse these fonts, sizes, colours (prefer the CSS variables), radii, spacing and breakpoints so new work looks native to this site." };
  } finally { await ctx.close(); }
}

/** The visible content of a page: title, headings, text, images, links - what a visitor actually reads. */
export async function readPage(siteUrl: string, a: { url?: string; device?: Device }, view: View = {}) {
  const { ctx, page } = await openPage(siteUrl, a.url, a.device ?? "desktop", view);
  try {
    const data = await page.evaluate(() => ({
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 40).map((h) => ({ tag: h.tagName.toLowerCase(), text: (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160) })),
      text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 15000),
      images: Array.from(document.images).slice(0, 30).map((i) => ({ src: i.currentSrc || i.src, alt: i.alt, width: i.naturalWidth, height: i.naturalHeight })),
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, 50).map((l) => ({ text: (l.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60), href: (l as HTMLAnchorElement).href })),
    }));
    return { ok: true, url: cleanUrl(page.url()), ...data };
  } finally { await ctx.close(); }
}

export async function screenshotPage(siteUrl: string, a: { url?: string; selector?: string; text?: string; device?: Device; fullPage?: boolean }, view: View = {}) {
  const device = a.device ?? "desktop";
  const { ctx, page } = await openPage(siteUrl, a.url, device, view);
  try {
    const dir = path.join(config.dataDir, "screens");
    fs.mkdirSync(dir, { recursive: true });
    const id = newId("shot");
    const file = path.join(dir, id + ".png");
    let target = "page";
    if (a.selector || a.text) {
      const loc = a.selector ? page.locator(a.selector).first() : page.getByText(a.text!, { exact: false }).first();
      if (await loc.count()) { await loc.scrollIntoViewIfNeeded().catch(() => {}); await loc.screenshot({ path: file, timeout: 15_000 }); target = a.selector ?? `text "${a.text}"`; }
      else await page.screenshot({ path: file });
    } else await page.screenshot({ path: file, fullPage: !!a.fullPage });
    return { ok: true, screenshotId: id, device, target, url: cleanUrl(page.url()), note: "The screenshot is shown to the person in the chat." };
  } finally { await ctx.close(); }
}

export function screenshotPath(id: string) {
  if (!/^shot_[a-f0-9]+$/.test(id)) return null;
  const f = path.join(config.dataDir, "screens", id + ".png");
  return fs.existsSync(f) ? f : null;
}

/* ------------------------------------------------------------------ page audits (the automatic checks after a change) */

export interface StyleCheck { prop: string; expected: string; actual: string; ok: boolean | null; note?: string }
export interface PageAudit {
  url: string; device: Device; status: number | null;
  /** A PHP / WordPress fatal error printed on the page. */
  fatal: string | null;
  /** How many pixels the page is wider than the screen (0 = no sideways scrolling). */
  overflowX: number;
  brokenImages: string[];
  consoleErrors: string[];
  /** Visible text, one line per block of text. */
  lines: string[];
  element?: { selector: string; found: boolean; visible?: boolean; text?: string; styles?: StyleCheck[] };
  shot?: Buffer;
}

/**
 * Open a page like a visitor (or with a preview token: like an editor) and measure what matters after a change:
 * does it load, any PHP error, sideways scrolling, broken images, script errors, its text - and optionally one
 * element: does it exist, is it visible, do its computed styles equal the intended values.
 */
export async function auditPage(siteUrl: string, a: { url?: string; device?: Device; selector?: string; declarations?: Record<string, string>; shot?: boolean }, view: View = {}): Promise<PageAudit> {
  const device = a.device ?? "desktop";
  const consoleErrors: string[] = [];
  const { ctx, page, status } = await openPage(siteUrl, a.url, device, view, (p) => {
    p.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < 10) consoleErrors.push(m.text().slice(0, 200)); });
    p.on("pageerror", (e) => { if (consoleErrors.length < 10) consoleErrors.push(String(e.message).slice(0, 200)); });
  });
  try {
    const data = await page.evaluate(({ selector, declarations }) => {
      const body = document.body;
      const text = body ? body.innerText : "";
      const fatal = /(Fatal error|Parse error|There has been a critical error on this website)/i.exec(document.documentElement.innerHTML.slice(0, 400000));
      const broken = Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.closest("[data-livecrafts]")).map((i) => i.currentSrc || i.src).slice(0, 10);
      const overflowX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      let element: any;
      if (selector) {
        let el: Element | null = null;
        try { el = document.querySelector(selector); } catch { el = null; }
        if (!el) element = { selector, found: false };
        else {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const styles: any[] = [];
          if (declarations) {
            // What the intended value computes to, measured on a hidden twin of the element (so "#0b3d91" and
            // "rgb(11, 61, 145)" compare equal). Relative units depend on the element's place: reported, not judged.
            const probe = document.createElement(el.tagName);
            probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0";
            (el.parentElement ?? body).appendChild(probe);
            for (const [prop, value] of Object.entries(declarations)) {
              if (/^(animation|transition)/.test(prop)) continue;
              probe.style.setProperty(prop, value);
              const expected = getComputedStyle(probe).getPropertyValue(prop);
              const actual = cs.getPropertyValue(prop);
              const relative = /(%|em|vw|vh)\b/.test(value) && !/rem\b/.test(value);
              styles.push({ prop, expected, actual, ok: relative ? null : expected === actual, note: relative ? "relative unit: compare by eye" : undefined });
            }
            probe.remove();
          }
          element = { selector, found: true, visible: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden", text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200), styles };
        }
      }
      return { text, fatal: fatal ? fatal[1] : null, broken, overflowX, element };
    }, { selector: a.selector, declarations: a.declarations });
    const shot = a.shot ? await page.screenshot({ fullPage: true, type: "jpeg", quality: 50, timeout: 20_000 }).catch(() => undefined) : undefined;
    return {
      url: cleanUrl(page.url()), device, status, fatal: data.fatal, overflowX: data.overflowX, brokenImages: data.broken, consoleErrors,
      lines: data.text.split(/\n+/).map((l: string) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 2000),
      element: data.element, shot,
    };
  } finally { await ctx.close(); }
}

/**
 * Where two screenshots of the same page differ, as bands of the page height (percent from the top). Pages of
 * different heights are compared on their common width; extra height counts as changed.
 */
export async function compareShots(a: Buffer, b: Buffer): Promise<{ changed: number; bands: Array<{ from: number; to: number }> }> {
  const br = await getBrowser();
  const ctx = await br.newContext();
  try {
    const page = await ctx.newPage();
    return await page.evaluate(async ({ a, b }) => {
      const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("bad image")); i.src = src; });
      const [x, y] = await Promise.all([load(a), load(b)]);
      const W = 160, ROWS = 50;
      const hx = Math.round(x.height * W / x.width), hy = Math.round(y.height * W / y.width), h = Math.max(hx, hy, 1);
      const draw = (img: HTMLImageElement, ih: number) => { const c = document.createElement("canvas"); c.width = W; c.height = h; const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, W, h); g.drawImage(img, 0, 0, W, ih); return g.getImageData(0, 0, W, h).data; };
      const dx = draw(x, hx), dy = draw(y, hy);
      const bandH = Math.max(1, Math.ceil(h / ROWS));
      const bands: Array<{ from: number; to: number }> = [];
      let changedPx = 0;
      for (let r = 0; r < ROWS; r++) {
        let diff = 0, n = 0;
        for (let yy = r * bandH; yy < Math.min(h, (r + 1) * bandH); yy++) for (let xx = 0; xx < W; xx++) {
          const k = (yy * W + xx) * 4; n++;
          if (Math.abs(dx[k] - dy[k]) + Math.abs(dx[k + 1] - dy[k + 1]) + Math.abs(dx[k + 2] - dy[k + 2]) > 60) diff++;
        }
        changedPx += diff;
        if (n && diff / n > 0.01) {
          const from = Math.round((r * bandH) / h * 100), to = Math.round(Math.min(h, (r + 1) * bandH) / h * 100);
          const last = bands[bands.length - 1];
          if (last && last.to >= from) last.to = to; else bands.push({ from, to });
        }
      }
      return { changed: Math.round(changedPx / (W * h) * 1000) / 10, bands };
    }, { a: "data:image/jpeg;base64," + a.toString("base64"), b: "data:image/jpeg;base64," + b.toString("base64") });
  } finally { await ctx.close(); }
}
