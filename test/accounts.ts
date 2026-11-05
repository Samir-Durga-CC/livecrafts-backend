/**
 * Accounts and the admin panel, against a real backend process (node server.js) with its own data folder.
 *
 * What must hold: the first owner needs the root key on a public backend; a client sees only its own sites and none
 * of the integrations, keys, logs or other people; wrong passwords are throttled; instructions keep every version
 * and reset to the original; a token limit stops new requests; the root key keeps working.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8781;
const B = `http://127.0.0.1:${PORT}`;
const ROOT = "root-key-for-the-accounts-test";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "lc-accounts-"));

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? "ok " : "FAIL"} ${what}`); if (!cond) failed++; };
const call = async (method: string, p: string, body?: unknown, token?: string) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: json };
};

const server = spawn(process.execPath, ["server.js"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LC_DATA_DIR: data, LC_API_TOKEN: ROOT, LC_VERIFY_CHANGES: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; server.stdout.on("data", (d) => (out += d)); server.stderr.on("data", (d) => (out += d));

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/health")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }

  console.log("first owner");
  let s = await call("GET", "/auth/status");
  ok(s.body?.setupNeeded === true && s.body?.rootTokenRequired === true, "a fresh backend asks for the owner, with the root key");
  s = await call("POST", "/auth/setup", { email: "owner@example.com", name: "Owner", password: "correct horse battery" });
  ok(s.status === 401, "setup without the root key is refused");
  s = await call("POST", "/auth/setup", { email: "owner@example.com", name: "Owner", password: "short", rootToken: ROOT });
  ok(s.status === 400, "a short password is refused");
  s = await call("POST", "/auth/setup", { email: "Owner@Example.com", name: "Owner", password: "correct horse battery", rootToken: ROOT });
  const owner = s.body?.token as string;
  ok(s.status === 201 && owner?.startsWith("lcs_") && s.body.account.role === "owner" && !("password" in s.body.account), "setup makes the owner and signs them in; no password hash is sent back");
  ok((await call("POST", "/auth/setup", { email: "x@example.com", password: "correct horse battery", rootToken: ROOT })).status === 409, "a second setup is refused");
  ok((await call("GET", "/sites")).status === 401, "with an account, nothing opens without signing in");
  ok((await call("GET", "/sites", undefined, ROOT)).status === 200, "the root key still works");

  console.log("accounts");
  s = await call("POST", "/admin/accounts", { email: "dev@example.com", name: "Dev", password: "developer password", role: "developer" }, owner);
  ok(s.status === 201 && s.body.role === "developer", "the owner creates a developer");
  // A site record the client is given, written straight into the data folder (no WordPress needed for these checks).
  fs.mkdirSync(path.join(data, "sites"), { recursive: true });
  for (const id of ["site_mine", "site_other"]) fs.writeFileSync(path.join(data, "sites", `${id}.json`), JSON.stringify({ id, name: id, url: `https://${id}.example`, username: "u", appPassword: "p", createdAt: new Date().toISOString() }));
  s = await call("POST", "/admin/accounts", { email: "client@example.com", name: "Client", password: "client password 1", role: "client", siteIds: ["site_mine"], limits: { dailyTokens: 1000 } }, owner);
  const clientId = s.body?.id as string;
  ok(s.status === 201 && s.body.role === "client" && s.body.siteIds[0] === "site_mine" && s.body.limits.dailyTokens === 1000, "the owner creates a client with one site and a daily limit");
  ok((await call("POST", "/admin/accounts", { email: "client@example.com", password: "client password 1" }, owner)).status === 409, "the same email twice is refused");

  const dev = (await call("POST", "/auth/login", { email: "DEV@example.com", password: "developer password" })).body?.token as string;
  const client = (await call("POST", "/auth/login", { email: "client@example.com", password: "client password 1" })).body?.token as string;
  ok(!!dev && !!client, "developer and client sign in (email in any case)");
  ok((await call("GET", "/admin/accounts", undefined, dev)).status === 403, "a developer cannot manage accounts");
  ok((await call("GET", "/admin/overview", undefined, dev)).status === 200, "a developer opens the admin panel");

  console.log("a client sees only their own");
  const sites = (await call("GET", "/sites", undefined, client)).body as any[];
  ok(Array.isArray(sites) && sites.length === 1 && sites[0].id === "site_mine", "a client lists only their site");
  ok((await call("GET", "/sites/site_other/assistant", undefined, client)).status === 404, "another site is unknown to a client");
  ok((await call("GET", "/integrations", undefined, client)).status === 403, "a client gets no integrations (keys)");
  ok((await call("GET", "/admin/overview", undefined, client)).status === 403, "a client gets no admin panel");
  ok((await call("GET", "/admin/logs", undefined, client)).status === 403, "a client gets no logs");
  ok((await call("GET", "/auth/me", undefined, client)).body?.account?.email === "client@example.com", "a client sees their own account");

  console.log("instructions");
  s = await call("PUT", "/auth/instructions", { text: "Always answer in British English." }, client);
  ok(s.body?.text === "Always answer in British English." && s.body.history.length === 2, "saving instructions keeps a version");
  s = await call("POST", "/auth/instructions/reset", undefined, client);
  ok(s.body?.text === "" && s.body.history.length === 3 && s.body.history[1].text === "Always answer in British English.", "reset goes back to the original and keeps the old version");
  await call("PUT", "/auth/instructions", { text: "Keep headings short." }, client);
  s = await call("GET", `/admin/prompt?site=site_mine&account=${clientId}`, undefined, owner);
  ok(s.status === 200 && s.body.text.includes("Keep headings short.") && s.body.text.includes("=== THIS SITE"), "the prompt preview shows the account's instructions after the rules");

  console.log("limits");
  // 1200 tokens today, over the 1000 a day.
  fs.mkdirSync(path.join(data, "usage"), { recursive: true });
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(data, "usage", now.slice(0, 7) + ".jsonl"), JSON.stringify({ at: now, site: "site_mine", job: "job_x", account: clientId, model: "m", step: 1, input: 1000, output: 200, total: 1200 }) + "\n");
  s = await call("POST", "/jobs", { siteId: "site_mine", prompt: "hello" }, client);
  ok(s.status === 429 && /daily limit/.test(s.body?.error), "over the daily limit, a new request is refused with the reason");
  s = await call("GET", "/admin/accounts", undefined, owner);
  ok(s.body.accounts.find((a: any) => a.id === clientId)?.spend.today === 1200, "the owner sees what the client spent today");
  s = await call("GET", "/models/usage", undefined, client);
  ok(s.status === 200 && s.body.totals.total === 1200 && s.body.accounts.length === 0, "a client's usage page shows only their own spend");

  console.log("switching off and passwords");
  await call("PATCH", `/admin/accounts/${clientId}`, { disabled: true }, owner);
  ok((await call("GET", "/auth/me", undefined, client)).status === 401, "a switched-off account is signed out at once");
  ok((await call("POST", "/auth/login", { email: "client@example.com", password: "client password 1" })).status === 403, "and cannot sign in");
  const me = (await call("GET", "/auth/me", undefined, owner)).body.account;
  ok((await call("PATCH", `/admin/accounts/${me.id}`, { role: "developer" }, owner)).status === 409, "the only owner cannot stop being owner");
  for (let i = 0; i < 5; i++) await call("POST", "/auth/login", { email: "dev@example.com", password: "wrong wrong wrong" });
  ok((await call("POST", "/auth/login", { email: "dev@example.com", password: "developer password" })).status === 429, "five wrong passwords make that email wait");
  ok((await call("POST", "/auth/logout", undefined, owner)).status === 200 && (await call("GET", "/auth/me", undefined, owner)).status === 401, "signing out ends the session");
} finally {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) FAILED\n--- server output ---\n${out.slice(-3000)}`); process.exit(1); }
console.log("\nall account checks passed");
