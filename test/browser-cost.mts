/**
 * Where the eleven seconds in make_change go, and what the cheap fixes are worth.
 *
 * Four conditions against the real bench page, timing only the page open:
 *   A  fresh context + networkidle        - exactly what verify.ts does today, 4-5 times per change
 *   B  reused context + networkidle       - the HTTP cache stays warm between loads
 *   C  reused context + domcontentloaded  - stop waiting for analytics and chat widgets to go quiet
 *   D  reused context + dcl + third-party blocked
 */
import { chromium } from "playwright-core";
import path from "node:path";
import { JsonStore } from "../src/store.js";
import { config } from "../src/config.js";
import { Bridge } from "../src/bridge.js";
import type { Site } from "../src/types.js";

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
// Which site to measure against: project-in-progress.com is behind bot protection some days, and a WAF's
// "checking your browser" page is fast to load and tells you nothing. test/which-site.mts says which are open.
const site = sites.get(process.env.BENCH_SITE || "site_93a027a4d4d5")!;
// The draft view needs a preview token; if the plugin cannot be reached right now, the live page measures the
// same thing for timing purposes - say which, so the numbers are not compared across different pages later.
const token = await new Bridge(site).previewToken().catch(() => null);
const url = token ? `${site.url}/?${token.param}=${token.token}` : `${site.url}/`;
console.log(token ? "(draft view, preview token)" : "(live view: the plugin could not be reached for a preview token)");
const origin = new URL(site.url + "/").origin;

const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ headless: true }));
const run = async (label: string, n: number, opts: { fresh: boolean; wait: "networkidle" | "load" | "domcontentloaded"; block?: boolean }) => {
  let ctx = opts.fresh ? null : await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (ctx && opts.block) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = opts.fresh ? await browser.newContext({ viewport: { width: 1280, height: 900 } }) : ctx!;
    if (opts.fresh && opts.block) await c.route("**/*", (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
    const page = await c.newPage();
    const t = Date.now();
    await page.goto(url, { waitUntil: opts.wait, timeout: 30_000 }).catch(() => {});
    await page.evaluate(() => document.body?.innerText.length ?? 0);
    times.push(Date.now() - t);
    await page.close();
    if (opts.fresh) await c.close();
  }
  if (ctx) await ctx.close();
  console.log(`${label.padEnd(44)} ${times.map((t) => String(t).padStart(5)).join(" ")} ms   mean ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`);
};

console.log(`page: ${site.url}\n`);
await run("A fresh context + networkidle  (today)", 3, { fresh: true, wait: "networkidle" });
await run("B reused context + networkidle", 3, { fresh: false, wait: "networkidle" });
await run("C reused context + load", 3, { fresh: false, wait: "load" });
await run("C2 fresh context + load", 3, { fresh: true, wait: "load" });
await run("D reused context + domcontentloaded", 3, { fresh: false, wait: "domcontentloaded" });
await run("E reused + dcl + third-party blocked", 3, { fresh: false, wait: "domcontentloaded", block: true });

/**
 * Speed is only half the question. A page measured too early reports a layout that was never shown, and checks
 * built on that are worse than no checks at all. So the same readings the audit takes - how much text is on the
 * page, how wide it is, how many images have loaded - are compared across the waits. A wait that is fast AND
 * sees the same page is safe to adopt; one that sees less of it is not, however fast it is.
 */
const reading = async (wait: "networkidle" | "load" | "domcontentloaded", settleSelector?: string) => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await c.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  if (wait !== "domcontentloaded") await page.waitForLoadState(wait, { timeout: 20_000 }).catch(() => {});
  if (settleSelector) await page.waitForSelector(settleSelector, { timeout: 3000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    textLen: document.body?.innerText.length ?? 0,
    scrollW: document.documentElement.scrollWidth,
    imgs: document.images.length,
    imgsLoaded: Array.from(document.images).filter((i) => i.complete && i.naturalWidth > 0).length,
    h1: (document.querySelector("h1")?.textContent ?? "").trim().slice(0, 30),
  }));
  await c.close();
  return r;
};
console.log("\nWhat each wait actually SEES (cold context each time):");
for (const w of ["networkidle", "load", "domcontentloaded"] as const) console.log(`  ${w.padEnd(18)}`, JSON.stringify(await reading(w)));
console.log(`  ${"dcl + h1 selector".padEnd(18)}`, JSON.stringify(await reading("domcontentloaded", "h1")));
await browser.close();
