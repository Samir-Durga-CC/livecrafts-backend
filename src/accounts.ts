import crypto from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import { readUsage } from "./usage.js";

/**
 * Accounts: who uses this backend, what each one may see, what each one spends.
 *
 *   owner     - everything, including other accounts. The first account is the owner.
 *   developer - everything except managing accounts: all sites, integrations, the admin panel.
 *   client    - only the sites given to them, and only the chat: no integrations, keys, logs or other people.
 *
 * Passwords are scrypt hashes; a sign-in is a random session token (only its hash is stored) sent as a Bearer token,
 * like LC_API_TOKEN before it. LC_API_TOKEN keeps working as the backend's own root key (CI, scripts, recovery).
 *
 * Each account can have its own instructions for the assistant. They are ADDED to the Livecrafts rules, never in place
 * of them - nobody can edit or remove the rules themselves - and every version is kept, so "reset to original" (no
 * instructions of your own) and "go back to an earlier version" are one click.
 */
export type Role = "owner" | "developer" | "client";
export const ROLES: Role[] = ["owner", "developer", "client"];

export interface Limits {
  /** Tokens per calendar month (UTC). Unset = no limit. */
  monthlyTokens?: number;
  /** Tokens per day (UTC). Unset = no limit. */
  dailyTokens?: number;
}

export interface InstructionVersion { text: string; at: string; by: string }

export interface Account {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** scrypt$<salt hex>$<hash hex> */
  password: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  disabled?: boolean;
  /** Clients: the sites they may use. Owners and developers see every site. */
  siteIds?: string[];
  limits?: Limits;
  /** The account's own instructions for the assistant; empty = the original (Livecrafts' rules only). */
  instructions?: string;
  /** Every version ever saved, newest last (an empty text = a reset). */
  instructionHistory?: InstructionVersion[];
}

interface Session { id: string; accountId: string; tokenHash: string; createdAt: string; expiresAt: string; lastSeenAt: string; agent?: string }

/** What the browser may see of an account: never the password hash. */
export type PublicAccount = Omit<Account, "password">;
export const publicAccount = ({ password: _p, ...a }: Account): PublicAccount => a;

const SESSION_DAYS = 30;
const MAX_INSTRUCTIONS = 4000;
const MAX_HISTORY = 30;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const norm = (email: string) => String(email ?? "").trim().toLowerCase();

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function passwordMatches(pw: string, stored: string): boolean {
  const [kind, salt, hash] = String(stored ?? "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), want.length);
  return crypto.timingSafeEqual(got, want);
}

export class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "AccountError"; }
}

/** Five wrong passwords for one email (or from one address) in 15 minutes, and that one waits. */
class Throttle {
  private fails = new Map<string, number[]>();
  hit(key: string) { const now = Date.now(); this.fails.set(key, [...(this.fails.get(key) ?? []).filter((t) => now - t < 15 * 60_000), now]); }
  blocked(key: string) { const now = Date.now(); return (this.fails.get(key) ?? []).filter((t) => now - t < 15 * 60_000).length >= 5; }
  clear(key: string) { this.fails.delete(key); }
}

export class Accounts {
  private accounts: JsonStore<Account>;
  private sessions: JsonStore<Session>;
  private throttle = new Throttle();

  constructor(dataDir = config.dataDir) {
    this.accounts = new JsonStore<Account>(path.join(dataDir, "accounts"));
    this.sessions = new JsonStore<Session>(path.join(dataDir, "account-sessions"));
  }

  list(): Account[] { return this.accounts.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  get(id: string) { return this.accounts.get(id); }
  /** No account yet: the app shows "create the owner account" instead of a sign-in. */
  isEmpty() { return this.accounts.list().length === 0; }
  private byEmail(email: string) { return this.list().find((a) => a.email === norm(email)); }

  create(input: { email: string; name?: string; password: string; role?: Role; siteIds?: string[]; limits?: Limits }, by = "setup"): Account {
    const email = norm(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AccountError(400, "That is not an email address.");
    if (this.byEmail(email)) throw new AccountError(409, "There is already an account with that email.");
    checkPassword(input.password);
    const role: Role = this.isEmpty() ? "owner" : ROLES.includes(input.role as Role) ? input.role! : "developer";
    const now = new Date().toISOString();
    const acc: Account = {
      id: newId("acc"), email, name: String(input.name ?? "").trim().slice(0, 80) || email.split("@")[0], role,
      password: hashPassword(input.password), createdAt: now, updatedAt: now,
      ...(role === "client" ? { siteIds: cleanIds(input.siteIds) } : {}),
      ...(input.limits ? { limits: cleanLimits(input.limits) } : {}),
      instructionHistory: [{ text: "", at: now, by }],
    };
    return this.accounts.put(acc);
  }

  update(id: string, patch: { name?: string; role?: Role; siteIds?: string[]; limits?: Limits; disabled?: boolean; password?: string }): Account {
    const acc = this.must(id);
    if (patch.role !== undefined || patch.disabled !== undefined) {
      const becomesNonOwner = (patch.role !== undefined && patch.role !== "owner") || patch.disabled === true;
      if (acc.role === "owner" && becomesNonOwner && this.list().filter((a) => a.role === "owner" && !a.disabled).length <= 1)
        throw new AccountError(409, "This is the only owner. Make someone else an owner first.");
    }
    if (patch.name !== undefined) acc.name = String(patch.name).trim().slice(0, 80) || acc.name;
    if (patch.role !== undefined) { if (!ROLES.includes(patch.role)) throw new AccountError(400, "Unknown role."); acc.role = patch.role; }
    if (patch.siteIds !== undefined) acc.siteIds = cleanIds(patch.siteIds);
    if (patch.limits !== undefined) acc.limits = cleanLimits(patch.limits);
    if (patch.disabled !== undefined) { acc.disabled = !!patch.disabled; if (acc.disabled) this.endSessions(acc.id); }
    if (patch.password !== undefined) { checkPassword(patch.password); acc.password = hashPassword(patch.password); this.endSessions(acc.id); }
    acc.updatedAt = new Date().toISOString();
    return this.accounts.put(acc);
  }

  delete(id: string) {
    const acc = this.must(id);
    if (acc.role === "owner" && this.list().filter((a) => a.role === "owner").length <= 1) throw new AccountError(409, "This is the only owner and cannot be deleted.");
    this.endSessions(id);
    this.accounts.delete(id);
  }

  /** Save new instructions (empty = back to the original). Every version stays in the history. */
  setInstructions(id: string, text: string, by: string): Account {
    const acc = this.must(id);
    const clean = String(text ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_INSTRUCTIONS);
    acc.instructions = clean || undefined;
    acc.instructionHistory = [...(acc.instructionHistory ?? []), { text: clean, at: new Date().toISOString(), by }].slice(-MAX_HISTORY);
    acc.updatedAt = new Date().toISOString();
    return this.accounts.put(acc);
  }

  /* ---------------------------------------------------------------- signing in */

  login(email: string, password: string, from: string, agent?: string): { token: string; account: Account } {
    const key = norm(email);
    if (this.throttle.blocked("e:" + key) || this.throttle.blocked("ip:" + from)) throw new AccountError(429, "Too many wrong passwords. Wait 15 minutes and try again.");
    const acc = this.byEmail(key);
    // The same answer for "no such account" and "wrong password", so the sign-in form cannot be used to find emails.
    if (!acc || !passwordMatches(String(password ?? ""), acc.password)) {
      this.throttle.hit("e:" + key); this.throttle.hit("ip:" + from);
      throw new AccountError(401, "Wrong email or password.");
    }
    if (acc.disabled) throw new AccountError(403, "This account is switched off. Ask the owner.");
    this.throttle.clear("e:" + key);
    acc.lastLoginAt = new Date().toISOString();
    this.accounts.put(acc);
    return { token: this.newSession(acc.id, agent), account: acc };
  }

  private newSession(accountId: string, agent?: string): string {
    const token = "lcs_" + crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    this.sessions.put({ id: newId("ses"), accountId, tokenHash: sha(token), createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString(), agent: agent?.slice(0, 160) });
    return token;
  }

  /** The account a Bearer token belongs to, or null (unknown, expired, or the account was switched off). */
  fromToken(token: string): Account | null {
    if (!token.startsWith("lcs_")) return null;
    const h = sha(token);
    const s = this.sessions.list().find((x) => x.tokenHash === h);
    if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
    const acc = this.accounts.get(s.accountId);
    if (!acc || acc.disabled) return null;
    // Remember that it was used, at most once an hour (every request would otherwise write a file).
    if (Date.now() - Date.parse(s.lastSeenAt) > 3_600_000) this.sessions.put({ ...s, lastSeenAt: new Date().toISOString() });
    return acc;
  }

  logout(token: string) {
    const h = sha(token);
    for (const s of this.sessions.list()) if (s.tokenHash === h) this.sessions.delete(s.id);
  }

  endSessions(accountId: string) { for (const s of this.sessions.list()) if (s.accountId === accountId) this.sessions.delete(s.id); }

  sessionCount(accountId: string) { return this.sessions.list().filter((s) => s.accountId === accountId && Date.parse(s.expiresAt) > Date.now()).length; }

  private must(id: string) { const a = this.accounts.get(id); if (!a) throw new AccountError(404, "Unknown account."); return a; }
}

function checkPassword(pw: unknown) {
  if (typeof pw !== "string" || pw.length < 10) throw new AccountError(400, "The password must be at least 10 characters.");
  if (pw.length > 200) throw new AccountError(400, "That password is too long.");
}
const cleanIds = (ids: unknown) => (Array.isArray(ids) ? [...new Set(ids.map(String).filter((x) => /^[\w-]{1,64}$/.test(x)))] : []);
function cleanLimits(l: Limits): Limits {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const out: Limits = {};
  const m = n(l?.monthlyTokens), d = n(l?.dailyTokens);
  if (m) out.monthlyTokens = m;
  if (d) out.dailyTokens = d;
  return out;
}

/* ---------------------------------------------------------------- what an account has spent */

export interface Spend { month: number; today: number; monthCalls: number }

/** Tokens this account used this month and today, from the usage log (every model step is a line there). */
export function spendOf(accountId: string, now = new Date()): Spend {
  const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  const rows = readUsage(month, (r) => r.account === accountId);
  let m = 0, t = 0;
  for (const r of rows) { m += r.total; if (r.at.startsWith(day)) t += r.total; }
  return { month: m, today: t, monthCalls: rows.length };
}

/** Why this account may not start another request right now, or null when it may. */
export function overLimit(acc: Account, spend = spendOf(acc.id)): string | null {
  const l = acc.limits ?? {};
  const f = (v: number) => new Intl.NumberFormat("en").format(v);
  if (l.dailyTokens && spend.today >= l.dailyTokens) return `Your daily limit of ${f(l.dailyTokens)} tokens is used up (${f(spend.today)} today). It resets at midnight UTC, or the owner can raise it.`;
  if (l.monthlyTokens && spend.month >= l.monthlyTokens) return `Your monthly limit of ${f(l.monthlyTokens)} tokens is used up (${f(spend.month)} this month). Ask the owner to raise it.`;
  return null;
}

/** The one account store of this backend. */
export const accounts = new Accounts();
