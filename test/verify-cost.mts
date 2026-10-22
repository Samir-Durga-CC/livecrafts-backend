/**
 * What a verification costs now, through the real Verifier, against a real page.
 *
 * `make_change` was 11 seconds of a 27-33 second turn, and almost all of it was here: a before-audit, a main
 * audit, one audit per other screen size one after another, and a live-page fetch - every one of them opening a
 * brand-new browser context with an empty cache. This times the whole thing end to end, twice in a row, because
 * the second run is the one that shows what reusing the context is worth.
 */
import path from "node:path";
import { JsonStore } from "../src/store.js";
import { config } from "../src/config.js";
import { Bridge, htmlToText } from "../src/bridge.js";
import { Verifier } from "../src/verify.js";
import { closeBrowser } from "../src/browser.js";
import type { Site } from "../src/types.js";

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const site = sites.get(process.env.BENCH_SITE || "site_93a027a4d4d5")!;
const bridge = new Bridge(site);
const url = site.url + "/";
console.log(`page: ${url}`);

const v = new Verifier({
  siteUrl: site.url,
  previewToken: async () => (await bridge.previewToken()).token,
  liveText: async (u) => htmlToText(await (await fetch(u, { signal: AbortSignal.timeout(30_000) })).text()),
});

// A text change is the common case: make_change with a kind the verifier can look for on the page.
const change = { kind: "post.field", target: "post_title", payload: { after: "" }, summary: "timing probe" };

for (const pass of [1, 2, 3]) {
  const t0 = Date.now();
  const before = await v.before(url);
  const t1 = Date.now();
  const result = await v.after(url, change, before);
  const t2 = Date.now();
  console.log(`pass ${pass}:  before ${String(t1 - t0).padStart(6)}ms   after ${String(t2 - t1).padStart(6)}ms   total ${String(t2 - t0).padStart(6)}ms   checks ${result.checks.length}${pass === 1 ? "   (first pass pays for the cold cache)" : ""}`);
}
await closeBrowser();
