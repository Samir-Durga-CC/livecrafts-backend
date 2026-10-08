import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { api } from "../api";

const DEVICES = { desktop: { w: 1366, label: "Desktop", icon: Icon.Monitor }, tablet: { w: 820, label: "Tablet", icon: Icon.Tablet }, mobile: { w: 390, label: "Mobile", icon: Icon.Phone } } as const;
type Device = keyof typeof DEVICES;

const withBust = (url: string, n: number) => { try { const u = new URL(url); u.searchParams.set("lcv", String(n)); return u.href; } catch { return url; } };

/**
 * The sandbox: the real live page, framed at a real device width and scaled down to fit the panel.
 * It reloads by itself every time an approved change finishes (reloadKey), so the person sees the result right away.
 */
export function Preview({ siteUrl, siteId, pageUrl, reloadKey, navigate }: { siteUrl?: string; siteId?: string; pageUrl?: string; reloadKey: number; navigate?: { url: string; n: number } }) {
  const [device, setDevice] = useState<Device>(() => (localStorage.getItem("lc_device") as Device) || "desktop");
  const [path, setPath] = useState("");
  const [stamp, setStamp] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState(false);
  // Every change is a DRAFT: only the draft view (a short-lived view-only preview token) shows it. "Live" = what visitors see.
  const [view, setView] = useState<"draft" | "live">(() => (localStorage.getItem("lc_view") as "draft" | "live") || "draft");
  const [token, setToken] = useState<{ value: string; param: string; at: number } | null>(null);
  const [tokenErr, setTokenErr] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(400);
  const [boxH, setBoxH] = useState(600);

  const origin = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
  // Start on the page the person came from (plugin context), otherwise the home page.
  useEffect(() => { setPath(pageUrl && origin && pageUrl.startsWith(origin) ? pageUrl.slice(origin.length) || "/" : "/"); }, [pageUrl, origin]);
  useEffect(() => { try { localStorage.setItem("lc_device", device); } catch { /* ignore */ } }, [device]);
  // Jump to a page on request (e.g. a page that was just created, or "View" on a change).
  useEffect(() => {
    if (!navigate || !origin || !navigate.url.startsWith(origin)) return;
    setPath(navigate.url.slice(origin.length) || "/"); setStamp(Date.now());
  }, [navigate, origin]);

  useEffect(() => { try { localStorage.setItem("lc_view", view); } catch { /* ignore */ } }, [view]);
  // A fresh token for the draft view (they last 10 minutes: renew after 7, and after every change / reload).
  useEffect(() => {
    if (view !== "draft" || !siteId) return;
    if (token && Date.now() - token.at < 7 * 60_000) return;
    let off = false;
    api.previewToken(siteId).then((t) => { if (!off) { setToken({ value: t.token, param: t.param || "lc_preview", at: Date.now() }); setTokenErr(""); } })
      .catch((e) => { if (!off) { setTokenErr(String(e.message)); setToken(null); } });
    return () => { off = true; };
  }, [view, siteId, stamp, token]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setStamp(Date.now()); setFlash(true);
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [reloadKey]);

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => { setBoxW(el.clientWidth); setBoxH(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [origin]);

  const full = origin + (path.startsWith("/") ? path : "/" + path);
  const draftReady = view === "live" || !siteId || !!token || !!tokenErr; // without a token (old plugin / error) the live page is shown
  const withToken = (u: string) => { if (view !== "draft" || !token) return u; try { const x = new URL(u); x.searchParams.set(token.param, token.value); return x.href; } catch { return u; } };
  const src = draftReady ? withToken(withBust(full, stamp)) : "about:blank";
  useEffect(() => { setLoading(true); }, [stamp, device]);

  if (!origin) return <div className="rempty"><div className="r-big"><Icon.Eye size={22} /></div><strong>No site yet</strong><p>Connect a site to see its live preview here.</p></div>;

  const w = DEVICES[device].w;
  const scale = Math.min(1, boxW / w);

  return (
    <div className="preview">
      <div className="pv-bar">
        <div className="pv-devices" role="tablist">
          {(Object.keys(DEVICES) as Device[]).map((d) => {
            const I = DEVICES[d].icon;
            return <button key={d} className={d === device ? "on" : ""} title={DEVICES[d].label} onClick={() => setDevice(d)}><I size={15} /></button>;
          })}
        </div>
        <form className="pv-url" onSubmit={(e) => { e.preventDefault(); setStamp(Date.now()); }}>
          <span className="pv-host">{origin.replace(/^https?:\/\//, "")}</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} aria-label="Page path" />
        </form>
        <div className="pv-devices" role="tablist" title="Draft = with the changes not deployed yet (what editors see). Live = what visitors see.">
          <button className={view === "draft" ? "on" : ""} onClick={() => setView("draft")} style={{ width: "auto", padding: "0 9px", fontSize: 12 }}>Draft</button>
          <button className={view === "live" ? "on" : ""} onClick={() => setView("live")} style={{ width: "auto", padding: "0 9px", fontSize: 12 }}>Live</button>
        </div>
        <button className="ghost-icon" title="Reload" onClick={() => setStamp(Date.now())}><Icon.Retry size={15} /></button>
        <button className="ghost-icon" title="Open in a new tab" onClick={() => window.open(src === "about:blank" ? full : src, "_blank")}><Icon.External size={15} /></button>
      </div>
      {flash && <div className="pv-flash"><Icon.Check size={13} /> Change applied, preview reloaded</div>}
      <div className="pv-stage" ref={box}>
        <div className="pv-frame" style={{ width: w, height: boxH / scale, transform: `scale(${scale})` }}>
          <iframe key={src} src={src} title="Live preview" onLoad={() => setLoading(false)} />
        </div>
        {loading && <div className="pv-loading"><span className="spin" /> Loading the live page…</div>}
      </div>
      <p className="pv-note">{view === "draft" ? (tokenErr ? `The draft view is not available (${tokenErr}) - showing the live page. ` : "Draft view: with the changes not deployed yet. ") : "Live view: what visitors see. "}Real site at {DEVICES[device].label.toLowerCase()} width ({w}px). It reloads after every approved change. Blank? The site may block being shown inside other pages — use <Icon.External size={11} /> to open it.</p>
    </div>
  );
}
