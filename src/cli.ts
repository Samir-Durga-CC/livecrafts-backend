/**
 * Terminal chat for quick testing, no server needed:
 *
 *   npm run chat -- "change the hero title to Welcome"
 *
 * Site comes from env:  LC_SITE_URL, LC_SITE_USER, LC_SITE_APP_PASSWORD   (or --site <id> to use one saved via the HTTP API)
 * Model key:            OPENAI_API_KEY   (model: LC_MODEL)
 */
import path from "node:path";
import readline from "node:readline/promises";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import { FileStore } from "./files.js";
import { buildAgent } from "./agent.js";
import { JobRunner } from "./jobs.js";
import type { Job, Site } from "./types.js";

const args = process.argv.slice(2);
const siteFlag = args.indexOf("--site");
const siteId = siteFlag >= 0 ? args.splice(siteFlag, 2)[1] : undefined;
const prompt = args.join(" ").trim();
if (!prompt) { console.error('Usage: npm run chat -- [--site <id>] "what you want changed"'); process.exit(1); }

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const jobs = new JsonStore<Job>(path.join(config.dataDir, "jobs"));
const runner = new JobRunner(jobs, sites, buildAgent(new FileStore()));

let site = siteId ? sites.get(siteId) : undefined;
if (!site) {
  const { LC_SITE_URL: url, LC_SITE_USER: username, LC_SITE_APP_PASSWORD: appPassword } = process.env;
  if (!url || !username || !appPassword) { console.error("Set LC_SITE_URL, LC_SITE_USER and LC_SITE_APP_PASSWORD (or pass --site <id>)."); process.exit(1); }
  site = sites.put({ id: newId("site"), name: new URL(url).host, url: url.replace(/\/+$/, ""), username, appPassword, createdAt: new Date().toISOString() });
}

const job = runner.create(site.id, prompt);
runner.subscribe(job.id, (e) => {
  if (e.type === "tool_start") console.log(`  → ${e.data.tool} ${JSON.stringify(e.data.input).slice(0, 140)}`);
  if (e.type === "tool_end") console.log(`  ${e.data.ok ? "✓" : "✗"} ${e.data.tool}${e.data.error ? " — " + e.data.error : ""}`);
  if (e.type === "text") console.log(`\n${e.data.text}\n`);
  if (e.type === "error") console.log(`\nERROR: ${e.data.error}`);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const j = await runner.waitUntilSettled(job.id);
  if (j.status === "waiting_approval") {
    for (const p of j.pending as any[]) {
      console.log(`\nAPPROVAL NEEDED: ${p.toolName}`);
      console.log(JSON.stringify(p.input, null, 2));
      if (p.current !== undefined) console.log(`  current value: ${JSON.stringify(p.current)}`);
      const a = (await rl.question("Allow? [y/N] ")).trim().toLowerCase();
      runner.respond(job.id, p.approvalId, a === "y" || a === "yes", a === "y" || a === "yes" ? undefined : "Denied in the terminal");
    }
    continue;
  }
  console.log(`\nJob ${j.id}: ${j.status}${j.error ? " — " + j.error : ""}`);
  break;
}
rl.close();
process.exit(0);
