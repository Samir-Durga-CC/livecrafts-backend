import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type SectionUsage } from "./api";
import type { Site } from "./types";

/**
 * /section-usage - the Section Gallery's counter: how many times each ready-made section was added, on how many
 * websites, and when last - for all websites or one. Each row shows a small picture of the section (the real section,
 * in the chosen website's brand) so it is easy to tell which is which. Counts adds: a section later removed or undone
 * still counts as one use.
 */
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const host = (url: string) => url.replace(/^https?:\/\//, "");

/** One picture per section and brand, shared by every row that shows it. */
const thumbCache = new Map<string, Promise<string>>();
function Thumb({ siteId, id, brand }: { siteId: string; id: string; brand: SectionUsage["brand"] }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!siteId) return;
    let alive = true;
    const key = `${siteId}|${id}|${brand?.color ?? ""}`;
    if (!thumbCache.has(key)) thumbCache.set(key, api.sectionPreview(siteId, id, brand).then((r) => r.html));
    thumbCache.get(key)!.then((h) => alive && setHtml(h)).catch(() => { thumbCache.delete(key); if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [siteId, id, brand]);
  return (
    <span className="su-thumb" aria-hidden="true">
      {html ? <iframe ref={frame} title="" srcDoc={html} tabIndex={-1} sandbox="allow-same-origin" /> : <span className="su-thumb-ph">{failed ? "No preview" : ""}</span>}
    </span>
  );
}

export default function SectionUsagePage() {
  const params = new URLSearchParams(location.search);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(params.get("site") ?? localStorage.getItem("lc_usage_site") ?? "");
  const [data, setData] = useState<SectionUsage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "used" | "unused">("all");
  const tokenHelp = "The backend asks for its token: open the main app once and enter it, then reload.";

  useEffect(() => {
    api.sites().then(setSites).catch((e) => setError(e instanceof ApiError && e.status === 401 ? tokenHelp : (e as Error).message));
  }, []);

  const load = useCallback(() => {
    setLoading(true); setError("");
    api.sectionUsage(siteId || undefined).then(setData)
      .catch((e) => setError(e instanceof ApiError && e.status === 401 ? tokenHelp : (e as Error).message))
      .finally(() => setLoading(false));
  }, [siteId]);
  useEffect(load, [load]);

  const pick = (id: string) => { setSiteId(id); setOpen(null); try { localStorage.setItem("lc_usage_site", id); } catch { /* private window */ } };
  const site = sites.find((s) => s.id === siteId);
  const thumbSite = siteId || sites[0]?.id || ""; // pictures need a site's look: the chosen one, else the first
  const rows = (data?.sections ?? []).filter((r) => filter === "all" || (filter === "used") === r.count > 0);
  const max = Math.max(1, ...(data?.sections ?? []).map((r) => r.count));

  return (
    <div className="tpl-page su-page">
      <header className="tpl-head">
        <a className="tpl-back" href={`/${siteId ? `?site=${siteId}` : ""}`}>← Livecrafts</a>
        <h1>Section usage</h1>
        <span className="grow" />
        <select value={siteId} onChange={(e) => pick(e.target.value)} aria-label="Website">
          <option value="">All websites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{host(s.url) || s.name}</option>)}
        </select>
        <button className="tpl-btn" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </header>
      {error && <div className="tpl-note bad">{error}</div>}
      {data && (
        <>
          <p className="tpl-lead">
            Every time someone clicks <b>Add to this page</b> in the Section Gallery, it is counted here{site ? <> for <b>{host(site.url)}</b></> : " for all websites"}.
            A section that was added and later removed or undone still counts as one use.
          </p>
          <div className="tpl-stats">
            <div><b>{data.totals.adds}</b><span>sections added</span></div>
            {site ? <div><b>{data.websites[0]?.sections ?? 0}</b><span>different sections used</span></div> : <div><b>{data.totals.websites}</b><span>websites using sections</span></div>}
            <div><b>{data.totals.sectionsUsed}</b><span>of {data.totals.sections} sections used</span></div>
            <div><b>{data.totals.since ? new Date(data.totals.since).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—"}</b><span>{site ? "first added" : "counting since"}</span></div>
          </div>

          <div className="tpl-filter" role="tablist">
            {(["all", "used", "unused"] as const).map((f) => {
              const n = f === "all" ? data.sections.length : data.sections.filter((r) => (f === "used") === r.count > 0).length;
              return <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "used" ? "Used" : "Not used yet"} ({n})</button>;
            })}
          </div>
          <div className="tpl-table-wrap">
            <table className="tpl-table su-table">
              <thead><tr><th>Section</th><th className="num">Times used</th>{!site && <th className="num">Websites</th>}<th>Last used</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className={r.count ? "su-row" : "dim"} onClick={() => !site && r.count && setOpen(open === r.id ? null : r.id)} style={{ cursor: !site && r.count ? "pointer" : "default" }}>
                      <td>
                        <div className="su-sec">
                          <Thumb siteId={thumbSite} id={r.id} brand={data.brand} />
                          <div><b>{r.name}</b><div className="tpl-sub">{r.category} · <code>{r.id}</code></div></div>
                        </div>
                      </td>
                      <td className="num"><span className="su-used"><span className="su-bar"><i style={{ width: `${(r.count / max) * 100}%` }} /></span><span className={`tpl-count ${r.count ? "on" : ""}`}>{r.count}</span></span></td>
                      {!site && <td className="num">{r.siteCount}</td>}
                      <td className="tpl-sub">{when(r.last)}{!site && r.count > 0 && <span className="su-more"> · {open === r.id ? "hide" : "which websites"}</span>}</td>
                    </tr>
                    {open === r.id && (
                      <tr className="su-sites"><td colSpan={4}>
                        {r.sites.map((s) => <div key={s.id} className="tpl-use"><b>{host(s.url) || s.name}</b><span className="tpl-sub"> · used {s.count}× · last {when(s.last)}</span></div>)}
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {!rows.length && <tr><td colSpan={4} className="tpl-sub">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>

          {!site && (
            <>
              <h2 className="su-h2">Websites</h2>
              <div className="tpl-table-wrap">
                <table className="tpl-table">
                  <thead><tr><th>Website</th><th className="num">Sections added</th><th className="num">Different sections</th><th>Last added</th></tr></thead>
                  <tbody>
                    {data.websites.map((w) => (
                      <tr key={w.id} className="su-row" style={{ cursor: "pointer" }} onClick={() => pick(w.id)}>
                        <td><b>{host(w.url) || w.name}</b><div className="tpl-sub">{w.name}</div></td><td className="num">{w.count}</td><td className="num">{w.sections}</td><td className="tpl-sub">{when(w.last)}</td>
                      </tr>
                    ))}
                    {!data.websites.length && <tr><td colSpan={4} className="tpl-sub">No sections added yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
