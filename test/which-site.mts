/** Which bench site will actually let the server's browser in today? Bot protection makes timings meaningless. */
import path from "node:path";
import { chromium } from "playwright-core";
import { JsonStore } from "../src/store.js";
import { config } from "../src/config.js";
import { Bridge } from "../src/bridge.js";
import type { Site } from "../src/types.js";
const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ headless: true }));
for (const s of sites.list()) {
  let url = s.url + "/";
  try { const t = await new Bridge(s).previewToken(); url += `?${t.param}=${t.token}`; } catch { /* no token: try plain */ }
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c.newPage();
  const t0 = Date.now();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
  const r = await p.evaluate(() => ({ len: document.body?.innerText.length ?? 0, h1: (document.querySelector("h1")?.textContent ?? "").trim().slice(0, 34) })).catch(() => ({ len: 0, h1: "(no page)" }));
  const blocked = /checking your browser|just a moment|attention required/i.test(r.h1) || r.len < 500;
  console.log(`${blocked ? "BLOCKED" : "ok     "} ${String(Date.now() - t0).padStart(5)}ms  len ${String(r.len).padStart(6)}  ${s.id}  ${s.url}  h1="${r.h1}"`);
  await c.close();
}
await browser.close();
