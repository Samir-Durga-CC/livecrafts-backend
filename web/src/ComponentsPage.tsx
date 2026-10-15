import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import type { Site, TemplatesReport } from "./types";

/**
 * The component gallery: every template, every layout, rendered BY THE SITE ITSELF.
 *
 * Each tile is a frame onto /?lc_tpl_preview=<id>&lc_tpl_variant=<layout> on the connected site, so what you see is
 * the template in that site's real fonts, colours and container width - not a picture taken somewhere else. The
 * preview needs you to be logged into that site as an editor in this browser; nothing is saved by opening it.
 */

const WIDTHS = { desktop: 1280, tablet: 820, mobile: 390 } as const;
type Width = keyof typeof WIDTHS;

/** A tile's own height: a full-width band needs more room than a button. */
const heightOf = (id: string) =>
  /^(hero|footer|header|contact_form|pricing|slider|blog_grid|testimonials|feature_grid|faq|team|steps)/.test(id) ? 760 : 420;

export default function ComponentsPage() {
  const params = new URLSearchParams(location.search);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(params.get("site") ?? localStorage.getItem("lc_site") ?? "");
  const [report, setReport] = useState<TemplatesReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [width, setWidth] = useState<Width>("desktop");
  const [open, setOpen] = useState<string>("");
  const [variant, setVariant] = useState<Record<string, string>>({});

  useEffect(() => {
    api.sites()
      .then((s) => { setSites(s); if (!siteId && s[0]) setSiteId(s[0].id); })
      .catch((e) => setError(e instanceof ApiError && e.status === 401
        ? "The backend asks for its token: open the main app once and enter it, then reload."
        : (e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    if (!siteId) return;
    setLoading(true); setError("");
    api.templates(siteId).then(setReport).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [siteId]);
  useEffect(load, [load]);

  const site = sites.find((s) => s.id === siteId);
  const rows = useMemo(() => (report?.components ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)), [report]);

  const previewUrl = (id: string, v: string) => {
    const base = (report?.components ?? []).find((t) => t.id === id)?.preview
      ?? `${(site?.url ?? "").replace(/\/+$/, "")}/?lc_tpl_preview=${encodeURIComponent(id)}`;
    const u = new URL(base);
    u.searchParams.set("lc_tpl_preview", id);
    if (v) u.searchParams.set("lc_tpl_variant", v);
    return u.href;
  };

  return (
    <div className="tpl-page cmp-page">
      <header className="tpl-head">
        <a className="tpl-back" href={`/${siteId ? `?site=${siteId}` : ""}`}>← Livecrafts</a>
        <h1>Components</h1>
        <span className="grow" />
        {sites.length > 1 && (
          <select value={siteId} onChange={(e) => { setSiteId(e.target.value); localStorage.setItem("lc_site", e.target.value); }} aria-label="Site">
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <div className="cmp-widths" role="tablist" aria-label="Screen size">
          {(Object.keys(WIDTHS) as Width[]).map((w) => (
            <button key={w} role="tab" aria-selected={width === w} className={width === w ? "on" : ""} onClick={() => setWidth(w)}>
              {w === "desktop" ? "Desktop" : w === "tablet" ? "Tablet" : "Phone"}
            </button>
          ))}
        </div>
        <button className="tpl-btn" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </header>

      {error && <div className="tpl-note bad">{error}</div>}
      {report && !report.active && <div className="tpl-note warn">{report.note ?? "The template library is not active on this site."}</div>}

      {report?.active && (
        <>
          <p className="tpl-lead">
            Every section the assistant can build, rendered by <b>{site?.name ?? "this site"}</b> itself — so these are
            your fonts, your colours and your container width. Open one in a new tab to see it full size.
            {" "}If a tile is empty, log in to the site in this browser first: previews are for editors only.
          </p>

          <div className="cmp-grid">
            {rows.map((t) => {
              const variants = t.variants ?? [];
              const current = variant[t.id] ?? variants[0] ?? "";
              const url = previewUrl(t.id, current);
              return (
                <section key={t.id} className="cmp-card">
                  <header className="cmp-card-head">
                    <div>
                      <h2>{t.title || t.id}</h2>
                      <code>[{t.shortcode}]</code>
                    </div>
                    <span className="grow" />
                    {variants.length > 1 && (
                      <div className="cmp-variants" role="tablist" aria-label={`${t.id} layouts`}>
                        {variants.map((v) => (
                          <button key={v} role="tab" aria-selected={current === v} className={current === v ? "on" : ""}
                            onClick={() => setVariant((m) => ({ ...m, [t.id]: v }))}>{v}</button>
                        ))}
                      </div>
                    )}
                    <a className="tpl-btn" href={url} target="_blank" rel="noreferrer">Open ↗</a>
                  </header>

                  <div className="cmp-frame-wrap" style={{ height: heightOf(t.id) }}>
                    <iframe
                      key={url}
                      title={`${t.id} ${current}`}
                      src={url}
                      loading="lazy"
                      className="cmp-frame"
                      style={{ width: WIDTHS[width], height: heightOf(t.id) / (width === "desktop" ? 1 : 1) }}
                    />
                  </div>

                  <footer className="cmp-card-foot">
                    <button className="tpl-btn" onClick={() => setOpen(open === t.id ? "" : t.id)}>
                      {open === t.id ? "Hide how to use it" : "How to use it"}
                    </button>
                    {open === t.id && (
                      <div className="cmp-how">
                        <p className="cmp-params"><b>Content it takes:</b> {t.params || "—"}</p>
                        <p className="cmp-say">Ask Livecrafts: <i>“add a {(t.title || t.id).toLowerCase()} section{current ? `, ${current} layout` : ""}”</i></p>
                      </div>
                    )}
                  </footer>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
