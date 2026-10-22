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
const site = sites.get("site_a283e4115cb5")!;
const token = await new Bridge(site).previewToken();
const url = `${site.url}/?${token.param}=${token.token}`;
const origin = new URL(site.url + "/").origin;

const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ headless: true }));
const run = async (label: string, n: number, opts: { fresh: boolean; wait: "networkidle" | "domcontentloaded"; block?: boolean }) => {
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
await run("C reused context + domcontentloaded", 3, { fresh: false, wait: "domcontentloaded" });
await run("D reused + dcl + third-party blocked", 3, { fresh: false, wait: "domcontentloaded", block: true });
await browser.close();
