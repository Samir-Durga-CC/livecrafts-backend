/**
 * Projects, against a real backend process (node server.js) with its own data folder.
 *
 * What must hold: every site has a default project without anyone making one; a site can hold more projects; a
 * session started in a project carries it, and one started without belongs to the default; a project on another site
 * or an archived one is refused; a client lists only the projects of their sites and cannot make or change one; a
 * project's instructions reach the assistant's prompt.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8782;
const B = `http://127.0.0.1:${PORT}`;
const ROOT = "root-key-for-the-projects-test";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "lc-projects-"));

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? "ok " : "FAIL"} ${what}`); if (!cond) failed++; };
const call = async (method: string, p: string, body?: unknown, token = ROOT) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: json };
};

// Two site records, written straight into the data folder (no WordPress needed for these checks).
fs.mkdirSync(path.join(data, "sites"), { recursive: true });
for (const [id, name] of [["site_one", "Site One"], ["site_two", "Site Two"]]) {
  // An unroutable address: the assistant settings read fails at once and the prompt is built without them.
  fs.writeFileSync(path.join(data, "sites", `${id}.json`), JSON.stringify({ id, name, url: `http://127.0.0.1:1/${id}`, username: "u", appPassword: "p", createdAt: new Date().toISOString() }));
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  // LC_MODEL points at nothing that can answer: a started session fails at its first step, which is all these checks need.
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LC_DATA_DIR: data, LC_API_TOKEN: ROOT, LC_VERIFY_CHANGES: "0", LC_MODEL: "custom:none" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; server.stdout.on("data", (d) => (out += d)); server.stderr.on("data", (d) => (out += d));

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/health")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }

  console.log("default projects");
  let s = await call("GET", "/projects");
  const defaults = s.body as any[];
  ok(s.status === 200 && defaults.length === 2 && defaults.every((p) => p.isDefault), "every site has its own project, made on first use");
  ok(defaults.find((p) => p.siteId === "site_one")?.name === "Site One", "the default project is named after the site");

  console.log("more projects on a site");
  s = await call("POST", "/projects", { siteId: "site_one", name: "AMC 2026", description: "Maintenance", instructions: "Every change gets a note for the monthly report.", model: "claudecli:sonnet", approvalMode: "every" });
  const amc = s.body;
  ok(s.status === 201 && amc.id.startsWith("prj_") && amc.instructions && amc.model === "claudecli:sonnet" && amc.approvalMode === "every", "a second project on the same site, with its own settings");
  ok((await call("POST", "/projects", { siteId: "site_one", name: "  " })).status === 400, "a project needs a name");
  ok((await call("POST", "/projects", { siteId: "site_nope", name: "X" })).status === 400, "a project needs a real site");

  console.log("sessions belong to a project");
  s = await call("POST", "/jobs", { siteId: "site_one", projectId: amc.id, prompt: "hello" });
  ok(s.status === 201 && s.body.projectId === amc.id, "a session started in a project carries it");
  s = await call("POST", "/jobs", { siteId: "site_one", prompt: "hello" });
  ok(s.status === 201 && s.body.projectId === defaults.find((p) => p.siteId === "site_one").id, "a session without a project belongs to the site's own");
  ok((await call("POST", "/jobs", { siteId: "site_two", projectId: amc.id, prompt: "hello" })).status === 400, "a project of another site is refused");
  s = await call("GET", "/projects");
  ok((s.body as any[]).find((p) => p.id === amc.id)?.sessions === 1, "the project counts its sessions");

  console.log("instructions in the prompt");
  s = await call("GET", `/admin/prompt?site=site_one&project=${amc.id}`);
  ok(s.status === 200 && s.body.text.includes(`FOR THE PROJECT "AMC 2026"`) && s.body.text.includes("monthly report"), "the project's instructions reach the prompt");

  console.log("archiving");
  ok((await call("PATCH", `/projects/${defaults[0].id}`, { archived: true })).status === 400, "a site's own project cannot be archived");
  s = await call("PATCH", `/projects/${amc.id}`, { archived: true, name: "AMC 2026 (done)" });
  ok(s.status === 200 && s.body.archived === true && s.body.name === "AMC 2026 (done)" && s.body.instructions, "a project is renamed and archived; its settings stay");
  ok(!(await call("GET", "/projects")).body.some((p: any) => p.id === amc.id), "archived projects leave the list");
  ok((await call("GET", "/projects?archived=1")).body.some((p: any) => p.id === amc.id), "and can be listed on purpose");
  ok((await call("POST", "/jobs", { siteId: "site_one", projectId: amc.id, prompt: "hello" })).status === 409, "an archived project takes no new sessions");
  await call("PATCH", `/projects/${amc.id}`, { archived: false });

  console.log("a client");
  const owner = (await call("POST", "/auth/setup", { email: "o@example.com", password: "owner password 1", rootToken: ROOT }, "")).body.token;
  await call("POST", "/admin/accounts", { email: "c@example.com", password: "client password 1", role: "client", siteIds: ["site_two"] }, owner);
  const client = (await call("POST", "/auth/login", { email: "c@example.com", password: "client password 1" }, "")).body.token;
  s = await call("GET", "/projects", undefined, client);
  ok(s.status === 200 && s.body.length === 1 && s.body[0].siteId === "site_two", "a client lists only the projects of their sites");
  ok((await call("POST", "/projects", { siteId: "site_two", name: "Mine" }, client)).status === 403, "a client cannot make a project");
  ok((await call("PATCH", `/projects/${s.body[0].id}`, { name: "Renamed" }, client)).status === 403, "a client cannot change one");
} finally {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) FAILED\n--- server output ---\n${out.slice(-3000)}`); process.exit(1); }
console.log("\nall project checks passed");
