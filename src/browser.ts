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
