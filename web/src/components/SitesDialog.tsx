import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { Site, SiteStatus } from "../types";

const host = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const norm = (u: string) => host(u).replace(/^www\./, "").toLowerCase();

/**
 * Sites: every connected WordPress site with a live connection check, and Reconnect (new Application Password),
 * Rename and Disconnect. The same address connected twice is flagged so the extra one can be removed.
 */
export function SitesDialog({ sites, currentId, onClose, onChanged, onSelect, onAdd }: {
  sites: Site[]; currentId?: string; onClose: () => void; onChanged: () => void; onSelect: (id: string) => void; onAdd: () => void;
}) {
  const [status, setStatus] = useState<Record<string, SiteStatus | "checking">>({});
  const [editing, setEditing] = useState<string>("");
  const [form, setForm] = useState({ name: "", username: "", appPassword: "" });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const check = (id: string) => {
    setStatus((s) => ({ ...s, [id]: "checking" }));
    api.siteStatus(id).then((r) => setStatus((s) => ({ ...s, [id]: r }))).catch((e) => setStatus((s) => ({ ...s, [id]: { ok: false, ms: 0, error: e.message, checkedAt: new Date().toISOString() } })));
  };
  useEffect(() => { sites.forEach((s) => check(s.id)); }, [sites.map((s) => s.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const dupes = new Set(sites.filter((s, i) => sites.findIndex((x) => norm(x.url) === norm(s.url)) !== i).map((s) => s.id));

  async function save(s: Site) {
    setBusy("save:" + s.id); setErr(""); setNote("");
    try {
      await api.updateSite(s.id, { name: form.name.trim() || undefined, username: form.username.trim() || undefined, appPassword: form.appPassword.trim() || undefined });
      setEditing(""); setNote(`${form.name.trim() || s.name} is reconnected.`); onChanged(); check(s.id);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }
  async function remove(s: Site) {
    if (!confirm(`Disconnect ${s.name} (${host(s.url)})?\n\nThe assistant can no longer change this site. Nothing on the site itself is changed, and you can connect it again any time.`)) return;
    setBusy("del:" + s.id); setErr("");
    try { await api.deleteSite(s.id); setNote(`${s.name} was disconnected.`); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="int-head">
          <span className="int-logo"><Icon.Globe size={18} /></span>
          <div className="grow"><h2>Sites</h2><p className="muted small">WordPress sites the assistant can work on. Checks run live against each site.</p></div>
          <button className="btn sm" onClick={() => { onClose(); onAdd(); }}><Icon.Plus size={14} /> Connect a site</button>
        </div>

        {sites.length === 0 && <div className="rempty"><strong>No sites yet</strong><p>Connect a WordPress site that has the Livecrafts plugin.</p></div>}

        <div className="site-list">
          {sites.map((s) => {
            const st = status[s.id];
            const ok = st && st !== "checking" && st.ok;
            const isEditing = editing === s.id;
            return (
              <div key={s.id} className={`site-card ${s.id === currentId ? "current" : ""}`}>
                <div className="sc-top">
                  <span className={`sc-dot ${st === "checking" || !st ? "wait" : ok ? "ok" : "bad"}`} />
                  <div className="grow sc-names">
                    <b>{s.name}</b>
                    <a href={s.url} target="_blank" rel="noreferrer">{host(s.url)} <Icon.External size={11} /></a>
                  </div>
                  {s.id === currentId ? <span className="int-state ok sm">In use</span> : <button className="btn sm" onClick={() => { onSelect(s.id); onClose(); }}>Use</button>}
                </div>
                {dupes.has(s.id) && <div className="sc-warn">Duplicate: this address is connected more than once. Keep one and disconnect the others.</div>}
                <div className="sc-facts">
                  {st === "checking" || !st ? <span><span className="spin" /> Checking connection…</span>
                    : st.ok ? <>
                        <span><Icon.Check size={12} /> Connected as <b>{st.user?.login ?? s.username}</b> · {st.ms} ms</span>
                        <span>Plugin {st.plugin ?? "?"}{st.plugin && st.plugin < "0.8.0" ? <em className="sc-old"> (update to 0.8 for all features)</em> : ""} · WordPress {st.wp ?? "?"}</span>
                        <span>Theme files: {st.themeFiles ? <b>enabled</b> : <em>not available{st.user && !st.user.can_edit_themes ? " - the WordPress user is not an administrator" : ""}</em>}{st.theme ? ` · ${st.theme}` : ""}</span>
                        <span>Hosting: {s.hosting ? `Hostinger · ${s.hosting.domain}` : "not linked"}</span>
                      </>
                    : <span className="sc-err"><Icon.Close size={12} /> {st.error}</span>}
                </div>
                {isEditing ? (
                  <form className="sc-form" onSubmit={(e) => { e.preventDefault(); void save(s); }}>
                    <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={s.name} /></label>
                    <label>WordPress username <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={s.username} autoComplete="off" /></label>
                    <label>New Application Password <input type="password" value={form.appPassword} onChange={(e) => setForm({ ...form, appPassword: e.target.value })} placeholder="leave empty to keep the current one" autoComplete="new-password" /></label>
                    <p className="muted small">WordPress → Users → Profile → Application Passwords. The connection is tested before saving.</p>
                    <div className="dialog-actions left">
                      <button className="btn primary sm" disabled={!!busy}>{busy === "save:" + s.id ? "Testing…" : "Save & reconnect"}</button>
                      <button type="button" className="btn sm" onClick={() => setEditing("")}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div className="sc-actions">
                    <button className="rbtn" onClick={() => check(s.id)} disabled={st === "checking"}><Icon.Retry size={13} /> Check</button>
                    <button className="rbtn" onClick={() => { setEditing(s.id); setForm({ name: s.name, username: s.username, appPassword: "" }); setErr(""); }}><Icon.Key size={13} /> {ok ? "Edit / reconnect" : "Reconnect"}</button>
                    <span className="grow" />
                    <button className="rbtn danger" disabled={!!busy} onClick={() => void remove(s)}>{busy === "del:" + s.id ? "Disconnecting…" : "Disconnect"}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {note && <div className="banner ok">{note}</div>}
        {err && <div className="banner error">{err}</div>}
        <div className="dialog-actions"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
