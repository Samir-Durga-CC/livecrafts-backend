import { useEffect, useState } from "react";
import { api, setToken, getToken } from "../api";
import { Icon } from "../icons";
import type { HostingerHealth, Site } from "../types";

export function SiteDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (s: Site) => void }) {
  const [f, setF] = useState({ name: "", url: "", username: "", appPassword: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try { onAdded(await api.addSite(f)); onClose(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Connect a WordPress site</h2>
        <p className="muted">The site needs the Livecrafts plugin (0.6+). We check the login before saving.</p>
        <label>Site name <input value={f.name} onChange={set("name")} placeholder="Aeromatic (optional)" /></label>
        <label>Site address <input required value={f.url} onChange={set("url")} placeholder="https://example.com" /></label>
        <label>WordPress username <input required value={f.username} onChange={set("username")} placeholder="admin" autoComplete="off" /></label>
        <label>Application Password <input required type="password" value={f.appPassword} onChange={set("appPassword")} placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" autoComplete="new-password" /></label>
        <p className="muted small">Create it in WordPress: Users → Profile → Application Passwords. This is not your normal login password.</p>
        {err && <div className="banner error">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Connect"}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Settings → Integrations → Hostinger. Paste an API token, the backend saves it (never sent back to the browser),
 * connects to the Hostinger MCP server and runs a health check. Sites on the account are linked to their folder.
 */
export function IntegrationsDialog({ sites, onClose, onSites }: { sites: Site[]; onClose: () => void; onSites: () => void }) {
  const [h, setH] = useState<HostingerHealth | null>(null);
  const [token, setTokenInput] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "save" | "test" | "remove" | string>("load");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => { api.integrations().then((r) => setH(r.hostinger)).catch((e) => setErr(e.message)).finally(() => setBusy("")); }, []);

  async function run(kind: string, fn: () => Promise<HostingerHealth | void>) {
    setBusy(kind); setErr(""); setNote("");
    try { const r = await fn(); if (r) setH(r); onSites(); }
    catch (e) { setErr((e as Error).message); if (kind === "save") api.integrations().then((r) => setH(r.hostinger)).catch(() => {}); }
    finally { setBusy(""); }
  }
  async function link(s: Site) {
    setBusy("link:" + s.id); setErr(""); setNote("");
    try { const r = await api.linkHosting(s.id); onSites(); setNote(`${s.name} is linked to ${r.hosting?.domain ?? "its hosting folder"}.`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  const state = !h ? "load" : h.connected ? "ok" : h.configured ? "bad" : "off";
  const STATE = { load: "Checking…", ok: "Connected", bad: "Connection problem", off: "Not connected" } as const;

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="int-head">
          <span className="int-logo"><Icon.Plug size={18} /></span>
          <div className="grow"><h2>Hostinger</h2><p className="muted small">Lets the assistant read your hosting account and edit theme files (CSS/JS) — always with your approval.</p></div>
          <span className={`int-state ${state}`}>{state === "load" && <span className="spin" />}{STATE[state]}</span>
        </div>

        {h && (
          <div className="int-facts">
            <div><span>Token</span><b>{h.tokenSource === "env" ? "From the backend .env file" : h.tokenSource === "saved" ? "Saved on the backend" : "Not set"}</b></div>
            {h.connected && <div><span>Websites found</span><b>{h.websites ?? 0}</b></div>}
            <div><span>Last check</span><b>{new Date(h.checkedAt).toLocaleTimeString()}</b></div>
            {h.error && <div className="int-err"><span>Error</span><b>{h.error}</b></div>}
          </div>
        )}

        {h?.tokenSource !== "env" && (
          <form className="int-form" onSubmit={(e) => { e.preventDefault(); if (token.trim()) void run("save", async () => { const r = await api.saveHostinger(token.trim()); setTokenInput(""); setNote("Connected. Your sites on this account were linked automatically."); return r; }); }}>
            <label>{h?.configured ? "Replace API token" : "API token"}
              <input type="password" value={token} onChange={(e) => setTokenInput(e.target.value)} placeholder="Paste your Hostinger API token" autoComplete="off" />
            </label>
            <p className="muted small">Get it in hPanel → Profile (top right) → <b>API</b> → Generate token. It is stored only on your backend, never in this browser.</p>
            <div className="dialog-actions left">
              <button className="btn primary" disabled={!token.trim() || !!busy}>{busy === "save" ? "Connecting…" : "Save & test"}</button>
              {h?.configured && <button type="button" className="btn" disabled={!!busy} onClick={() => void run("test", api.testHostinger)}>{busy === "test" ? "Testing…" : "Test connection"}</button>}
              {h?.tokenSource === "saved" && <button type="button" className="btn ghost danger" disabled={!!busy} onClick={() => { if (confirm("Remove the Hostinger token from the backend? File editing will stop working.")) void run("remove", api.removeHostinger); }}>Remove</button>}
            </div>
          </form>
        )}
        {h?.tokenSource === "env" && (
          <div className="dialog-actions left"><button className="btn" disabled={!!busy} onClick={() => void run("test", api.testHostinger)}>{busy === "test" ? "Testing…" : "Test connection"}</button></div>
        )}

        {sites.length > 0 && (
          <div className="int-sites">
            <div className="menu-label">Your sites</div>
            {sites.map((s) => (
              <div key={s.id} className="int-site">
                <Icon.Globe size={15} />
                <div className="grow"><b>{s.name}</b><small>{s.hosting ? <><Icon.Folder size={11} /> {s.hosting.domain}/public_html{s.hosting.dir && s.hosting.dir !== "/" ? s.hosting.dir : ""}</> : "Not linked: only content edits (no CSS / theme files)"}</small></div>
                {s.hosting ? <span className="int-state ok sm">Linked</span>
                  : <button className="btn sm" disabled={!h?.connected || !!busy} onClick={() => void link(s)}>{busy === "link:" + s.id ? "Linking…" : "Link"}</button>}
              </div>
            ))}
          </div>
        )}

        {note && <div className="banner ok">{note}</div>}
        {err && <div className="banner error">{err}</div>}
        <div className="dialog-actions"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

export function TokenDialog({ onClose, reason }: { onClose: () => void; reason?: string }) {
  const [t, setT] = useState(getToken());
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); setToken(t.trim()); onClose(); location.reload(); }}>
        <h2>Backend access token</h2>
        <p className="muted">{reason ?? "This backend asks for a token (LC_API_TOKEN in its .env). It is stored only in this browser."}</p>
        <label>Token <input type="password" value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" /></label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </div>
  );
}
