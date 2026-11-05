import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { JiraStatus } from "../types";

/**
 * Account menu → Jira: connect YOUR Jira Cloud. The assistant then reads and files tickets as you, in the Jira project
 * each Livecrafts project is linked to - so Jira's own permissions and history apply, and nobody shares a token.
 */
export function JiraDialog({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<JiraStatus | null>(null);
  const [f, setF] = useState({ siteUrl: "", email: "", token: "" });
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.jira().then((s) => { setSt(s); setEdit(!s.connected); if (s.connected) setF({ siteUrl: s.siteUrl ?? "", email: s.email ?? "", token: "" }); })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  async function connect(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const s = await api.connectJira({ siteUrl: f.siteUrl, email: f.email, token: f.token || undefined }); setSt(s); setEdit(false); setF({ ...f, token: "" }); setMsg({ ok: true, text: `Connected as ${s.accountName}.` }); }
    catch (e2) { setMsg({ ok: false, text: (e2 as Error).message }); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!confirm("Disconnect your Jira? The assistant stops reading and filing tickets for you; the token is deleted from the backend.")) return;
    setBusy(true);
    try { setSt(await api.disconnectJira()); setEdit(true); setF({ siteUrl: "", email: "", token: "" }); setMsg(null); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={connect}>
        <h2>Jira</h2>
        {!st && !msg && <p className="muted"><span className="spin" /> Loading…</p>}
        {st?.connected && !edit && (
          <>
            <p className="small">Connected to <b>{st.siteUrl?.replace(/^https:\/\//, "")}</b> as <b>{st.accountName}</b> ({st.email}).</p>
            <p className="muted small">In a project linked to a Jira project, the assistant can find and read its tickets, and - with your approval each time - create tickets, comment and move them. Always as you, only in that Jira project.</p>
          </>
        )}
        {edit && (
          <>
            <p className="muted small">Jira Cloud only. The token stays on the Livecrafts backend and is never shown again.</p>
            <ol className="conn-steps">
              <li>Open <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Atlassian → Security → API tokens <Icon.External size={12} /></a> and create a token named "Livecrafts".</li>
              <li>Paste it below with the email you sign in to Atlassian with.</li>
            </ol>
            <label>Jira site <input required value={f.siteUrl} onChange={set("siteUrl")} placeholder="your-team.atlassian.net" /></label>
            <label>Atlassian email <input type="email" required value={f.email} onChange={set("email")} autoComplete="off" /></label>
            <label>API token <input type="password" required={!st?.connected} value={f.token} onChange={set("token")} placeholder={st?.connected ? "leave empty to keep the current one" : "paste the token"} autoComplete="off" /></label>
          </>
        )}
        {msg && <div className={`banner ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
        <div className="dialog-actions">
          {st?.connected && <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {st?.connected && !edit && <button type="button" className="btn" onClick={() => setEdit(true)}>Change</button>}
          {edit && <button className="btn primary" disabled={busy}>{busy ? "Checking with Jira…" : "Connect"}</button>}
        </div>
      </form>
    </div>
  );
}
