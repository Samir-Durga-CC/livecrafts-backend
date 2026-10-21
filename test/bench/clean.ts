/**
 * Revert the draft changes a bench run left behind.
 *
 *   npm run bench:clean                 show what is pending on every bench site
 *   npm run bench:clean -- --apply      revert them (newest first)
 *   npm run bench:clean -- --apply --site site_a283e4115cb5
 *
 * A run whose cleanup failed (the site went unreachable mid-run, the process was killed) leaves drafts on the site.
 * They are invisible to visitors, but they make the NEXT run start from different content, which is how a bench
 * quietly stops measuring anything. Run this before trusting a result.
 */
import path from "node:path";
import { config } from "../../src/config.js";
import { JsonStore } from "../../src/store.js";
import { Bridge } from "../../src/bridge.js";
import type { Job, Site } from "../../src/types.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const siteFlag = argv.indexOf("--site");
const onlySite = siteFlag >= 0 ? argv[siteFlag + 1] : undefined;
const jobFlag = argv.indexOf("--job");
/** Only this job's changes. Use it to undo ONE bench run and leave every other draft on the site alone. */
const onlyJob = jobFlag >= 0 ? argv[jobFlag + 1] : undefined;

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const jobs = new JsonStore<Job>(path.join(config.dataDir, "jobs"));

/** Changes this bench made (jobs run with approvalMode "auto" from the bench) that were never reverted. */
const pending = new Map<string, { id: string; pluginId: number; title: string; jobId: string }[]>();
for (const job of jobs.list()) {
  if (onlyJob && job.id !== onlyJob) continue;
  for (const c of job.changes ?? []) {
    if (!c.revert || c.revertedAt) continue;
    if (onlySite && job.siteId !== onlySite) continue;
    const list = pending.get(job.siteId) ?? [];
    list.push({ id: c.id, pluginId: c.pluginId, title: c.title, jobId: job.id });
    pending.set(job.siteId, list);
  }
}

if (!pending.size) { console.log("Nothing pending."); process.exit(0); }

for (const [siteId, list] of pending) {
  const site = sites.get(siteId);
  console.log(`\n${siteId}  ${site?.url ?? "(unknown site)"}  — ${list.length} pending`);
  for (const c of list) console.log(`   ${c.id.padEnd(10)} ${c.title.slice(0, 80)}`);
  if (!apply || !site) continue;

  const bridge = new Bridge(site);
  let done = 0, failed = 0;
  // newest first: a later change to the same target has to come off before an earlier one
  for (const c of [...list].sort((a, b) => b.pluginId - a.pluginId)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await bridge.revert(c.pluginId, "bench-clean");
        const job = jobs.get(c.jobId);
        const rec = job?.changes?.find((x) => x.id === c.id);
        if (job && rec) { rec.revertedAt = new Date().toISOString(); jobs.put(job); }
        done++;
        break;
      } catch (err) {
        if (attempt === 3) { failed++; console.log(`   ✗ ${c.id}: ${(err as Error).message}`); }
        else await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  console.log(`   reverted ${done}/${list.length}${failed ? `, ${failed} failed` : ""}`);
}

if (!apply) console.log("\n(dry run — pass --apply to revert)");
