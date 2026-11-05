import { useEffect, useState } from "react";
import { api, setToken } from "../api";
import { Icon } from "../icons";

/**
 * The first screen of a backend that has accounts: sign in - or, on a fresh backend, create the owner account.
 *
 * On a public backend the first owner also has to give the root key (LC_API_TOKEN), so whoever finds a fresh server
 * first cannot take it. "Use the root key" stays available for scripts and for getting back in.
 */
export function SignIn({ reason }: { reason?: string }) {
  const [status, setStatus] = useState<{ setupNeeded: boolean; rootTokenRequired: boolean } | null>(null);
  const [mode, setMode] = useState<"in" | "setup" | "root">("in");
  const [f, setF] = useState({ email: "", name: "", password: "", password2: "", rootToken: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(reason ?? "");

  useEffect(() => {
    api.authStatus().then((s) => { setStatus(s); if (s.setupNeeded) setMode("setup"); }).catch((e) => setErr((e as Error).message));
  }, []);

  const done = (token: string) => { setToken(token); location.reload(); };
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    if (mode === "root") return done(f.rootToken.trim());
    if (mode === "setup" && f.password !== f.password2) return setErr("The two passwords are not the same.");
    setBusy(true);
    try {
      const r = mode === "setup"
        ? await api.setup({ email: f.email, name: f.name, password: f.password, rootToken: f.rootToken.trim() || undefined })
        : await api.login(f.email, f.password);
      done(r.token);
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="signin-brand"><span className="logo"><Icon.Sparkle size={16} /></span> Livecrafts</div>
        {mode === "setup" ? (
          <>
            <h1>Create the owner account</h1>
            <p className="muted small">This backend has no accounts yet. The first one is the owner: it creates the others, gives clients their sites and sets their limits.</p>
            <label>Your name <input value={f.name} onChange={set("name")} autoComplete="name" /></label>
            <label>Email <input type="email" required value={f.email} onChange={set("email")} autoComplete="username" /></label>
            <label>Password <small className="muted">(10 characters or more)</small><input type="password" required minLength={10} value={f.password} onChange={set("password")} autoComplete="new-password" /></label>
            <label>Password again <input type="password" required value={f.password2} onChange={set("password2")} autoComplete="new-password" /></label>
            {status?.rootTokenRequired && (
              <label>Root key <small className="muted">(LC_API_TOKEN of this backend - proves the server is yours)</small>
                <input type="password" required value={f.rootToken} onChange={set("rootToken")} autoComplete="off" />
              </label>
            )}
          </>
        ) : mode === "root" ? (
          <>
            <h1>Use the root key</h1>
            <p className="muted small">The backend's own key (LC_API_TOKEN). It opens everything and is not tied to a person, so use an account for daily work.</p>
            <label>Root key <input type="password" required value={f.rootToken} onChange={set("rootToken")} autoComplete="off" /></label>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <label>Email <input type="email" required value={f.email} onChange={set("email")} autoComplete="username" autoFocus /></label>
            <label>Password <input type="password" required value={f.password} onChange={set("password")} autoComplete="current-password" /></label>
          </>
        )}
        {err && <div className="banner error">{err}</div>}
        <button className="btn primary" disabled={busy || !status}>{busy ? "One moment…" : mode === "setup" ? "Create the owner account" : mode === "root" ? "Open with the root key" : "Sign in"}</button>
        {!status?.setupNeeded && (
          <button type="button" className="btn ghost sm" onClick={() => { setErr(""); setMode(mode === "root" ? "in" : "root"); }}>
            {mode === "root" ? "Sign in with an account instead" : "Use the root key instead"}
          </button>
        )}
        {mode === "in" && <p className="muted small">No account yet? Ask the owner of this Livecrafts to create one for you.</p>}
      </form>
    </div>
  );
}
