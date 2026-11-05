import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { accounts, AccountError, overLimit, publicAccount, spendOf, type Account } from "./accounts.js";
import { systemPrompt } from "./agent.js";
import { callerName, isOwner, isStaff, type Caller } from "./auth.js";
import { config } from "./config.js";
import { connector } from "./connector.js";
import type { JobRunner } from "./jobs.js";
import { assistantSettings } from "./persona.js";
import { projects } from "./projects.js";
import type { JsonStore } from "./store.js";
import type { Site } from "./types.js";
import { followLog, log, readLog, readUsage } from "./usage.js";

/**
 * Accounts (/auth/*) and the developer's admin panel (/admin/*).
 *
 * The admin panel is for finding out what went wrong without opening a terminal on the server: what this process is,
 * every job with its steps, tool calls, errors and tokens, the live log, crashes, and the exact instructions the
 * assistant is given for a site and an account.
 */

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  route: string;
  caller: Caller;
  /** The session token the request came with (for sign-out). */
  bearer: string;
  sites: JsonStore<Site>;
  runner: JobRunner;
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
  readJson: (req: http.IncomingMessage) => Promise<any>;
}

/** Answered without signing in. */
export const AUTH_PUBLIC_ROUTES = ["GET /auth/status", "POST /auth/setup", "POST /auth/login"];
/** What a client account may call besides the chat routes the widget already has. */
export const CLIENT_EXTRA_ROUTES = /^(GET \/projects|GET \/auth\/me|POST \/auth\/logout|PUT \/auth\/password|(GET|PUT) \/auth\/instructions|POST \/auth\/instructions\/reset|GET \/models\/usage)$/;

const startedAt = new Date();
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const from = (req: http.IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();

/** An account as the admin panel shows it: no password hash, plus what it has spent. */
function accountRow(a: Account) {
  const spend = spendOf(a.id);
  return { ...publicAccount(a), spend, overLimit: overLimit(a, spend), sessions: accounts.sessionCount(a.id) };
}

/** Handles the route when it is one of ours; false = not ours, the server goes on. */
export async function handleAccountRoutes(c: RouteContext): Promise<boolean> {
  const { req, res, url, route, caller, send, readJson } = c;
  const fail = (e: unknown) => send(res, e instanceof AccountError ? e.status : 400, { error: (e as Error).message });

  /* -------------------------------------------------------------- signing in */
  if (route === "GET /auth/status") {
    return send(res, 200, { setupNeeded: accounts.isEmpty(), rootTokenRequired: accounts.isEmpty() && !!config.apiToken }), true;
  }
  if (route === "POST /auth/setup") {
    // Only while there is no account at all. On a public backend the first owner must also prove they hold the root
    // key - otherwise whoever finds a fresh server first would own it.
    if (!accounts.isEmpty()) return send(res, 409, { error: "This backend already has an owner. Sign in instead." }), true;
    const b = await readJson(req);
    if (config.apiToken && !safeEqual(String(b.rootToken ?? ""), config.apiToken)) return send(res, 401, { error: "That is not this backend's root key (LC_API_TOKEN)." }), true;
    try {
      const acc = accounts.create({ email: b.email, name: b.name, password: b.password, role: "owner" });
      const { token } = accounts.login(acc.email, String(b.password), from(req), String(req.headers["user-agent"] ?? ""));
      log("info", "account: owner created", { account: acc.id });
      return send(res, 201, { token, account: publicAccount(acc) }), true;
    } catch (e) { return fail(e), true; }
  }
  if (route === "POST /auth/login") {
    const b = await readJson(req);
    try {
      const { token, account } = accounts.login(String(b.email ?? ""), String(b.password ?? ""), from(req), String(req.headers["user-agent"] ?? ""));
      log("info", "account: signed in", { account: account.id });
      return send(res, 200, { token, account: publicAccount(account) }), true;
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) log("warn", "account: wrong password", { email: String(b.email ?? "").slice(0, 80), from: from(req) });
      return fail(e), true;
    }
  }
  if (route === "POST /auth/logout") { if (c.bearer) accounts.logout(c.bearer); return send(res, 200, { ok: true }), true; }
  if (route === "GET /auth/me") {
    if (caller.via !== "account") return send(res, 200, { root: caller.via === "admin", account: null }), true;
    return send(res, 200, { root: false, account: accountRow(caller.account) }), true;
  }
  if (route === "PUT /auth/password") {
    if (caller.via !== "account") return send(res, 400, { error: "Sign in with an account to change its password." }), true;
    const b = await readJson(req);
    try {
      accounts.login(caller.account.email, String(b.current ?? ""), from(req)); // proves the current password (and is throttled)
      accounts.update(caller.account.id, { password: String(b.next ?? "") });  // ends every session, this one too
      const { token } = accounts.login(caller.account.email, String(b.next), from(req), String(req.headers["user-agent"] ?? ""));
      return send(res, 200, { ok: true, token }), true;
    } catch (e) { return fail(e), true; }
  }

  /* -------------------------------------------------------------- my instructions */
  const instructionsOf = (a: Account) => ({ text: a.instructions ?? "", history: [...(a.instructionHistory ?? [])].reverse() });
  if (route === "GET /auth/instructions") {
    if (caller.via !== "account") return send(res, 400, { error: "Instructions belong to an account. Sign in with one." }), true;
    return send(res, 200, instructionsOf(caller.account)), true;
  }
  if (route === "PUT /auth/instructions" || route === "POST /auth/instructions/reset") {
    if (caller.via !== "account") return send(res, 400, { error: "Instructions belong to an account. Sign in with one." }), true;
    const text = route === "PUT /auth/instructions" ? String((await readJson(req)).text ?? "") : "";
    const acc = accounts.setInstructions(caller.account.id, text, caller.account.email);
    log("info", text ? "account: instructions changed" : "account: instructions reset to the original", { account: acc.id });
    return send(res, 200, instructionsOf(acc)), true;
  }

  /* -------------------------------------------------------------- the admin panel */
  if (!url.pathname.startsWith("/admin/")) return false;
  if (!isStaff(caller)) return send(res, 403, { error: "The admin panel is for owners and developers." }), true;

  // Accounts: owners (and the root key) only.
  if (url.pathname === "/admin/accounts" || url.pathname.startsWith("/admin/accounts/")) {
    if (!isOwner(caller)) return send(res, 403, { error: "Only an owner can manage accounts." }), true;
    try {
      if (route === "GET /admin/accounts") return send(res, 200, { accounts: accounts.list().map(accountRow) }), true;
      if (route === "POST /admin/accounts") {
        const b = await readJson(req);
        const acc = accounts.create({ email: b.email, name: b.name, password: b.password, role: b.role, siteIds: b.siteIds, limits: b.limits }, callerName(caller));
        log("info", "account: created", { account: acc.id, role: acc.role, by: callerName(caller) });
        return send(res, 201, accountRow(acc)), true;
      }
      const m = url.pathname.match(/^\/admin\/accounts\/(acc_[\w]+)(\/instructions(?:\/reset)?|\/sessions)?$/);
      if (m) {
        const id = m[1];
        if (!m[2] && req.method === "PATCH") {
          const b = await readJson(req);
          const acc = accounts.update(id, { name: b.name, role: b.role, siteIds: b.siteIds, limits: b.limits, disabled: b.disabled, password: b.password || undefined });
          log("info", "account: changed", { account: id, by: callerName(caller), fields: Object.keys(b).filter((k) => k !== "password").concat(b.password ? ["password"] : []) });
          return send(res, 200, accountRow(acc)), true;
        }
        if (!m[2] && req.method === "DELETE") { accounts.delete(id); log("info", "account: deleted", { account: id, by: callerName(caller) }); return send(res, 200, { ok: true }), true; }
        if (m[2] === "/sessions" && req.method === "DELETE") { accounts.endSessions(id); return send(res, 200, { ok: true }), true; }
        if (m[2]?.startsWith("/instructions") && (req.method === "PUT" || req.method === "POST")) {
          const text = m[2] === "/instructions" ? String((await readJson(req)).text ?? "") : "";
          const acc = accounts.setInstructions(id, text, callerName(caller));
          return send(res, 200, accountRow(acc)), true;
        }
      }
      return send(res, 404, { error: "Not found" }), true;
    } catch (e) { return fail(e), true; }
  }

  if (route === "GET /admin/overview") {
    const jobs = c.runner.list();
    const byStatus: Record<string, number> = {};
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    const today = new Date().toISOString().slice(0, 10);
    const logToday = readLog(today, 5000);
    const mem = process.memoryUsage();
    return send(res, 200, {
      process: { pid: process.pid, node: process.version, platform: `${os.platform()} ${os.release()}`, startedAt: startedAt.toISOString(), uptimeS: Math.round(process.uptime()),
        rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), host: os.hostname(), cwd: process.cwd() },
      config: { model: config.model, voiceModel: config.voiceModel || null, dataDir: config.dataDir, verifyChanges: config.verifyChanges, allowThemeWrites: config.allowThemeWrites,
        maxSteps: config.maxSteps, jobTimeoutMs: config.jobTimeoutMs, rootToken: !!config.apiToken },
      connector: connector.info(),
      counts: { sites: c.sites.list().length, accounts: accounts.list().length, jobs: jobs.length, byStatus },
      today: { errors: logToday.filter((l) => l.level === "error").length, warnings: logToday.filter((l) => l.level === "warn").length,
        tokens: readUsage(today.slice(0, 7), (r) => r.at.startsWith(today)).reduce((s, r) => s + (r.total || 0), 0) },
      running: jobs.filter((j) => j.status === "running" || j.status === "queued").map((j) => ({ id: j.id, siteId: j.siteId, status: j.status, prompt: j.prompt.slice(0, 120), updatedAt: j.updatedAt, account: j.accountName })),
    }), true;
  }

  if (route === "GET /admin/logs") {
    const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
    const level = url.searchParams.get("level") || "";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const limit = Math.min(Number(url.searchParams.get("limit") || 500), 5000);
    const rows = readLog(day, 20000).filter((r) => (!level || r.level === level) && (!q || JSON.stringify(r).toLowerCase().includes(q))).slice(-limit);
    return send(res, 200, { day, rows }), true;
  }
  if (route === "GET /admin/logs/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const off = followLog((row) => res.write(`data: ${JSON.stringify(row)}\n\n`));
    const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => { off(); clearInterval(ping); });
    return true;
  }
  if (route === "GET /admin/crashes") {
    // Crashes and unhandled rejections (server.ts writes them here even when the log itself could not be written).
    let text = "";
    try { text = fs.readFileSync(path.join(config.dataDir, "backend-errors.log"), "utf8"); } catch { /* none yet */ }
    return send(res, 200, { text: text.slice(-60_000) }), true;
  }

  if (route === "GET /admin/jobs") {
    const status = url.searchParams.get("status") || "", site = url.searchParams.get("site") || "", account = url.searchParams.get("account") || "";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const names = new Map(c.sites.list().map((s) => [s.id, s.name || s.url]));
    const rows = c.runner.list()
      .filter((j) => (!status || j.status === status) && (!site || j.siteId === site) && (!account || j.accountId === account) && (!q || `${j.id} ${j.prompt} ${j.error ?? ""}`.toLowerCase().includes(q)))
      .slice(0, 300)
      .map((j) => ({ id: j.id, siteId: j.siteId, site: names.get(j.siteId), status: j.status, prompt: j.prompt.slice(0, 200), error: j.error, model: j.model, account: j.accountName, accountId: j.accountId,
        actor: j.actor?.login, usage: j.usage, createdAt: j.createdAt, updatedAt: j.updatedAt, requests: j.requestSeq ?? 1, changes: j.changes?.length ?? 0, waiting: j.pending.filter((p) => p.approved === undefined).length }));
    return send(res, 200, { jobs: rows }), true;
  }
  const jm = url.pathname.match(/^\/admin\/jobs\/(job_\w+)$/);
  if (jm && req.method === "GET") {
    const j = c.runner.get(jm[1]);
    if (!j) return send(res, 404, { error: "Unknown job" }), true;
    // The model calls of this job, from the usage log of the months it ran in.
    const months = [...new Set([j.createdAt.slice(0, 7), j.updatedAt.slice(0, 7)])];
    const steps = months.flatMap((m) => readUsage(m, (r) => r.job === j.id));
    return send(res, 200, {
      job: { id: j.id, siteId: j.siteId, status: j.status, prompt: j.prompt, error: j.error, model: j.model, account: j.accountName, accountId: j.accountId, actor: j.actor,
        approvalMode: j.approvalMode, pageUrl: j.pageUrl, voice: j.voice, usage: j.usage, createdAt: j.createdAt, updatedAt: j.updatedAt, requests: j.requestSeq ?? 1,
        messages: j.messages.length, pending: j.pending, changes: j.changes ?? [] },
      events: j.events,
      steps,
    }), true;
  }

  if (route === "GET /admin/prompt") {
    const site = c.sites.get(url.searchParams.get("site") || "") ?? c.sites.list()[0];
    if (!site) return send(res, 400, { error: "Connect a site first: the instructions are written for one." }), true;
    const accId = url.searchParams.get("account") || (caller.via === "account" ? caller.account.id : "");
    const acc = accId ? accounts.get(accId) : undefined;
    const persona = await assistantSettings(site).catch(() => null);
    const prj = projects.get(url.searchParams.get("project") || "") ?? projects.defaultFor(site);
    const project = prj.siteId === site.id ? prj : projects.defaultFor(site);
    const text = systemPrompt(site, {
      files: false, themeWrites: config.allowThemeWrites, browser: true, hostinger: false, skills: "", mode: project.approvalMode ?? "request",
      persona, account: acc ? { name: acc.name, instructions: acc.instructions } : undefined,
      project: { name: project.name, instructions: project.instructions },
    });
    return send(res, 200, { site: { id: site.id, name: site.name }, account: acc ? { id: acc.id, name: acc.name } : null, project: { id: project.id, name: project.name }, persona, text, chars: text.length,
      note: "A real run adds what it read from the site at that moment (drafts, notes, the page) after THIS SITE, and lists the theme-file and hosting tools when they are connected." }), true;
  }

  return send(res, 404, { error: "Not found" }), true;
}
