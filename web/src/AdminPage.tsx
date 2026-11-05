import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, getToken } from "./api";
import { SignIn } from "./components/SignIn";
import type { AccountInfo, AdminJobRow, AdminOverview, LogRow, Role, Site } from "./types";

/**
 * /admin - for the people who run Livecrafts, to see what happened without a terminal on the server.
 *
 *   Overview  this process, its settings, the connector, what is running, today's errors - and the crash log
 *   Accounts  who may use it, which sites a client has, token limits, what each one spent (owners only)
 *   Jobs      every chat with its steps (model, tokens, time), every event and tool call, every change, the error
 *   Logs      the backend log by day, filtered, or live as it is written
 *   Prompt    the exact instructions the assistant gets for a site and an account
 */
type Tab = "overview" | "accounts" | "jobs" | "logs" | "prompt";
const TABS: { id: Tab; label: string; owner?: boolean }[] = [
  { id: "overview", label: "Overview" }, { id: "accounts", label: "Accounts", owner: true }, { id: "jobs", label: "Jobs" },
  { id: "logs", label: "Logs" }, { id: "prompt", label: "Prompt" },
];
const nf = new Intl.NumberFormat();
const n = (v: number | undefined) => nf.format(Math.round(v ?? 0));
const short = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : n(v));
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-");
const ago = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`);
const copy = (text: string) => { void navigator.clipboard.writeText(text).catch(() => {}); };

export default function AdminPage() {
  const [me, setMe] = useState<{ root: boolean; account: AccountInfo | null } | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get("tab") as Tab) || "overview");
  const [sites, setSites] = useState<Site[]>([]);

  useEffect(() => {
    if (!getToken()) { api.health().then((h) => { if (!h.authRequired) setMe({ root: true, account: null }); else setErr("signin"); }).catch((e) => setErr((e as Error).message)); return; }
    api.me().then(setMe).catch((e) => setErr(e instanceof ApiError && e.status === 401 ? "signin" : (e as Error).message));
    api.sites().then(setSites).catch(() => {});
  }, []);
  useEffect(() => { const u = new URL(location.href); u.searchParams.set("tab", tab); history.replaceState(null, "", u); }, [tab]);

  if (err === "signin") return <SignIn reason="Sign in to open the admin panel." />;
  if (err) return <div className="us-page"><div className="banner error">{err}</div></div>;
  if (!me) return <div className="us-page"><p className="muted"><span className="spin" /> Loading…</p></div>;
  const role: Role | "root" = me.root ? "root" : me.account!.role;
  if (role === "client") return <div className="us-page"><h1>Admin panel</h1><p className="muted">The admin panel is for owners and developers. <a href="/">Back to the chat</a></p></div>;
  const owner = role === "root" || role === "owner";

  return (
    <div className="us-page ad-page">
      <header className="us-head">
        <div>
          <h1>Admin panel</h1>
          <p className="muted">{me.account ? <>Signed in as <b>{me.account.name}</b> ({me.account.role})</> : "Root key"} · <a href="/">Back to the chat</a> · <a href="/model-usage">Model usage</a></p>
        </div>
      </header>
      <nav className="ad-tabs" role="tablist">
        {TABS.filter((t) => !t.owner || owner).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`pillbtn${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "accounts" && owner && <Accounts sites={sites} />}
      {tab === "jobs" && <Jobs sites={sites} />}
      {tab === "logs" && <Logs />}
      {tab === "prompt" && <Prompt sites={sites} />}
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview() {
  const [o, setO] = useState<AdminOverview | null>(null);
  const [crashes, setCrashes] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = () => api.adminOverview().then((x) => { setO(x); setErr(""); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  if (err) return <div className="banner error">{err}</div>;
  if (!o) return <p className="muted"><span className="spin" /> Loading…</p>;
  const c = o.connector;
  return (
    <>
      <div className="us-tiles">
        <Tile label="Up for" value={ago(o.process.uptimeS)} foot={`pid ${o.process.pid} · ${o.process.node}`} />
        <Tile label="Memory" value={`${o.process.rssMb} MB`} foot={`${o.process.heapMb} MB heap`} />
        <Tile label="Errors today" value={n(o.today.errors)} foot={`${n(o.today.warnings)} warnings`} tone={o.today.errors ? "bad" : undefined} />
        <Tile label="Tokens today" value={short(o.today.tokens)} foot={`${o.counts.jobs} chats · ${o.counts.sites} sites · ${o.counts.accounts} accounts`} />
      </div>
      <section className="us-block">
        <h2>Running now</h2>
        {o.running.length === 0 ? <p className="muted small">Nothing is running.</p> : (
          <table className="us-table"><tbody>
            {o.running.map((j) => <tr key={j.id}><th scope="row"><code>{j.id}</code></th><td>{j.status}</td><td>{j.prompt}</td><td className="dim">{j.account ?? "-"}</td><td className="num dim">{when(j.updatedAt)}</td></tr>)}
          </tbody></table>
        )}
        <p className="muted small">Chats by status: {Object.entries(o.counts.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}</p>
      </section>
      <section className="us-block">
        <h2>Your computer (Claude CLI connector)</h2>
        <p className="small">{c.connected ? <>Connected: <b>{c.machine}</b> since {when(c.since)} - Claude Code {c.claude?.version ?? "?"}, {c.claude?.loggedIn ? "signed in" : "NOT signed in"}. {c.running} step(s) running.</>
          : c.hasToken ? "Not connected (a token exists - start the connector on the computer)." : "Not set up. Integrations → AI connections → Claude CLI → Your computer."}</p>
      </section>
      <section className="us-block">
        <h2>Settings of this backend</h2>
        <div className="ad-facts">
          {Object.entries({ "Default model": o.config.model, "Voice model": o.config.voiceModel ?? "same", "Data folder": o.config.dataDir, "Browser checks": o.config.verifyChanges ? "on" : "off",
            "Theme file writes": o.config.allowThemeWrites ? "allowed" : "off", "Max steps": o.config.maxSteps, "Job timeout": `${Math.round(o.config.jobTimeoutMs / 1000)}s`, "Root key": o.config.rootToken ? "set" : "not set",
            Host: o.process.host, Platform: o.process.platform, Started: when(o.process.startedAt) }).map(([k, v]) => <div key={k}><span>{k}</span><b><code>{String(v)}</code></b></div>)}
        </div>
      </section>
      <section className="us-block">
        <h2>Crashes</h2>
        {crashes === null ? <button className="btn sm" onClick={() => api.adminCrashes().then((r) => setCrashes(r.text)).catch((e) => setCrashes(String((e as Error).message)))}>Show the crash log</button>
          : crashes ? <pre className="ad-pre">{crashes}</pre> : <p className="muted small">No crash recorded.</p>}
      </section>
    </>
  );
}

function Tile({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: "bad" }) {
  return <div className={`us-tile${tone ? " " + tone : ""}`}><span className="us-tile-label">{label}</span><strong className="us-tile-value">{value}</strong>{foot && <span className="us-tile-foot">{foot}</span>}</div>;
}

/* ------------------------------------------------------------------ accounts */

const ROLE_NOTE: Record<Role, string> = { owner: "everything, and accounts", developer: "everything but accounts", client: "only their sites, chat only" };

function Accounts({ sites }: { sites: Site[] }) {
  const [list, setList] = useState<AccountInfo[] | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState("");
  const load = () => api.adminAccounts().then((r) => setList(r.accounts)).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setErr(""); setMsg(""); try { await fn(); if (ok) setMsg(ok); await load(); } catch (e) { setErr((e as Error).message); } };

  return (
    <>
      <div className="ad-bar">
        <p className="muted small grow">Clients only see the sites you give them, and only the chat. Limits are tokens per day / month (UTC); a request over the limit is refused with the reason.</p>
        <button className="btn primary sm" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "New account"}</button>
      </div>
      {adding && <NewAccount sites={sites} onDone={(ok) => { setAdding(false); void act(async () => {}, ok); }} />}
      {err && <div className="banner error">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}
      {!list ? <p className="muted"><span className="spin" /> Loading…</p> : (
        <table className="us-table ad-acc">
          <thead><tr><th>Account</th><th>Role</th><th>Sites</th><th className="num">Today</th><th className="num">This month</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {list.map((a) => (
              <AccountRow key={a.id} a={a} sites={sites} open={open === a.id} onToggle={() => setOpen(open === a.id ? "" : a.id)} act={act} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Spend({ used, limit }: { used: number; limit?: number }) {
  if (!limit) return <span title={n(used)}>{short(used)}</span>;
  const p = Math.min(100, Math.round((used / limit) * 100));
  return <span className="ad-spend" title={`${n(used)} of ${n(limit)}`}><span>{short(used)} / {short(limit)}</span><span className={`us-bar${p >= 100 ? " full" : p >= 80 ? " warn" : ""}`}><span style={{ width: `${p}%` }} /></span></span>;
}

function AccountRow({ a, sites, open, onToggle, act }: { a: AccountInfo; sites: Site[]; open: boolean; onToggle: () => void; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [role, setRole] = useState<Role>(a.role);
  const [siteIds, setSiteIds] = useState<string[]>(a.siteIds ?? []);
  const [daily, setDaily] = useState(a.limits?.dailyTokens ? String(a.limits.dailyTokens) : "");
  const [monthly, setMonthly] = useState(a.limits?.monthlyTokens ? String(a.limits.monthlyTokens) : "");
  const [pw, setPw] = useState("");
  const num = (s: string) => (s.trim() ? Number(s.replace(/[,_\s]/g, "")) : undefined);
  const siteNames = a.role === "client" ? (a.siteIds ?? []).map((id) => sites.find((s) => s.id === id)?.name ?? id).join(", ") || "none" : "all";
  return (
    <>
      <tr className={a.disabled ? "ad-off" : ""}>
        <th scope="row"><span className="us-name">{a.name}{a.disabled && <small className="conn-pill"> off</small>}</span><small className="us-note">{a.email}</small></th>
        <td>{a.role}</td>
        <td className="dim">{siteNames}</td>
        <td className="num"><Spend used={a.spend.today} limit={a.limits?.dailyTokens} /></td>
        <td className="num"><Spend used={a.spend.month} limit={a.limits?.monthlyTokens} /></td>
        <td className="dim">{when(a.lastLoginAt)}{a.sessions ? ` · ${a.sessions} session${a.sessions > 1 ? "s" : ""}` : ""}</td>
        <td><button className="rbtn" onClick={onToggle}>{open ? "Close" : "Edit"}</button></td>
      </tr>
      {open && (
        <tr className="ad-edit"><td colSpan={7}>
          <div className="ad-grid">
            <label>Role
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{(["owner", "developer", "client"] as Role[]).map((r) => <option key={r} value={r}>{r} - {ROLE_NOTE[r]}</option>)}</select>
            </label>
            <label>Daily token limit <input inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="no limit" /></label>
            <label>Monthly token limit <input inputMode="numeric" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="no limit" /></label>
            {role === "client" && (
              <fieldset className="ad-sites"><legend>Sites this client may use</legend>
                {sites.map((s) => <label key={s.id} className="ad-check"><input type="checkbox" checked={siteIds.includes(s.id)} onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))} /> {s.name} <small className="muted">{s.url.replace(/^https?:\/\//, "")}</small></label>)}
                {!sites.length && <p className="muted small">No sites connected yet.</p>}
              </fieldset>
            )}
          </div>
          {a.overLimit && <div className="banner error">{a.overLimit}</div>}
          <div className="dialog-actions left">
            <button className="btn primary sm" onClick={() => void act(() => api.updateAccount(a.id, { role, siteIds, limits: { dailyTokens: num(daily), monthlyTokens: num(monthly) } }), `${a.name} saved.`)}>Save</button>
            <button className="btn sm" onClick={() => void act(() => api.updateAccount(a.id, { disabled: !a.disabled }), a.disabled ? `${a.name} can sign in again.` : `${a.name} is switched off and signed out.`)}>{a.disabled ? "Switch on" : "Switch off"}</button>
            <button className="btn sm" disabled={!a.sessions} onClick={() => void act(() => api.endAccountSessions(a.id), `${a.name} is signed out everywhere.`)}>Sign out everywhere</button>
            <button className="btn sm" disabled={!a.instructions} title={a.instructions ? a.instructions : "Uses the original instructions"} onClick={() => void act(() => api.resetAccountInstructions(a.id), `${a.name}'s instructions are back to the original.`)}>Reset instructions</button>
            <span className="grow" />
            <input type="password" className="ad-pw" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="new password (10+)" autoComplete="new-password" />
            <button className="btn sm" disabled={pw.length < 10} onClick={() => void act(() => api.updateAccount(a.id, { password: pw }).then(() => setPw("")), `${a.name}'s password is changed; their sessions ended.`)}>Set password</button>
            <button className="btn ghost danger sm" onClick={() => { if (confirm(`Delete ${a.email}? Their chats stay; the account cannot sign in again.`)) void act(() => api.deleteAccount(a.id), `${a.email} deleted.`); }}>Delete</button>
          </div>
          {a.instructions && <details className="small"><summary>Their instructions</summary><pre className="ad-pre">{a.instructions}</pre></details>}
        </td></tr>
      )}
    </>
  );
}

function NewAccount({ sites, onDone }: { sites: Site[]; onDone: (ok: string) => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "", role: "developer" as Role, daily: "", monthly: "" });
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const num = (s: string) => (s.trim() ? Number(s.replace(/[,_\s]/g, "")) : undefined);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try {
      await api.createAccount({ name: f.name, email: f.email, password: f.password, role: f.role, siteIds: f.role === "client" ? siteIds : undefined, limits: { dailyTokens: num(f.daily), monthlyTokens: num(f.monthly) } });
      onDone(`${f.email} can sign in now. Give them the password yourself - it is not sent anywhere.`);
    } catch (e2) { setErr((e2 as Error).message); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="ad-new" onSubmit={submit}>
      <div className="ad-grid">
        <label>Name <input value={f.name} onChange={set("name")} /></label>
        <label>Email <input type="email" required value={f.email} onChange={set("email")} autoComplete="off" /></label>
        <label>First password <small className="muted">(10+)</small><input type="text" required minLength={10} value={f.password} onChange={set("password")} autoComplete="off" /></label>
        <label>Role <select value={f.role} onChange={set("role")}>{(["developer", "client", "owner"] as Role[]).map((r) => <option key={r} value={r}>{r} - {ROLE_NOTE[r]}</option>)}</select></label>
        <label>Daily token limit <input inputMode="numeric" value={f.daily} onChange={set("daily")} placeholder="no limit" /></label>
        <label>Monthly token limit <input inputMode="numeric" value={f.monthly} onChange={set("monthly")} placeholder="no limit" /></label>
      </div>
      {f.role === "client" && (
        <fieldset className="ad-sites"><legend>Sites this client may use</legend>
          {sites.map((s) => <label key={s.id} className="ad-check"><input type="checkbox" checked={siteIds.includes(s.id)} onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))} /> {s.name}</label>)}
        </fieldset>
      )}
      {err && <div className="banner error">{err}</div>}
      <div className="dialog-actions left"><button className="btn primary sm">Create account</button></div>
    </form>
  );
}

/* ------------------------------------------------------------------ jobs */

function Jobs({ sites }: { sites: Site[] }) {
  const [q, setQ] = useState({ status: "", site: "", q: "" });
  const [rows, setRows] = useState<AdminJobRow[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState("");
  useEffect(() => {
    const t = setTimeout(() => api.adminJobs(q).then((r) => { setRows(r.jobs); setErr(""); }).catch((e) => setErr((e as Error).message)), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <div className="us-filters ad-bar">
        <label>Status <select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })}>{["", "running", "queued", "paused", "completed", "failed", "interrupted"].map((s) => <option key={s} value={s}>{s || "any"}</option>)}</select></label>
        <label>Site <select value={q.site} onChange={(e) => setQ({ ...q, site: e.target.value })}><option value="">any</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="grow">Search <input value={q.q} onChange={(e) => setQ({ ...q, q: e.target.value })} placeholder="job id, words of the request, error…" /></label>
      </div>
      {err && <div className="banner error">{err}</div>}
      {!rows ? <p className="muted"><span className="spin" /> Loading…</p> : rows.length === 0 ? <p className="muted">No chats match.</p> : (
        <table className="us-table ad-jobs">
          <thead><tr><th>Chat</th><th>Status</th><th>Site</th><th>Who</th><th className="num">Steps</th><th className="num">Tokens</th><th>Last change</th></tr></thead>
          <tbody>
            {rows.map((j) => (
              <JobRow key={j.id} j={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? "" : j.id)} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function JobRow({ j, open, onToggle }: { j: AdminJobRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`ad-click${j.status === "failed" ? " ad-bad" : ""}`} onClick={onToggle}>
        <th scope="row"><span className="us-name">{j.prompt || "(no text)"}</span><small className="us-note"><code>{j.id}</code>{j.requests > 1 ? ` · ${j.requests} requests` : ""}{j.changes ? ` · ${j.changes} changes` : ""}{j.waiting ? ` · ${j.waiting} waiting for approval` : ""}</small>{j.error && <small className="ad-err">{j.error}</small>}</th>
        <td><span className={`dot ${j.status}`} /> {j.status}</td>
        <td className="dim">{j.site ?? j.siteId}</td>
        <td className="dim">{j.account ?? (j.actor ? `widget: ${j.actor}` : "-")}</td>
        <td className="num dim">{j.usage?.calls ?? 0}</td>
        <td className="num">{short((j.usage?.input ?? 0) + (j.usage?.output ?? 0))}</td>
        <td className="dim">{when(j.updatedAt)}</td>
      </tr>
      {open && <tr className="ad-edit"><td colSpan={7}><JobTrace id={j.id} /></td></tr>}
    </>
  );
}

/** One chat, step by step: what the model was, what it cost, what the tools did, what failed. */
function JobTrace({ id }: { id: string }) {
  const [d, setD] = useState<{ job: any; events: any[]; steps: any[] } | null>(null);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState("");
  useEffect(() => { api.adminJob(id).then(setD).catch((e) => setErr((e as Error).message)); }, [id]);
  const kinds = useMemo(() => [...new Set((d?.events ?? []).map((e) => e.type))], [d]);
  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <p className="muted"><span className="spin" /> Reading the chat…</p>;
  const j = d.job;
  return (
    <div className="ad-trace">
      <div className="ad-facts">
        {Object.entries({ Model: j.model || "default", Approval: j.approvalMode, Page: j.pageUrl || "-", Voice: j.voice ? "yes" : "no", Account: j.account || "-", Widget: j.actor?.login || "-",
          Messages: j.messages, Created: when(j.createdAt) }).map(([k, v]) => <div key={k}><span>{k}</span><b>{String(v)}</b></div>)}
      </div>
      {j.error && <div className="banner error">{j.error}</div>}
      <div className="dialog-actions left">
        <button className="btn sm" onClick={() => copy(JSON.stringify(d, null, 2))}>Copy everything as JSON</button>
        <button className="btn sm" onClick={() => copy(j.id)}>Copy job id</button>
      </div>
      {d.steps.length > 0 && (
        <>
          <h3>Model calls</h3>
          <table className="us-table"><thead><tr><th>#</th><th>Request</th><th>Model</th><th className="num">In</th><th className="num">Cached</th><th className="num">Out</th><th className="num">Time</th><th>Ended</th></tr></thead>
            <tbody>{d.steps.map((s, i) => <tr key={i}><td className="dim">{s.step}</td><td className="dim">{s.request ?? 1}</td><td>{s.model}</td><td className="num">{n(s.input)}</td><td className="num dim">{n(s.cachedInput)}</td><td className="num">{n(s.output)}</td><td className="num dim">{s.ms ? `${(s.ms / 1000).toFixed(1)}s` : "-"}</td><td className="dim">{s.finish ?? "-"}</td></tr>)}</tbody>
          </table>
        </>
      )}
      <h3>Events <select value={kind} onChange={(e) => setKind(e.target.value)} className="ad-inline"><option value="">all ({d.events.length})</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></h3>
      <div className="ad-events">
        {d.events.filter((e) => !kind || e.type === kind).map((e) => {
          const { seq, type, at, ...rest } = e;
          const body = JSON.stringify(rest.data ?? rest);
          return (
            <details key={seq} className={`ad-ev ad-ev-${type}`}>
              <summary><span className="dim">{when(at)}</span> <b>{type}</b> <span className="ad-ev-sum">{body.slice(0, 160)}</span></summary>
              <pre className="ad-pre">{JSON.stringify(rest.data ?? rest, null, 2)}</pre>
            </details>
          );
        })}
      </div>
      {j.changes?.length > 0 && (
        <>
          <h3>Changes</h3>
          <pre className="ad-pre">{JSON.stringify(j.changes, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ logs */

function Logs() {
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [level, setLevel] = useState("");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(false);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) return;
    const t = setTimeout(() => api.adminLogs({ day, level, q }).then((r) => { setRows(r.rows); setErr(""); }).catch((e) => setErr((e as Error).message)), 250);
    return () => clearTimeout(t);
  }, [day, level, q, live]);
  useEffect(() => {
    if (!live) return;
    const stop = new AbortController();
    api.followLogs((r) => setRows((cur) => [...cur.slice(-1999), r]), stop.signal);
    return () => stop.abort();
  }, [live]);
  useEffect(() => { if (live) end.current?.scrollIntoView({ block: "end" }); }, [rows, live]);
  const shown = rows.filter((r) => (!level || r.level === level) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="us-filters ad-bar">
        <label>Day <input type="date" value={day} disabled={live} onChange={(e) => setDay(e.target.value)} /></label>
        <label>Level <select value={level} onChange={(e) => setLevel(e.target.value)}><option value="">all</option><option value="error">errors</option><option value="warn">warnings</option><option value="info">info</option></select></label>
        <label className="grow">Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="job id, site, words…" /></label>
        <button className={`btn sm${live ? " primary" : ""}`} onClick={() => setLive(!live)}>{live ? "● Live - stop" : "Follow live"}</button>
        <button className="btn sm" onClick={() => copy(shown.map((r) => JSON.stringify(r)).join("\n"))}>Copy</button>
      </div>
      {err && <div className="banner error">{err}</div>}
      <div className="ad-log">
        {shown.length === 0 && <p className="muted small">{live ? "Waiting for the next line…" : "Nothing logged for these filters."}</p>}
        {shown.map((r, i) => {
          const { at, level: lv, msg, ...ctx } = r;
          return <div key={i} className={`ad-line ${lv}`}><span className="dim">{String(at).slice(11, 19)}</span> <b>{lv}</b> {msg} {Object.keys(ctx).length > 0 && <code className="dim">{JSON.stringify(ctx)}</code>}</div>;
        })}
        <div ref={end} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ prompt */

function Prompt({ sites }: { sites: Site[] }) {
  const [site, setSite] = useState("");
  const [account, setAccount] = useState("");
  const [accs, setAccs] = useState<AccountInfo[]>([]);
  const [d, setD] = useState<{ text: string; chars: number; note: string; site: { name: string } } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.adminAccounts().then((r) => setAccs(r.accounts)).catch(() => {}); }, []);
  useEffect(() => { api.adminPrompt(site || undefined, account || undefined).then((x) => { setD(x); setErr(""); }).catch((e) => setErr((e as Error).message)); }, [site, account]);
  return (
    <>
      <div className="us-filters ad-bar">
        <label>Site <select value={site} onChange={(e) => setSite(e.target.value)}><option value="">{sites[0]?.name ?? "first site"}</option>{sites.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {accs.length > 0 && <label>As account <select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">me</option>{accs.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}</select></label>}
        {d && <span className="muted small grow">{n(d.chars)} characters (~{n(d.chars / 4)} tokens)</span>}
        {d && <button className="btn sm" onClick={() => copy(d.text)}>Copy</button>}
      </div>
      {err && <div className="banner error">{err}</div>}
      {d && <><p className="muted small">{d.note}</p><pre className="ad-pre ad-prompt">{d.text}</pre></>}
    </>
  );
}
