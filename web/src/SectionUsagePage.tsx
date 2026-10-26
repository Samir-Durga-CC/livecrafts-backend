import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, api, type SectionUsage } from "./api";

/**
 * /section-usage - the Section Gallery's counter: how many times each ready-made section was added, on how many
 * websites, and when last. Counts adds: a section later removed or undone still counts as one use.
 */
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export default function SectionUsagePage() {
  const [data, setData] = useState<SectionUsage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "used" | "unused">("all");

  const load = useCallback(() => {
    setLoading(true); setError("");
    api.sectionUsage().then(setData)
      .catch((e) => setError(e instanceof ApiError && e.status === 401 ? "The backend asks for its token: open the main app once and enter it, then reload." : (e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const rows = (data?.sections ?? []).filter((r) => filter === "all" || (filter === "used") === r.count > 0);
  const max = Math.max(1, ...(data?.sections ?? []).map((r) => r.count));

  return (
    <div className="tpl-page">
      <header className="tpl-head">
        <a className="tpl-back" href="/">← Livecrafts</a>
        <h1>Section usage</h1>
        <span className="grow" />
        <button className="tpl-btn" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </header>
      {error && <div className="tpl-note bad">{error}</div>}
      {data && (
        <>
          <p className="tpl-lead">Every time someone clicks <b>Add to this page</b> in the Section Gallery, it is counted here. A section that was added and later removed or undone still counts as one use.</p>
          <div className="tpl-stats">
            <div><b>{data.totals.adds}</b><span>sections added</span></div>
            <div><b>{data.totals.websites}</b><span>websites using sections</span></div>
            <div><b>{data.totals.sectionsUsed}</b><span>of {data.totals.sections} sections used</span></div>
            <div><b>{data.totals.since ? new Date(data.totals.since).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—"}</b><span>counting since</span></div>
          </div>

          <div className="tpl-filter" role="tablist">
            {(["all", "used", "unused"] as const).map((f) => {
              const n = f === "all" ? data.sections.length : data.sections.filter((r) => (f === "used") === r.count > 0).length;
              return <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "used" ? "Used" : "Not used yet"} ({n})</button>;
            })}
          </div>
          <div className="tpl-table-wrap">
            <table className="tpl-table">
              <thead><tr><th>Section</th><th className="num">Times used</th><th className="num">Websites</th><th>Last used</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className={r.count ? "su-row" : "dim"} onClick={() => r.count && setOpen(open === r.id ? null : r.id)} style={{ cursor: r.count ? "pointer" : "default" }}>
                      <td><b>{r.name}</b><div className="tpl-sub">{r.category} · <code>{r.id}</code></div></td>
                      <td className="num"><span className="su-bar"><i style={{ width: `${(r.count / max) * 100}%` }} /></span><span className={`tpl-count ${r.count ? "on" : ""}`}>{r.count}</span></td>
                      <td className="num">{r.siteCount}</td>
                      <td className="tpl-sub">{when(r.last)}{r.count > 0 && <span className="su-more"> · {open === r.id ? "hide" : "which websites"}</span>}</td>
                    </tr>
                    {open === r.id && (
                      <tr className="su-sites"><td colSpan={4}>
                        {r.sites.map((s) => <div key={s.id} className="tpl-use"><b>{s.name}</b><span className="tpl-sub"> · {s.url || s.id} · used {s.count}× · last {when(s.last)}</span></div>)}
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {!rows.length && <tr><td colSpan={4} className="tpl-sub">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>

          <h2 className="su-h2">Websites</h2>
          <div className="tpl-table-wrap">
            <table className="tpl-table">
              <thead><tr><th>Website</th><th className="num">Sections added</th><th className="num">Different sections</th><th>Last added</th></tr></thead>
              <tbody>
                {data.websites.map((w) => (
                  <tr key={w.id}><td><b>{w.name}</b><div className="tpl-sub">{w.url || w.id}</div></td><td className="num">{w.count}</td><td className="num">{w.sections}</td><td className="tpl-sub">{when(w.last)}</td></tr>
                ))}
                {!data.websites.length && <tr><td colSpan={4} className="tpl-sub">No sections added yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
