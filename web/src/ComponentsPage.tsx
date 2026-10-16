import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { Site, TemplateRow, TemplatesReport } from "./types";

/**
 * The component gallery: every section the assistant can build, each one ISOLATED in its own frame with the code
 * beside it - the way a component library documents itself.
 *
 * The site renders the component with sample content and hands back the markup and the stylesheets (the library's and
 * the theme's). The frame holds only that, so a tile shows the COMPONENT - never the site's header, menu or home
 * page - while still carrying the site's fonts and colours. It is fetched server-to-server, so nobody has to be
 * logged into WordPress in this browser.
 */

const WIDTHS = { desktop: 1280, tablet: 820, mobile: 390 } as const;
type Width = keyof typeof WIDTHS;

const BIG = /^(hero|footer|header|contact_form|pricing|slider|blog_grid|testimonials|feature_grid|faq|team|steps|cta|stats|newsletter)/;

interface Rendered { html: string; css: string[]; custom?: string; error?: string }

/** A whole little document for the frame: the stylesheets, then the component, and nothing else. */
const docFor = (r: Rendered, width: number) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1">
${r.css.map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`).join("")}
<style>${r.custom ?? ""}
html,body{margin:0;padding:0;background:#fff;}
/* the component decides its own spacing; the frame adds none */
body>*{max-width:100%}</style>
</head><body>${r.html}</body></html>`;

export default function ComponentsPage() {
  const params = new URLSearchParams(location.search);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(params.get("site") ?? localStorage.getItem("lc_site") ?? "");
  const [report, setReport] = useState<TemplatesReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [width, setWidth] = useState<Width>("desktop");
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, Rendered>>({});
  const [code, setCode] = useState<string>("");
  const asked = useRef<Set<string>>(new Set());

  useEffect(() => {
    api.sites()
      .then((s) => { setSites(s); if (!siteId && s[0]) setSiteId(s[0].id); })
      .catch((e) => setError(e instanceof ApiError && e.status === 401
        ? "The backend asks for its token: open the main app once and enter it, then reload."
        : (e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    if (!siteId) return;
    setLoading(true); setError(""); setShown({}); asked.current = new Set();
    api.templates(siteId).then(setReport).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [siteId]);
  useEffect(load, [load]);

  const rows = useMemo(() => (report?.components ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)), [report]);

  /** Render one template (once per template + layout) and keep the markup. */
  const render = useCallback((id: string, v: string) => {
    const key = `${id}:${v}`;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    api.renderTemplate(siteId, id, v)
      .then((r: any) => setShown((m) => ({ ...m, [key]: { html: r.html, css: r.css ?? [], custom: r.custom } })))
      .catch((e) => setShown((m) => ({ ...m, [key]: { html: "", css: [], error: (e as Error).message } })));
  }, [siteId]);

  useEffect(() => {
    if (!report?.active) return;
    for (const t of rows) render(t.id, variant[t.id] ?? (t.variants ?? [])[0] ?? "");
  }, [rows, variant, report, render]);

  const site = sites.find((s) => s.id === siteId);
  const snippet = (t: TemplateRow, v: string) => {
    const attrs = v ? ` variant="${v}"` : "";
    return t.list ? `[${t.shortcode}${attrs} heading="…"]\n  [ai_item …]\n[/${t.shortcode}]` : `[${t.shortcode}${attrs} heading="…"]`;
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
            Every section the assistant can build, each one on its own with sample content — rendered by{" "}
            <b>{site?.name ?? "this site"}</b>, so these are your fonts and colours.
            {rows.some((t) => (t.variants ?? []).length > 0) ? "" : " (Update the Livecrafts plugin to see each template's layouts.)"}
          </p>

          <div className="cmp-grid">
            {rows.map((t) => {
              const variants = t.variants ?? [];
              const current = variant[t.id] ?? variants[0] ?? "";
              const key = `${t.id}:${current}`;
              const r = shown[key];
              const tall = BIG.test(t.id);
              return (
                <section key={t.id} className="cmp-card">
                  <header className="cmp-card-head">
                    <div>
                      <h2>{(t.title || t.id).replace(/\s*\(.*\)$/, "")}</h2>
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
                    <button className="tpl-btn" onClick={() => setCode(code === key ? "" : key)}>{code === key ? "Preview" : "Code"}</button>
                  </header>

                  {code === key ? (
                    <div className="cmp-code">
                      <pre>{snippet(t, current)}</pre>
                      <p className="cmp-params"><b>Content it takes:</b> {t.params || "—"}</p>
                      <p className="cmp-say">Or just ask: <i>“add a {(t.title || t.id).replace(/\s*\(.*\)$/, "").toLowerCase()} section{current ? `, ${current} layout` : ""}”</i></p>
                    </div>
                  ) : (
                    <div className="cmp-frame-wrap" style={{ height: tall ? 620 : 300 }}>
                      {!r && <p className="cmp-wait">Rendering…</p>}
                      {r?.error && <p className="cmp-wait bad">{r.error}</p>}
                      {r && !r.error && (
                        <iframe
                          key={key + width}
                          title={`${t.id} ${current}`}
                          className="cmp-frame"
                          sandbox="allow-same-origin"
                          srcDoc={docFor(r, WIDTHS[width])}
                          style={{ width: WIDTHS[width], height: (tall ? 620 : 300) / scaleFor(width), transform: `scale(${scaleFor(width)})` }}
                        />
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** A 1280px desktop page has to be shrunk to sit in a card; a phone frame is shown at its real size. */
function scaleFor(width: Width): number {
  if (width === "mobile") return 1;
  const room = Math.min(window.innerWidth - 120, 1340);
  return Math.min(1, room / WIDTHS[width]);
}
