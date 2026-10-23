import { useEffect, useState } from "react";
import { api, setToken, getToken } from "../api";
import { Icon } from "../icons";
import type { HostingerHealth, ProviderInfo, Site } from "../types";

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
export function IntegrationsDialog({ sites, onClose, onSites, initialTab = "models" }: { sites: Site[]; onClose: () => void; onSites: () => void; initialTab?: "models" | "hostinger" | "pagespeed" }) {
  const [tab, setTab] = useState<"models" | "hostinger" | "pagespeed">(initialTab);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="rtabs dialog-tabs" role="tablist">
          <button role="tab" className={tab === "models" ? "on" : ""} onClick={() => setTab("models")}><Icon.Sparkle size={15} /> AI models</button>
          <button role="tab" className={tab === "hostinger" ? "on" : ""} onClick={() => setTab("hostinger")}><Icon.Plug size={15} /> Hostinger</button>
          <button role="tab" className={tab === "pagespeed" ? "on" : ""} onClick={() => setTab("pagespeed")}><Icon.Gauge size={15} /> PageSpeed</button>
        </div>
        {tab === "models" ? <ModelsSection /> : tab === "hostinger" ? <HostingerSection sites={sites} onSites={onSites} /> : <PagespeedSection />}
        <div className="dialog-actions"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/**
 * PageSpeed: a Google API key for PageSpeed Insights (free; without one Google allows only a few tests). Stored on the
 * backend only. Sites on localhost do not need it: they are tested with this computer's Chrome / Edge.
 */
function PagespeedSection() {
  const [source, setSource] = useState<"env" | "saved" | "none" | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { api.integrations().then((r) => setSource(r.pagespeed?.keySource ?? "none")).catch((e) => setErr(e.message)); }, []);
  async function run(fn: () => Promise<{ pagespeed: { keySource: "env" | "saved" | "none" } }>, done: string) {
    setBusy(true); setErr(""); setNote("");
    try { const r = await fn(); setSource(r.pagespeed.keySource); setKey(""); setNote(done); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const STATE = { env: "From the backend .env file", saved: "Saved on the backend", none: "Not set" } as const;
  return (
    <>
      <div className="int-head">
        <span className="int-logo"><Icon.Gauge size={18} /></span>
        <div className="grow"><h2>Google PageSpeed</h2><p className="muted small">Speed reports in the widget's Speed tab and in chat. Free: create an API key in Google Cloud Console and enable the “PageSpeed Insights API” for it.</p></div>
        <span className={`int-state ${source === "env" || source === "saved" ? "ok" : "off"}`}>{source === null ? <span className="spin" /> : source === "none" ? "No key" : "Key set"}</span>
      </div>
      <div className="int-facts">
        <div><span>API key</span><b>{source ? STATE[source] : "…"}</b></div>
        <div><span>Without a key</span><b>Works, but Google allows only a few tests</b></div>
        <div><span>Local sites</span><b>localhost is tested with this computer's Chrome / Edge (no key needed)</b></div>
      </div>
      {source !== "env" && (
        <form className="int-form" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void run(() => api.savePagespeedKey(key.trim()), "Saved. The next report uses this key."); }}>
          <label>{source === "saved" ? "Replace API key" : "API key"}
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" />
          </label>
          <p className="muted small">Stored only on your backend, never in this browser.</p>
          <div className="dialog-actions left">
            <button className="btn primary" disabled={busy || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
            {source === "saved" && <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void run(() => api.removePagespeedKey(), "Key removed.")}>Remove</button>}
          </div>
        </form>
      )}
      {err && <div className="banner error">{err}</div>}
      {note && <div className="banner ok">{note}</div>}
    </>
  );
}

/**
 * AI models: one API key per provider (stored on the backend only) + a real test call.
 * The model per site is chosen in WordPress (Settings → Livecrafts Assistant) or per chat; empty = the default.
 */
function ModelsSection() {
  const [list, setList] = useState<ProviderInfo[] | null>(null);
  const [def, setDef] = useState("");
  const [open, setOpen] = useState<string>("");
  const [form, setForm] = useState({ apiKey: "", baseUrl: "", model: "" });
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [newModel, setNewModel] = useState<Record<string, string>>({});

  useEffect(() => { api.integrations().then((r) => { setList(r.models); setDef(r.defaultModel); }).catch((e) => setMsg({ id: "", ok: false, text: e.message })); }, []);

  /** Looks at the Claude CLI on the backend machine again, so signing in there needs no restart and no reload. */
  async function recheck() {
    setBusy("recheck"); setMsg(null);
    try {
      const r = await api.recheckProviders();
      setList(r.models);
      const cli = r.models.find((x) => x.id === "claudecli");
      setMsg({ id: "claudecli", ok: !!cli?.ready, text: cli?.ready ? `The Claude CLI is ready${cli.cli?.version ? ` (${cli.cli.version})` : ""} - no API key needed.` : (cli?.fix ?? cli?.reason ?? "The Claude CLI still cannot answer.") });
    } catch (e) { setMsg({ id: "claudecli", ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  /** Adds a model name to a provider after one real request proves the key can use it. */
  async function addModel(p: ProviderInfo) {
    const name = (newModel[p.id] ?? "").trim();
    if (!name) return;
    setBusy(`add:${p.id}`); setMsg(null);
    try {
      const r = await api.addProviderModel(p.id, name);
      setList(r.models); setNewModel({ ...newModel, [p.id]: "" });
      setMsg({ id: p.id, ok: true, text: `${name} works. Pick it as ${p.id}:${name}.` });
    } catch (e) { setMsg({ id: p.id, ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }
  async function dropModel(p: ProviderInfo, model: string) {
    setBusy(`add:${p.id}`);
    try { const r = await api.removeProviderModel(p.id, model); setList(r.models); } finally { setBusy(""); }
  }

  async function save(p: ProviderInfo) {
    setBusy(p.id); setMsg(null);
    try {
      const r = await api.saveProvider(p.id, { apiKey: form.apiKey.trim() || undefined, baseUrl: p.needsBaseUrl ? form.baseUrl.trim() : undefined, testModel: form.model.trim() || p.examples[0] });
      setList(r.models); setForm({ apiKey: "", baseUrl: "", model: "" }); setOpen("");
      setMsg({ id: p.id, ok: true, text: `${p.name} works${r.test ? ` (answered in ${(r.test.ms / 1000).toFixed(1)} s)` : ""}. Use it as ${p.id}:${form.model.trim() || p.examples[0]}` });
    } catch (e) { setMsg({ id: p.id, ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }
  async function remove(p: ProviderInfo) {
    if (!confirm(`Remove the ${p.name} key from the backend?`)) return;
    setBusy(p.id);
    try { const r = await api.removeProvider(p.id); setList(r.models); } finally { setBusy(""); }
  }

  return (
    <>
      <div className="int-head">
        <span className="int-logo"><Icon.Sparkle size={18} /></span>
        <div className="grow"><h2>AI models</h2><p className="muted small">Add a key for each AI provider you want to use. Keys stay on your backend and are never shown again.</p></div>
      </div>
      <div className="int-facts"><div><span>Default model</span><b><code>{def || "…"}</code> <small className="muted">(LC_MODEL in the backend .env)</small></b></div></div>
      <div className="prov-list">
        {!list && <div className="diff-loading"><span className="spin" /> Loading…</div>}
        {list?.map((p) => (
          <div key={p.id} className="prov">
            <div className="prov-top">
              <span className={`sc-dot ${p.ready ? "ok" : "off"}`} />
              <div className="grow"><b>{p.name}</b><small>{p.ready
                ? `${p.keySource === "env" ? "Key from the backend .env" : p.keySource === "cli" ? `Signed in on this machine${p.cli?.authMethod ? ` (${p.cli.authMethod})` : ""} - no API key needed` : p.id === "custom" ? `Address: ${p.baseUrl}` : "Key saved on the backend"} · e.g. `
                // "Add it in Integrations" is the right thing to say in the model picker, but not here - this IS
                // Integrations. Providers that sign themselves in keep their own instruction.
                : `${p.needsNoKey ? p.fix ?? p.reason : `${p.reason ?? "Not set up"} Get one at ${p.keyHelp}.`} · `}<code>{p.id}:{p.models[0] ?? p.examples[0]}</code></small></div>
              {/* The CLI signs itself in, so it has no key to save or remove - only a state to look at again. */}
              {p.needsNoKey
                ? <button className="rbtn" disabled={!!busy} onClick={() => void recheck()}>{busy === "recheck" ? "Checking…" : "Check again"}</button>
                : <>
                    {p.ready && p.keySource !== "env" && <button className="rbtn danger" disabled={!!busy} onClick={() => void remove(p)}>Remove</button>}
                    <button className="rbtn" onClick={() => { setOpen(open === p.id ? "" : p.id); setForm({ apiKey: "", baseUrl: p.baseUrl ?? "", model: p.examples[0] }); setMsg(null); }}>{p.ready ? "Change" : "Set up"}</button>
                  </>}
            </div>
            {/* Which models this provider can be asked for. A key is not limited to the names we shipped, so any
                name can be added here - it is only kept once one real request proves it answers. */}
            {p.ready && (
              <div className="prov-models">
                {p.models.map((mdl) => (
                  <span key={mdl} className="chip">
                    <code>{mdl}</code>
                    {!p.examples.includes(mdl) && <button className="chip-x" title="Remove this model" disabled={!!busy} onClick={() => void dropModel(p, mdl)}>×</button>}
                  </span>
                ))}
                <form className="chip-add" onSubmit={(e) => { e.preventDefault(); void addModel(p); }}>
                  <input value={newModel[p.id] ?? ""} onChange={(e) => setNewModel({ ...newModel, [p.id]: e.target.value })} placeholder="add a model name…" aria-label={`Add a model for ${p.name}`} />
                  <button className="rbtn" disabled={!!busy || !(newModel[p.id] ?? "").trim()}>{busy === `add:${p.id}` ? "Testing…" : "Add"}</button>
                </form>
              </div>
            )}
            {open === p.id && (
              <form className="sc-form" onSubmit={(e) => { e.preventDefault(); void save(p); }}>
                {p.needsBaseUrl && <label>API address <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>}
                {p.keySource !== "env" && <label>API key {p.id === "custom" && <small className="muted">(optional)</small>}<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={p.ready ? "leave empty to keep the current key" : "paste the key"} autoComplete="off" /></label>}
                <label>Test with model <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={p.examples[0]} list={`ex-${p.id}`} />
                  <datalist id={`ex-${p.id}`}>{p.models.map((x) => <option key={x} value={x} />)}</datalist></label>
                <p className="muted small">Where to get a key: {p.keyHelp}. Saving makes one tiny real request to check it.</p>
                <div className="dialog-actions left">
                  <button className="btn primary sm" disabled={!!busy || (!p.ready && !form.apiKey.trim() && p.id !== "custom") || (p.needsBaseUrl && !form.baseUrl.trim())}>{busy === p.id ? "Testing…" : "Save & test"}</button>
                  <button type="button" className="btn sm" onClick={() => setOpen("")}>Cancel</button>
                </div>
              </form>
            )}
            {msg?.id === p.id && <div className={`banner ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
          </div>
        ))}
      </div>
      {msg && !msg.id && <div className="banner error">{msg.text}</div>}
      <p className="muted small">Pick the model for a site in WordPress → Settings → Livecrafts Assistant (format <code>provider:model</code>), or per chat with the model button.</p>
    </>
  );
}

function HostingerSection({ sites, onSites }: { sites: Site[]; onSites: () => void }) {
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
    <>
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
                <div className="grow"><b>{s.name}</b><small>{s.hosting ? <><Icon.Folder size={11} /> {s.hosting.domain}/public_html{s.hosting.dir && s.hosting.dir !== "/" ? "/" + s.hosting.dir.replace(/^\/+/, "") : ""}</> : "Not linked: only content edits (no CSS / theme files)"}</small></div>
                {s.hosting ? <span className="int-state ok sm">Linked</span>
                  : <button className="btn sm" disabled={!h?.connected || !!busy} onClick={() => void link(s)}>{busy === "link:" + s.id ? "Linking…" : "Link"}</button>}
              </div>
            ))}
          </div>
        )}

        {note && <div className="banner ok">{note}</div>}
        {err && <div className="banner error">{err}</div>}
    </>
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
