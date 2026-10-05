/// <reference lib="dom" />
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
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

function sameOrigin(siteUrl: string, url?: string) {
  const s = new URL(siteUrl + "/");
  const u = new URL(url || s.href, s.href);
  if (u.origin !== s.origin) throw new Error(`Only pages on ${s.origin} can be opened.`);
  u.searchParams.set("lcv", String(Date.now())); // never a cached copy
  return u.href;
}

async function openPage(siteUrl: string, url: string | undefined, device: Device) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: DEVICES[device], deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  // The server runs through tsx/esbuild, which wraps named functions in __name(); code sent to the page needs it too.
  await ctx.addInitScript("window.__name = window.__name || ((f) => f);");
  const page = await ctx.newPage();
  const target = sameOrigin(siteUrl, url);
  await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.goto(target, { waitUntil: "load", timeout: 30_000 }));
  // Hosting/CDN bot protection shows a "checking your browser" page to automated browsers - say so, never pretend
  const check = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 600), size: document.body?.innerText.length ?? 0 })).catch(() => null);
  if (check && /just a moment|checking (your|the) browser|verify(ing)? (that )?you are (a )?human|attention required|ddos protection|security check|enable javascript and cookies/i.test(check.title + " " + check.text) && check.size < 3000) {
    await ctx.close();
    throw new Error("BOT_CHECK: the site's bot protection showed a 'checking your browser' page to the server's browser, so it cannot see the page. Ask the person to open the Livecrafts widget on this page (then you look through their own browser), or to allow this computer in their hosting security settings.");
  }
  return { ctx, page };
}

const PROPS = ["color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform", "text-align", "margin", "padding", "border-radius", "display"];

export async function inspectElement(siteUrl: string, a: { url?: string; text?: string; selector?: string; device?: Device }) {
  if (!a.text && !a.selector) throw new Error("Give the visible text of the element (text) or a CSS selector.");
  const { ctx, page } = await openPage(siteUrl, a.url, a.device ?? "desktop");
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
    return { ok: true, url: page.url().replace(/[?&]lcv=\d+/, ""), ...found, howToRead: "computed = what the visitor sees. rules = every CSS rule that sets those properties, in cascade order (later ones win unless !important). Edit the rule in `file` that sets the property." };
  } finally { await ctx.close(); }
}

/**
 * The site's design language, measured on the live page: fonts and sizes per heading level, the colour palette,
 * buttons, container width, spacing, CSS variables and the breakpoints the theme uses. New work should match these.
 */
export async function analyzeDesign(siteUrl: string, a: { url?: string; device?: Device }) {
  const { ctx, page } = await openPage(siteUrl, a.url, a.device ?? "desktop");
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
    return { ok: true, url: page.url().replace(/[?&]lcv=\d+/, ""), ...data, howToUse: "Reuse these fonts, sizes, colours (prefer the CSS variables), radii, spacing and breakpoints so new work looks native to this site." };
  } finally { await ctx.close(); }
}

/** The visible content of a page: title, headings, text, images, links - what a visitor actually reads. */
export async function readPage(siteUrl: string, a: { url?: string; device?: Device }) {
  const { ctx, page } = await openPage(siteUrl, a.url, a.device ?? "desktop");
  try {
    const data = await page.evaluate(() => ({
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 40).map((h) => ({ tag: h.tagName.toLowerCase(), text: (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160) })),
      text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 15000),
      images: Array.from(document.images).slice(0, 30).map((i) => ({ src: i.currentSrc || i.src, alt: i.alt, width: i.naturalWidth, height: i.naturalHeight })),
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, 50).map((l) => ({ text: (l.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60), href: (l as HTMLAnchorElement).href })),
    }));
    return { ok: true, url: page.url().replace(/[?&]lcv=\d+/, ""), ...data };
  } finally { await ctx.close(); }
}

export async function screenshotPage(siteUrl: string, a: { url?: string; selector?: string; text?: string; device?: Device; fullPage?: boolean }) {
  const device = a.device ?? "desktop";
  const { ctx, page } = await openPage(siteUrl, a.url, device);
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
    return { ok: true, screenshotId: id, device, target, url: page.url().replace(/[?&]lcv=\d+/, ""), note: "The screenshot is shown to the person in the chat." };
  } finally { await ctx.close(); }
}

export function screenshotPath(id: string) {
  if (!/^shot_[a-f0-9]+$/.test(id)) return null;
  const f = path.join(config.dataDir, "screens", id + ".png");
  return fs.existsSync(f) ? f : null;
}
