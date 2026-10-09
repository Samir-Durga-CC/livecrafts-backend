import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import type { Site, TemplateRow, TemplatesReport } from "./types";

/**
 * /templates - the template library at a glance: every template, how many times it is used and where.
 * "Used" = the shortcode is in a page or post (live or draft) or theme code rendered it on the front end.
 * Each page links to itself with ?lc_templates=1, which outlines and labels the template sections for editors.
 */
const uses = (t: TemplateRow) => t.usedOn.reduce((n, u) => n + Math.max(1, u.count), 0);
const isUsed = (t: TemplateRow) => t.usedOn.length > 0 || t.renderedAt.length > 0;
const withFlag = (url: string) => url + (url.includes("?") ? "&" : "?") + "lc_templates=1";
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

export default function TemplatesPage() {
  const params = new URLSearchParams(location.search);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(params.get("site") ?? localStorage.getItem("lc_site") ?? "");
  const [report, setReport] = useState<TemplatesReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "used" | "unused">("all");

  useEffect(() => {
    api.sites().then((s) => { setSites(s); if (!siteId && s[0]) setSiteId(s[0].id); }).catch((e) => setError(e instanceof ApiError && e.status === 401 ? "The backend asks for its token: open the main app once and enter it, then reload." : (e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    if (!siteId) return;
    setLoading(true); setError("");
    api.templates(siteId).then(setReport).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [siteId]);
  useEffect(load, [load]);

  const site = sites.find((s) => s.id === siteId);
  const rows = report?.components ?? [];
  const used = rows.filter(isUsed);
  const total = rows.reduce((n, t) => n + uses(t), 0);
  const shown = useMemo(() => rows.filter((t) => filter === "all" || (filter === "used") === isUsed(t)).sort((a, b) => uses(b) - uses(a) || a.id.localeCompare(b.id)), [rows, filter]);

  return (
    <div className="tpl-page">
      <header className="tpl-head">
        <a className="tpl-back" href={`/${siteId ? `?site=${siteId}` : ""}`}>← Livecrafts</a>
        <h1>Templates</h1>
        <span className="grow" />
        {sites.length > 1 && (
          <select value={siteId} onChange={(e) => { setSiteId(e.target.value); localStorage.setItem("lc_site", e.target.value); }} aria-label="Site">
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <button className="tpl-btn" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </header>

      {error && <div className="tpl-note bad">{error}</div>}
      {report && !report.active && <div className="tpl-note warn">{report.note ?? report.error ?? "The template library is not active on this site."}</div>}

      {report?.active && (
        <>
          <p className="tpl-lead">
            The assistant builds sections from these ready templates and only changes their content. A template is <b>used</b> when it is on a page or post (live or draft) or rendered by theme code.
            Open a page with <code>?lc_templates=1</code> as a logged-in editor to see its template sections outlined and labelled.
          </p>
          <div className="tpl-stats">
            <div><b>{used.length}</b><span>of {rows.length} templates used</span></div>
            <div><b>{total}</b><span>sections placed in content</span></div>
            <div><b>{rows.length - used.length}</b><span>not used yet</span></div>
            {report.version && <div><b>{report.version}</b><span>library version</span></div>}
          </div>

          <div className="tpl-filter" role="tablist">
            {(["all", "used", "unused"] as const).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "all" ? `All (${rows.length})` : f === "used" ? `Used (${used.length})` : `Not used (${rows.length - used.length})`}
              </button>
            ))}
          </div>

          <div className="tpl-table-wrap">
            <table className="tpl-table">
              <thead><tr><th>Template</th><th className="num">Count</th><th>Status</th><th>Where it is used</th></tr></thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id} className={isUsed(t) ? "" : "dim"}>
                    <td><b>{t.id}</b><div className="tpl-sub"><code>[{t.shortcode}]</code></div></td>
                    <td className="num"><span className={`tpl-count ${isUsed(t) ? "on" : ""}`}>{uses(t)}</span></td>
                    <td>{isUsed(t) ? <span className="tpl-pill ok">Used</span> : <span className="tpl-pill">Not used</span>}</td>
                    <td>
                      {t.usedOn.map((u) => (
                        <div key={u.post} className="tpl-use">
                          <a href={withFlag(u.url)} target="_blank" rel="noreferrer">{u.title || "(no title)"}</a>
                          <span className="tpl-sub"> · {u.in.join(" + ")}{u.count > 1 ? ` · ×${u.count}` : ""} · {u.status}</span>
                        </div>
                      ))}
                      {t.renderedAt.map((r) => <div key={r.path} className="tpl-use"><code>{r.path}</code><span className="tpl-sub"> · rendered by theme code · {ago(r.last)}</span></div>)}
                      {!isUsed(t) && <span className="tpl-sub">—</span>}
                    </td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={4} className="tpl-sub">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>
          {site && <p className="tpl-sub">Site: {site.name} · {site.url}</p>}
        </>
      )}
    </div>
  );
}
