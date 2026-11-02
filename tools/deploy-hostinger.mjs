/**
 * Deploy the backend to a Hostinger Node.js website.
 *
 *   node tools/deploy-hostinger.mjs --domain livecrafts-staging.project-in-progress.com
 *
 * What it ships is the COMMITTED tree at HEAD (`git archive`): no node_modules, no data/, no .env, nothing
 * uncommitted. Hostinger installs the dependencies, runs `npm run build` (the chat UI into web/dist) and starts
 * `node server.js`. The build settings are sent with every build, so a deploy never depends on Hostinger guessing
 * what kind of app this is.
 *
 * Settings and secrets (LC_API_TOKEN, model keys, LC_DATA_DIR ...) are NOT part of a deploy: they live in the
 * website's environment variables in hPanel, and survive every deploy.
 *
 * Needs HOSTINGER_API_TOKEN (an hPanel API token) and HOSTINGER_USERNAME (the hosting account, u123456789).
 * Exits non-zero when the upload, the build or the health check after it fails - so CI shows a red run.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://developers.hostinger.com";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const die = (msg) => { console.error(msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const domain = arg("domain", process.env.LC_DEPLOY_DOMAIN);
const token = process.env.HOSTINGER_API_TOKEN;
const username = process.env.HOSTINGER_USERNAME;
if (!domain) die("--domain (or LC_DEPLOY_DOMAIN) is required.");
if (!token || !username) die("HOSTINGER_API_TOKEN and HOSTINGER_USERNAME are both required.");

const BUILD = {
  node_version: 22,
  app_type: "express",
  entry_file: "server.js",
  build_script: "build",
  package_manager: "npm",
};

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) die(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const site = `/api/hosting/v1/accounts/${username}/websites/${domain}`;

// 1. The archive: exactly what is committed.
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPO, encoding: "utf8" }).trim();
if (dirty) console.warn("Note: uncommitted changes are NOT deployed - only the commit " + sha + ".");
const name = `livecrafts-backend-${sha}.zip`;
const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lc-deploy-")), name);
execFileSync("git", ["archive", "--format=zip", "-o", archive, "HEAD"], { cwd: REPO });
const bytes = fs.readFileSync(archive);
console.log(`Deploying ${sha} to ${domain} (${(bytes.length / 1024).toFixed(0)} KB)`);

// 2. Upload it into the website's root (TUS: create, then send the bytes).
const creds = await api("POST", "/api/hosting/v1/files/upload-urls", { username, domain });
const up = { url: creds.url ?? creds.data?.url, auth: creds.auth_key ?? creds.data?.auth_key, rest: creds.rest_auth_key ?? creds.data?.rest_auth_key };
if (!up.url || !up.auth || !up.rest) die("Hostinger did not return upload credentials.");
const target = `${up.url}/${encodeURIComponent(name)}?override=true`;
const tus = { "X-Auth": up.auth, "X-Auth-Rest": up.rest, "Tus-Resumable": "1.0.0" };
const create = await fetch(target, { method: "POST", headers: { ...tus, "Upload-Length": String(bytes.length), "Upload-Offset": "0" } });
if (create.status !== 201) die(`Could not start the upload (HTTP ${create.status}): ${(await create.text()).slice(0, 200)}`);
const send = await fetch(target, { method: "PATCH", headers: { ...tus, "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" }, body: bytes });
if (send.status !== 204) die(`Could not upload the archive (HTTP ${send.status}): ${(await send.text()).slice(0, 200)}`);
console.log("  uploaded " + name);

// 3. Build it, with our settings stored too (Git auto-deploys in hPanel use the stored ones).
await api("PUT", `${site}/nodejs/builds/settings`, BUILD);
const started = await api("POST", `${site}/nodejs/builds`, { ...BUILD, source_type: "archive", source_options: { archive_path: name } });
const uuid = started?.uuid ?? started?.data?.uuid;
console.log("  build started" + (uuid ? " " + uuid : ""));

// 4. Wait for it. A build is install + `npm run build`, a few minutes at most.
let state = "", build;
for (let i = 0; i < 80 && !["completed", "failed", "error", "canceled"].includes(state); i++) {
  await sleep(15_000);
  const list = await api("GET", `${site}/nodejs/builds`);
  build = (list?.data ?? list ?? []).find((b) => !uuid || b.uuid === uuid);
  if (build?.state !== state) console.log("  build " + (state = build?.state ?? "unknown"));
}
if (state !== "completed") {
  if (build?.uuid) {
    const logs = await api("GET", `${site}/nodejs/builds/${build.uuid}/logs`).catch(() => null);
    console.error(typeof logs === "string" ? logs.slice(-4000) : JSON.stringify(logs)?.slice(-4000));
  }
  die(`The build did not complete (${state || "timed out"}).`);
}

// 5. Is it answering? The app restarts after the build; give it a moment.
for (let i = 0; i < 12; i++) {
  try {
    const res = await fetch(`https://${domain}/health`, { headers: { Accept: "application/json" } });
    const body = await res.text();
    if (res.ok && body.includes('"ok":true')) { console.log(`Done. https://${domain}/health -> ${body}`); process.exit(0); }
  } catch { /* still starting */ }
  await sleep(10_000);
}
die(`Built, but https://${domain}/health does not answer - check the runtime logs in hPanel.`);
