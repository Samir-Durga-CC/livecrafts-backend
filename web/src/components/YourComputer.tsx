import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { ConnectorInfo } from "../types";

/**
 * Inside the Claude CLI card: connect the person's own computer, so a backend on a server answers with the Claude
 * subscription that computer is signed in with - no API key, no tunnel, no port opened on the computer.
 *
 * Three states, one at a time: nothing set up (one button), waiting for the computer (the two commands, with the
 * token in them - shown once), connected (which computer, which Claude, and a way to cut it off).
 */
export function YourComputer({ onChange }: { onChange: () => void }) {
  const [info, setInfo] = useState<ConnectorInfo | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");

  const load = () => api.connector().then(setInfo).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  // Waiting for the computer to come online: look every few seconds, and tell the card once it has.
  const waiting = !!info && !info.connected && !!token;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api.connector().then((i) => { setInfo(i); if (i.connected) { setToken(""); onChange(); } }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [waiting]);

  async function create() {
    if (info?.connected && !confirm(`${info.machine} is connected now. A new token disconnects it until you start the connector there again with the new command. Continue?`)) return;
    setBusy(true); setErr("");
    try { const r = await api.newConnectorToken(); setToken(r.token); setInfo(r); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (!confirm("Disconnect your computer? Its token stops working; the Claude CLI here can only answer again after you make a new one.")) return;
    setBusy(true); setErr("");
    try { setInfo(await api.revokeConnector()); setToken(""); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); } catch { /* the text is selectable too */ }
  }

  const origin = location.origin;
  const cmds = [
    { id: "get", label: "Download it (Windows PowerShell)", text: `irm ${origin}/connector.mjs -OutFile livecrafts-connector.mjs` },
    { id: "get-mac", label: "…or on macOS / Linux", text: `curl -fsSo livecrafts-connector.mjs ${origin}/connector.mjs` },
    { id: "run", label: "Start it, in the same folder", text: `node livecrafts-connector.mjs --server ${origin} --token ${token}` },
  ];
  const c = info?.claude;

  return (
    <div className="yc">
      <div className="yc-head">
        <Icon.Monitor size={16} />
        <b className="grow">Your computer</b>
        {info?.connected
          ? <span className="conn-pill ok">Connected</span>
          : <span className="conn-pill">{waiting ? "Waiting…" : "Not connected"}</span>}
      </div>

      {!info && !err && <div className="diff-loading"><span className="spin" /> Loading…</div>}

      {info?.connected && (
        <>
          <p className="small">
            <b>{info.machine}</b> answers for this backend
            {c?.version ? <> with Claude Code <code>{c.version.replace(/\s*\(Claude Code\)/, "")}</code></> : null}
            {c?.loggedIn ? <>, signed in{c.authMethod ? ` (${c.authMethod})` : ""}.</> : "."}
            {info.running ? <> Running {info.running} step{info.running > 1 ? "s" : ""} now.</> : null}
          </p>
          {c && !(c.installed && c.loggedIn) && <div className="banner error">{c.error} {c.fix}</div>}
          <div className="dialog-actions left">
            <button className="btn sm" disabled={busy} onClick={() => void create()}>New token</button>
            <button className="btn ghost danger sm" disabled={busy} onClick={() => void revoke()}>Disconnect</button>
          </div>
        </>
      )}

      {info && !info.connected && !token && (
        <>
          <p className="muted small">
            Use the Claude subscription on your own computer, even though this backend runs on a server. A small program
            on your computer keeps one connection open to here; Claude only answers through it - it cannot open files or
            run anything on your computer.
          </p>
          <div className="dialog-actions left">
            <button className="btn primary sm" disabled={busy} onClick={() => void create()}>{busy ? "Making a token…" : info.hasToken ? "Connect again (new token)" : "Connect your computer"}</button>
            {info.hasToken && <button className="btn ghost danger sm" disabled={busy} onClick={() => void revoke()}>Revoke the old token</button>}
          </div>
          {info.hasToken && <p className="muted small">A computer was set up before. If it still has its saved settings, just run <code>node livecrafts-connector.mjs</code> there.</p>}
        </>
      )}

      {token && !info?.connected && (
        <>
          <ol className="conn-steps">
            <li>On your computer: Node.js 22+ and Claude Code, signed in once with <code>claude auth login</code>.</li>
            <li>Run these in a terminal. The token is shown only now - it is saved on your computer the first time.</li>
          </ol>
          {cmds.map((x) => (
            <div key={x.id} className="yc-cmd">
              <small className="muted">{x.label}</small>
              <div>
                <code>{x.text}</code>
                <button className="rbtn" title="Copy" onClick={() => void copy(x.id, x.text)}>
                  {copied === x.id ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
                </button>
              </div>
            </div>
          ))}
          <p className="muted small"><span className="spin" /> Waiting for your computer to connect… leave its window open while you use Livecrafts.</p>
        </>
      )}

      {err && <div className="banner error">{err}</div>}
    </div>
  );
}
