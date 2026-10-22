/** What vocabulary does each site actually give dictation? If the brand word is not in here, nothing can keep it. */
import path from "node:path";
import { JsonStore } from "../src/store.js";
import { config } from "../src/config.js";
import { Bridge } from "../src/bridge.js";
import { siteWordsFromMap } from "../src/voice.js";
import type { Site } from "../src/types.js";
const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
for (const s of sites.list()) {
  const t = Date.now();
  const map = await new Bridge(s).map({ url: s.url + "/", view: "draft" }).catch((e) => ({ __err: (e as Error).message }) as any);
  if (map?.__err) { console.log(`${s.id}  FAILED after ${Date.now() - t}ms: ${String(map.__err).slice(0, 70)}`); continue; }
  const words = siteWordsFromMap(map);
  console.log(`${s.id}  ${String(Date.now() - t).padStart(6)}ms  ${/aeromatic/i.test(words) ? "HAS AEROMATIC" : "no aeromatic "}  ${words.slice(0, 110)}`);
}
