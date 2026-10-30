import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { ProviderInfo } from "../types";

/**
 * Settings → Integrations → AI connections (backend only, never the chat widget: a key must not be reachable from a
 * page on someone's site).
 *
 * The old screen was one flat list of providers with a bare "paste a key" box, which assumed you already knew where
 * that key comes from. This one works the way the Hostinger tab does: pick a platform, read the few steps for THAT
 * platform, paste, and the backend proves the key with one real request before it says connected.
 *
 * Claude comes first because it is what most people here connect: the CLI (no key - it answers on this machine's own
 * subscription) and the Anthropic API side by side.
 */

/** The steps for one platform. Everything else about a provider comes from the backend (PROVIDERS in models.ts). */
const GUIDE: Record<string, { blurb: string; steps: string[]; link?: { href: string; label: string } }> = {
  claudecli: {
    blurb: "Answers on this machine's own Claude subscription. No API key, and nothing leaves the backend except the request itself.",
    steps: [
      "Install it on the machine running this backend: npm i -g @anthropic-ai/claude-code",
      "Sign in there once: claude auth login",
      "Press “Check again” below - no key to paste.",
    ],
  },
  anthropic: {
    blurb: "Claude over the API, billed per token. Use this when the backend runs somewhere the CLI cannot (a server, a container).",
    steps: ["Open the Anthropic Console and go to API keys", "Create a key and copy it", "Paste it below and press “Save & test”"],
    link: { href: "https://console.anthropic.com/settings/keys", label: "console.anthropic.com → API keys" },
  },
  openai: {
    blurb: "GPT models, billed per token.",
    steps: ["Open the OpenAI platform → API keys", "Create a secret key and copy it", "Paste it below and press “Save & test”"],
    link: { href: "https://platform.openai.com/api-keys", label: "platform.openai.com → API keys" },
  },
  groq: {
    blurb: "Open models, very fast, with a free tier - a good choice for test runs so a demo does not spend real tokens.",
    steps: ["Open the Groq console → API Keys", "Create a key and copy it", "Paste it below and press “Save & test”"],
    link: { href: "https://console.groq.com/keys", label: "console.groq.com → API Keys" },
  },
  openrouter: {
    blurb: "One key for many vendors. Handy when you want to try a model without opening another account.",
    steps: ["Open OpenRouter → Keys", "Create a key and copy it", "Paste it below; model names look like anthropic/claude-sonnet-5.5"],
    link: { href: "https://openrouter.ai/keys", label: "openrouter.ai → Keys" },
  },
  gateway: {
    blurb: "Vercel's gateway in front of several vendors, with its own usage dashboard.",
    steps: ["Open the Vercel dashboard → AI Gateway → API keys", "Create a key and copy it", "Paste it below and press “Save & test”"],
    link: { href: "https://vercel.com/dashboard", label: "vercel.com → AI Gateway → API keys" },
  },
  custom: {
    blurb: "Anything that speaks the OpenAI API, including a model running on your own machine. Nothing is sent to a vendor and there is usually no key.",
    steps: [
      "Start the server (see the shortcuts below for the usual ones)",
      "Put its address in “API address” - it ends in /v1",
      "Put the model name it serves in “Test with model”, then “Save & test”",
    ],
  },
};

/**
 * One click instead of remembering a port. These all speak the OpenAI API, so the custom provider reaches them with
 * no code at all - which is the cheapest way to run tests.
 */
const LOCAL_PRESETS: { name: string; baseUrl: string; model: string; note: string }[] = [
  { name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder", note: "ollama serve" },
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "local-model", note: "Developer → Start server" },
  { name: "llama.cpp", baseUrl: "http://localhost:8080/v1", model: "local-model", note: "llama-server" },
  { name: "LiteLLM", baseUrl: "http://localhost:4000/v1", model: "gpt-4o-mini", note: "litellm --config …" },
];

/** Claude first, then the paid APIs, then the ones that stand in front of others, then your own machine. */
const ORDER = ["claudecli", "anthropic", "openai", "groq", "openrouter", "gateway", "custom"];
const rank = (id: string) => { const i = ORDER.indexOf(id); return i === -1 ? ORDER.length : i; };

export function ConnectionsSection() {
  const [list, setList] = useState<ProviderInfo[] | null>(null);
  const [def, setDef] = useState("");
  const [open, setOpen] = useState("");
  const [form, setForm] = useState({ apiKey: "", baseUrl: "", model: "" });
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [newModel, setNewModel] = useState<Record<string, string>>({});

  useEffect(() => {
    api.integrations().then((r) => { setList(r.models); setDef(r.defaultModel); })
      .catch((e) => setMsg({ id: "", ok: false, text: (e as Error).message }));
  }, []);

  const providers = list ? [...list].sort((a, b) => rank(a.id) - rank(b.id)) : null;
  const connected = providers?.filter((p) => p.ready).length ?? 0;

  function start(p: ProviderInfo) {
    setOpen(open === p.id ? "" : p.id);
    setForm({ apiKey: "", baseUrl: p.baseUrl ?? "", model: p.models[0] ?? p.examples[0] ?? "" });
    setMsg(null);
  }

  /** Looks at the Claude CLI on the backend machine again, so signing in there needs no restart and no reload. */
  async function recheck() {
    setBusy("recheck"); setMsg(null);
    try {
      const r = await api.recheckProviders();
      setList(r.models);
      const cli = r.models.find((x) => x.id === "claudecli");
      setMsg({ id: "claudecli", ok: !!cli?.ready, text: cli?.ready ? `Connected${cli.cli?.version ? ` (${cli.cli.version})` : ""} - no API key needed.` : (cli?.fix ?? cli?.reason ?? "The Claude CLI still cannot answer.") });
    } catch (e) { setMsg({ id: "claudecli", ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function save(p: ProviderInfo) {
    setBusy(p.id); setMsg(null);
    const model = form.model.trim() || p.examples[0];
    try {
      const r = await api.saveProvider(p.id, { apiKey: form.apiKey.trim() || undefined, baseUrl: p.needsBaseUrl ? form.baseUrl.trim() : undefined, testModel: model });
      setList(r.models); setForm({ apiKey: "", baseUrl: "", model: "" }); setOpen("");
      setMsg({ id: p.id, ok: true, text: `${p.name} is connected${r.test ? ` (answered in ${(r.test.ms / 1000).toFixed(1)} s)` : ""}. Ask for it as ${p.id}:${model}` });
    } catch (e) { setMsg({ id: p.id, ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function remove(p: ProviderInfo) {
    if (!confirm(`Disconnect ${p.name}? The key is deleted from the backend.`)) return;
    setBusy(p.id);
    try { const r = await api.removeProvider(p.id); setList(r.models); setOpen(""); } finally { setBusy(""); }
  }

  /** A model name is only kept once one real request proves this key can actually ask for it. */
  async function addModel(p: ProviderInfo) {
    const name = (newModel[p.id] ?? "").trim();
    if (!name) return;
    setBusy(`add:${p.id}`); setMsg(null);
    try {
      const r = await api.addProviderModel(p.id, name);
      setList(r.models); setNewModel({ ...newModel, [p.id]: "" });
      setMsg({ id: p.id, ok: true, text: `${name} answers. Ask for it as ${p.id}:${name}.` });
    } catch (e) { setMsg({ id: p.id, ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }
  async function dropModel(p: ProviderInfo, model: string) {
    setBusy(`add:${p.id}`);
    try { const r = await api.removeProviderModel(p.id, model); setList(r.models); } finally { setBusy(""); }
  }

  return (
    <>
      <div className="int-head">
        <span className="int-logo"><Icon.Sparkle size={18} /></span>
        <div className="grow">
          <h2>AI connections</h2>
          <p className="muted small">Pick a platform, follow its few steps, and the backend proves it works before saving. Keys live on the backend and are never sent back to a browser.</p>
        </div>
        <span className={`int-state ${connected ? "ok" : "off"}`}>{providers === null ? <span className="spin" /> : `${connected} connected`}</span>
      </div>

      <div className="int-facts">
        <div><span>Default model</span><b><code>{def || "…"}</code> <small className="muted">(LC_MODEL in the backend .env)</small></b></div>
        <div><span>Per site</span><b>WordPress → Settings → Livecrafts Assistant, as <code>provider:model</code></b></div>
        <div><span>Where this lives</span><b>This backend only - the chat widget never shows keys or this screen</b></div>
      </div>

      <div className="conn-grid">
        {!providers && <div className="diff-loading"><span className="spin" /> Loading…</div>}
        {providers?.map((p) => {
          const g = GUIDE[p.id];
          const isOpen = open === p.id;
          const where = p.keySource === "env" ? "Key from the backend .env"
            : p.keySource === "cli" ? `Signed in on this machine${p.cli?.authMethod ? ` (${p.cli.authMethod})` : ""}`
            : p.id === "custom" ? p.baseUrl ?? "" : "Key saved on the backend";
          return (
            <div key={p.id} className={`conn-card${isOpen ? " on" : ""}${p.ready ? " ready" : ""}`}>
              <button className="conn-top" aria-expanded={isOpen} onClick={() => start(p)}>
                <span className={`sc-dot ${p.ready ? "ok" : "off"}`} />
                <span className="grow">
                  <b>{p.name}</b>
                  <small>{p.ready ? where : (g?.blurb ?? p.keyHelp)}</small>
                </span>
                <span className={`conn-pill ${p.ready ? "ok" : ""}`}>{p.ready ? "Connected" : "Connect"}</span>
                <Icon.ChevronRight size={15} />
              </button>

              {/* The models this key may be asked for, and the exact string to ask with. */}
              {p.ready && !isOpen && (
                <div className="prov-models">
                  {p.models.slice(0, 6).map((mdl) => <span key={mdl} className="chip"><code>{p.id}:{mdl}</code></span>)}
                  {p.models.length > 6 && <span className="muted small">+{p.models.length - 6} more</span>}
                </div>
              )}

              {isOpen && (
                <div className="conn-body">
                  {g && <p className="muted small">{g.blurb}</p>}
                  {g && (
                    <ol className="conn-steps">
                      {g.steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  )}
                  {g?.link && <p className="small"><a href={g.link.href} target="_blank" rel="noreferrer">{g.link.label} <Icon.External size={12} /></a></p>}

                  {/* Your own machine: the address is the only thing that differs between these, so offer them. */}
                  {p.needsBaseUrl && (
                    <div className="conn-presets">
                      {LOCAL_PRESETS.map((x) => (
                        <button key={x.name} type="button" className="rbtn" title={`${x.baseUrl} · ${x.note}`}
                          onClick={() => setForm({ ...form, baseUrl: x.baseUrl, model: x.model })}>{x.name}</button>
                      ))}
                    </div>
                  )}

                  {p.needsNoKey ? (
                    <div className="dialog-actions left">
                      <button className="btn primary sm" disabled={!!busy} onClick={() => void recheck()}>{busy === "recheck" ? "Checking…" : "Check again"}</button>
                      {p.cli?.bin && <span className="muted small">Found at <code>{p.cli.bin}</code></span>}
                    </div>
                  ) : (
                    <form className="sc-form" onSubmit={(e) => { e.preventDefault(); void save(p); }}>
                      {p.needsBaseUrl && (
                        <label>API address
                          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://localhost:11434/v1" />
                        </label>
                      )}
                      {p.keySource !== "env" && (
                        <label>API key {p.id === "custom" && <small className="muted">(usually none for a local server)</small>}
                          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                            placeholder={p.ready ? "leave empty to keep the current key" : "paste the key"} autoComplete="off" />
                        </label>
                      )}
                      <label>Test with model
                        <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={p.examples[0]} list={`ex-${p.id}`} />
                        <datalist id={`ex-${p.id}`}>{p.examples.map((x) => <option key={x} value={x} />)}</datalist>
                      </label>
                      <p className="muted small">Saving makes one small real request, so a key that cannot answer is never stored as working.</p>
                      <div className="dialog-actions left">
                        <button className="btn primary sm" disabled={!!busy || (!p.ready && !form.apiKey.trim() && p.id !== "custom") || (p.needsBaseUrl && !form.baseUrl.trim())}>
                          {busy === p.id ? "Testing…" : p.ready ? "Save & test" : "Connect"}
                        </button>
                        <button type="button" className="btn sm" onClick={() => setOpen("")}>Cancel</button>
                        {p.ready && p.keySource !== "env" && <button type="button" className="btn ghost danger sm" disabled={!!busy} onClick={() => void remove(p)}>Disconnect</button>}
                      </div>
                    </form>
                  )}

                  {p.ready && (
                    <div className="prov-models">
                      {p.models.map((mdl) => (
                        <span key={mdl} className="chip">
                          <code>{mdl}</code>
                          {!p.examples.includes(mdl) && <button className="chip-x" title="Remove this model" disabled={!!busy} onClick={() => void dropModel(p, mdl)}>×</button>}
                        </span>
                      ))}
                      <form className="chip-add" onSubmit={(e) => { e.preventDefault(); void addModel(p); }}>
                        <input value={newModel[p.id] ?? ""} onChange={(e) => setNewModel({ ...newModel, [p.id]: e.target.value })}
                          placeholder="add a model name…" aria-label={`Add a model for ${p.name}`} />
                        <button className="rbtn" disabled={!!busy || !(newModel[p.id] ?? "").trim()}>{busy === `add:${p.id}` ? "Testing…" : "Add"}</button>
                      </form>
                    </div>
                  )}
                </div>
              )}

              {msg?.id === p.id && <div className={`banner ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
            </div>
          );
        })}
      </div>

      {msg && !msg.id && <div className="banner error">{msg.text}</div>}
    </>
  );
}
