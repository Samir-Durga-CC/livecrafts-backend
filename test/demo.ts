/**
 * DEMO MODE - try the chat UI with NO model key and NO real WordPress site:
 *   npm run demo   ->  http://127.0.0.1:8791
 * The fake Livecrafts 0.10 site (test/fakeSite.ts) + a small rule-based stand-in for the model that streams its answers.
 * The real backend, job runner, approvals, drafts, history, streaming and UI all run for real; only the "AI" and the
 * "site" are fake. Try: "change the hero title to Welcome", "change the heading to Hello", "what changed?", "revert it".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-demo-"));
process.env.LC_VERIFY_CHANGES = "0";
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");
const { secrets } = await import("../src/secrets.js");
const { mockModel, call, say } = await import("./mockModel.js");
const { startFakeSite } = await import("./fakeSite.js");

const fake = await startFakeSite();
const textOf = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p: any) => p.text ?? "").join(" "));

const model = mockModel(async ({ prompt }: any) => {
  const user = textOf([...prompt].reverse().find((m: any) => m.role === "user"));
  const lastTool = [...prompt].reverse().find((m: any) => m.role === "tool")?.content?.[0];
  const after = prompt.findLastIndex((m: any) => m.role === "user");
  const ran = prompt.slice(after).filter((m: any) => m.role === "tool").map((m: any) => m.content?.[0]?.toolName);
  const out = lastTool?.output?.value ?? lastTool?.output;
  const wanted = user.match(/\bto\s+["“]?(.+?)["”]?\s*$/i)?.[1];

  if (!ran.length) {
    if (/what changed|history|status/i.test(user)) return call("site_status", {});
    if (/revert|undo/i.test(user)) return call("site_history", { limit: 5 });
    if (wanted && /heading/i.test(user)) return call("make_change", { kind: "el.setting", target: "abc123:title", value: wanted, reason: `Change the Elementor heading to “${wanted}”` });
    if (wanted && /title/i.test(user)) return call("make_change", { kind: "acf.field", target: "field_hero_title", value: wanted, reason: `Change the hero title to “${wanted}”` });
    return call("get_page_map", {});
  }
  const last = ran.at(-1);
  if (last === "make_change") return say(out?.ok === false ? `The site refused: ${out.error}` : `Done - **${out?.change?.summary}**.\n\nIt is a **draft**: you see it on the site, visitors do not until you press **Deploy**. Every change can be reverted in *Changes*.`);
  if (last === "site_status") return say(`**${out?.draftCount ?? 0} draft change(s)** waiting to be deployed.\n\n${(out?.drafts ?? []).flatMap((o: any) => o.changes.map((c: any) => `- #${c.id} ${c.summary} (${c.by ?? c.source})`)).join("\n")}\n\nChanged outside Livecrafts since the last release: ${(out?.outsideChangesSinceRelease ?? []).map((c: any) => `${c.summary} - ${c.by}`).join("; ") || "nothing"}.`);
  if (last === "site_history") { const first = out?.changes?.find((c: any) => c.status !== "discarded"); return first ? call("revert_change", { changeId: first.id, reason: `Revert “${first.summary}”` }) : say("There is nothing to revert."); }
  if (last === "revert_change") return say(out?.ok === false ? `Could not revert: ${out.error}` : `Reverted. ${out?.note ?? ""}`);
  if (last === "get_page_map") return say(`Editable on this page:\n\n${(out?.values ?? []).map((v: any) => `- **${v.label}**: ${v.value}`).join("\n")}\n\nTry *“change the hero title to Welcome”*.`);
  return say("Done.");
}, { delayMs: 25 });

const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const files = new FileStore();
sites.put({ id: "site_demo", name: "Aero (demo)", url: fake.url, username: "admin", appPassword: "demo demo demo", createdAt: new Date().toISOString() });
secrets.setSiteSecret("site_demo", fake.s.secret);
const runner = new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null }));
const port = Number(process.env.DEMO_PORT ?? 8791);
createApp(runner, sites, files).listen(port, "127.0.0.1", () => {
  console.log(`\nLivecrafts DEMO  →  http://127.0.0.1:${port}\n  fake site: ${fake.url}  (add ?lc_preview=<token> to see drafts)\n  try: "change the hero title to Welcome" | "change the heading to Hello" | "what changed?" | "revert it"\n`);
});
