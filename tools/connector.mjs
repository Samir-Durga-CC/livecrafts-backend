#!/usr/bin/env node
/**
 * Livecrafts connector - lets a Livecrafts backend on a server use the Claude CLI on YOUR computer.
 *
 *   node livecrafts-connector.mjs --server https://livecrafts.example.com --token lcc_...
 *   node livecrafts-connector.mjs            (later: the server and token are remembered)
 *
 * Needs Node.js 22+ and Claude Code installed and signed in ("claude auth login"). No other install: this one file.
 *
 * It keeps one outbound connection open to the backend (no port is opened on this computer) and, for every agent
 * step the backend sends, runs:
 *
 *   claude --print --tools "" --safe-mode --strict-mcp-config --no-session-persistence ...
 *
 * in an empty folder, with every tool switched off: Claude only ANSWERS - it cannot read or change files, run
 * commands, or use MCP servers on this computer. The backend sends only the model name, the instructions and the
 * conversation; the command line is built here, so the backend cannot make this computer run anything else.
 * The flags are the same as jobArgs() in the backend's src/claudeCli.ts - keep the two in step.
 *
 * Stop it with Ctrl+C. Revoke it from anywhere in Livecrafts: Integrations -> AI models -> Your computer.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";
const CONFIG = process.env.LC_CONNECTOR_CONFIG || path.join(os.homedir(), ".livecrafts-connector.json");
const MAX_PARALLEL = 3;
const EFFORTS = new Set(["", "low", "medium", "high", "xhigh", "max"]);

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] ?? "" : undefined; };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

if (typeof WebSocket === "undefined") {
  console.error(`Node.js ${process.versions.node} is too old: the connector needs Node.js 22 or newer (nodejs.org).`);
  process.exit(1);
}

/* ------------------------------------------------------------------ settings */

let saved = {};
try { saved = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { /* first run */ }
const server = (arg("server") ?? saved.server ?? "").replace(/\/+$/, "");
const token = arg("token") ?? saved.token ?? "";
if (!/^https?:\/\/[^/]+/.test(server) || !/^lcc_[a-f0-9]{48}$/.test(token)) {
  console.error("Start it with the command Livecrafts shows under Integrations -> AI models -> Your computer:\n" +
    "  node livecrafts-connector.mjs --server https://<your backend> --token lcc_...");
  process.exit(1);
}
if (arg("server") || arg("token")) {
  fs.writeFileSync(CONFIG, JSON.stringify({ server, token }, null, 2), { mode: 0o600 });
  log(`Saved to ${CONFIG} - next time just run: node livecrafts-connector.mjs`);
}

/* ------------------------------------------------------------------ the Claude CLI on this computer */

/** Claude Code installs as claude.exe (installer), claude.cmd (npm on Windows, needs cmd.exe) or plain `claude`. */
const asBin = (p) => process.platform === "win32" && /\.(cmd|bat)$/i.test(p)
  ? { cmd: process.env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", p], label: p }
  : { cmd: p, prefix: [], label: p };
const candidates = () => process.env.LC_CLAUDE_BIN
  ? [asBin(process.env.LC_CLAUDE_BIN)]
  : process.platform === "win32" ? [asBin("claude.exe"), asBin("claude"), asBin("claude.cmd")] : [asBin("claude")];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "livecrafts-connector-"));
const childEnv = () => ({ ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });

function exec(bin, args, stdin = "", timeoutMs = 25_000) {
  return new Promise((resolve) => {
    let child, out = "", err = "";
    try { child = spawn(bin.cmd, [...bin.prefix, ...args], { cwd: scratch, windowsHide: true, env: childEnv() }); }
    catch (e) { return resolve({ code: null, out, err: String(e.message) }); }
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: null, out, err: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

let bin = null;
async function claudeStatus() {
  const s = { installed: false, loggedIn: false };
  bin = null;
  for (const b of candidates()) {
    const v = await exec(b, ["--version"]);
    if (v.code === 0 && /\d+\.\d+/.test(v.out)) { bin = b; s.installed = true; s.version = v.out.trim().split("\n")[0].slice(0, 60); break; }
  }
  if (!bin) { s.error = "Claude Code was not found on this computer."; s.fix = "Install Claude Code (claude.com/claude-code), then restart the connector."; return s; }
  const a = await exec(bin, ["auth", "status"]);
  try { const o = JSON.parse(a.out.slice(a.out.indexOf("{"))); s.loggedIn = !!o.loggedIn; if (o.authMethod && o.authMethod !== "none") s.authMethod = o.authMethod; } catch { /* older CLI */ }
  if (!s.loggedIn && process.env.ANTHROPIC_API_KEY) { s.loggedIn = true; s.authMethod = "apiKey"; }
  if (!s.loggedIn) { s.error = "Claude Code is installed but not signed in."; s.fix = 'Run "claude auth login" on this computer, then restart the connector.'; }
  return s;
}

/** The command line - built HERE from plain fields, never taken from the backend. Same flags as jobArgs(). */
function argsFor(job, systemFile) {
  return [
    "--print",
    "--model", job.model,
    "--system-prompt-file", systemFile,
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-prompts", "none",
    ...(job.effort ? ["--effort", job.effort] : []),
    "--input-format", "stream-json",
    "--output-format", "stream-json", "--verbose",
    ...(job.stream ? ["--include-partial-messages"] : []),
  ];
}

/* ------------------------------------------------------------------ the connection */

const running = new Map();
let ws = null, hello = null, backoff = 1000, stopping = false;

function send(o) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function runJob(id, job, timeoutMs) {
  const bad = typeof job?.model !== "string" || !/^[A-Za-z0-9._:[\]-]{1,60}$/.test(job.model) ? "model"
    : !EFFORTS.has(job.effort ?? "") ? "effort"
    : typeof job.system !== "string" || typeof job.stdin !== "string" ? "content" : "";
  if (bad) return send({ type: "exit", id, code: null, error: `The connector refused this step (bad ${bad}).` });
  if (!bin || !hello?.agents.claude?.loggedIn) return send({ type: "exit", id, code: null, error: hello?.agents.claude?.error ?? "Claude Code is not ready on this computer." });
  if (running.size >= MAX_PARALLEL) return send({ type: "exit", id, code: null, error: `This computer is already running ${MAX_PARALLEL} steps - try again in a moment.` });

  const systemFile = path.join(scratch, `sys-${crypto.randomBytes(6).toString("hex")}.txt`);
  fs.writeFileSync(systemFile, job.system, "utf8");
  let child;
  try { child = spawn(bin.cmd, [...bin.prefix, ...argsFor(job, systemFile)], { cwd: scratch, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: childEnv() }); }
  catch (e) { fs.rmSync(systemFile, { force: true }); return send({ type: "exit", id, code: null, error: String(e.message) }); }

  const started = Date.now();
  const limit = setTimeout(() => { try { child.kill(); } catch {} }, Math.min(Math.max(Number(timeoutMs) || 240_000, 10_000), 15 * 60_000) + 5_000);
  running.set(id, child);
  log(`step ${id.slice(-6)}: claude ${job.model}${job.effort ? " (" + job.effort + ")" : ""} ...`);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => send({ type: "out", id, data: d }));
  child.stderr.on("data", (d) => send({ type: "err", id, data: d.slice(0, 4000) }));
  const done = (code, error) => {
    if (!running.has(id)) return;
    running.delete(id);
    clearTimeout(limit);
    fs.rmSync(systemFile, { force: true });
    log(`step ${id.slice(-6)}: ${code === 0 ? "done" : "ended (" + (error ?? "exit " + code) + ")"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    send({ type: "exit", id, code, ...(error ? { error } : {}) });
  };
  child.on("error", (e) => done(null, String(e.message)));
  child.on("close", (code) => done(code));
  child.stdin.on("error", () => {});
  child.stdin.end(job.stdin);
}

async function connect() {
  hello = { machine: os.hostname(), platform: process.platform, version: VERSION, agents: { claude: await claudeStatus() } };
  const c = hello.agents.claude;
  log(c.installed ? `Claude Code ${c.version}${c.loggedIn ? ` - signed in (${c.authMethod ?? "subscription"})` : " - NOT signed in"}` : "Claude Code NOT found");
  if (c.fix) log("-> " + c.fix);

  const url = server.replace(/^http/, "ws") + "/connector";
  log(`Connecting to ${server} ...`);
  ws = new WebSocket(url);
  ws.onopen = () => send({ type: "hello", token, hello });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.type === "welcome") { backoff = 1000; log("Connected. Livecrafts can now use Claude on this computer. Leave this window open (Ctrl+C stops)."); }
    else if (m.type === "rejected") { log("Refused: " + m.reason); stopping = true; }
    else if (m.type === "run") runJob(String(m.id), m.job, m.timeoutMs);
    else if (m.type === "cancel") { const ch = running.get(String(m.id)); if (ch) { try { ch.kill(); } catch {} } }
  };
  ws.onclose = (e) => {
    for (const ch of running.values()) { try { ch.kill(); } catch {} }
    running.clear();
    if (stopping || e.code === 4003) { log(e.reason || "Disconnected."); process.exit(1); }
    log(`Disconnected${e.reason ? ` (${e.reason})` : ""} - trying again in ${Math.round(backoff / 1000)}s.`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
  ws.onerror = () => { /* onclose follows */ };
}

process.on("SIGINT", () => { stopping = true; log("Stopping."); try { ws?.close(1000, "Stopped on the computer."); } catch {} setTimeout(() => process.exit(0), 300); });
log(`Livecrafts connector ${VERSION}`);
connect();
