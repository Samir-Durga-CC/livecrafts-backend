import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { TemplateRow } from "../types";

/**
 * "Which of these should it look like?" - the assistant's offer_layouts tool, as pictures.
 *
 * Every other design decision the assistant takes from the site itself. The layout of a section is the exception:
 * it changes what the page says about the person, and they can judge that from a picture in a second. So each
 * layout is rendered BY THEIR OWN SITE (the same route the component gallery uses), which means the tiles carry
 * their brand colour, their fonts and their spacing - not a stock screenshot of someone else's website.
 *
 * Picking one sends an ordinary message back, so the assistant continues exactly as if they had typed it.
 *
 * Three things the first version got wrong, and what this does instead:
 *  - A tile was a fixed 132px window onto a 1280x880 frame, so every tall layout was CUT OFF: you chose between
 *    pictures of the top third of each one. Each tile is now as tall as its own layout really is (measured in the
 *    frame), so a tile shows the whole section.
 *  - There was no way to look closer before committing. Clicking a tile now opens it FULL SIZE - desktop, tablet or
 *    phone, arrow keys between layouts - and sends the choice only from the button in there.
 *  - It offered one section's layouts and then vanished for good as soon as anything else was said. It now stays in
 *    the conversation (folded up, with the chosen layout named) and can be reopened, and it carries a section
 *    switcher, so every section of the library can be looked through from the same card.
 */

/** A readable name per layout, so the tile is not labelled with a bare id. */
const NICE: Record<string, string> = {
  split: "Message and picture, side by side",
  spotlight: "Centred, with the figures underneath",
  showcase: "A tall picture beside a centred message",
  panel: "Message and picture in one card",
  proof: "Centred, with the reasons to trust it",
  signup: "Picture, message and one email field",
  reveal: "Centred, with a picture overlapping below",
  band: "A deep brand band",
  plain: "Quiet, on the page's own background",
  cards: "Cards",
  list: "A list",
  grid: "A grid",
  columns: "Columns",
  icons: "With icons",
};
const label = (v: string) => NICE[v] ?? v.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
/** "hero_centered" -> "hero centered", for both the heading and the message that is sent. */
const niceId = (v: string) => v.replace(/[-_]/g, " ");

/** The width each frame renders at before it is scaled down to the tile. */
const FRAME_W = 1280;
/**
 * The frame's own viewport height, before the section has been measured: a real laptop's, because a section that
 * asks for "100vh" is exactly as tall as the window it is in - give the frame 1800px and a hero becomes 1800px tall.
 * Once the section turns out to be TALLER than the viewport (a long FAQ), the frame grows to it.
 */
const FRAME_H = 820;
const MAX_H = 2200;

const DEVICE = { desktop: 1280, tablet: 820, phone: 390 } as const;
type Device = keyof typeof DEVICE;

interface Shot { html: string; css: string[]; custom?: string; error?: string }

/** A whole little document for the frame: the site's stylesheets, then the section, and nothing else. */
const docFor = (r: Shot, width = FRAME_W) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1">
${r.css.map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`).join("")}
<style>${r.custom ?? ""}
html,body{margin:0;padding:0;background:#fff;}
body>*{max-width:100%}</style>
</head><body>${r.html}</body></html>`;

/** How tall the section actually is inside the frame, so a tile can show all of it and no more. */
function measure(frame: HTMLIFrameElement): number | null {
  try {
    const d = frame.contentDocument;
    const h = Math.max(d?.body?.scrollHeight ?? 0, d?.documentElement?.scrollHeight ?? 0);
    return h > 20 ? Math.max(120, Math.min(h, MAX_H)) : null;
  } catch {
    return null; // cross-origin stylesheet quirks: fall back to the assumed height
  }
}

export function LayoutPicker({ siteId, template, intro, only, busy, answered, chosen, onSend, onDismiss, onNeverAsk }: {
  siteId: string;
  template: string;
  intro?: string;
  /** Only these layouts, when the assistant narrowed the choice. */
  only?: string[] | null;
  busy: boolean;
  /** They already picked (or said "you choose"): the card stays, folded up, instead of disappearing. */
  answered?: boolean;
  /** The layout their answer named, so the card can say which one it was. */
  chosen?: string | null;
  onSend: (text: string) => void;
  /** "You choose" - the assistant decides this once. */
  onDismiss: () => void;
  /** Turn the picker off for good. */
  onNeverAsk: () => void;
}) {
  /** The id the SITE knows this template by ("hero_centered"), which is not always what the model called it. */
  const [id, setId] = useState(template);
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [shots, setShots] = useState<Record<string, Shot>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  /** Folded up once answered; "Change the layout" opens it again. */
  const [open, setOpen] = useState(!answered);
  /** Which layout is being looked at full size, if any. */
  const [zoom, setZoom] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [browsing, setBrowsing] = useState(false);
  const asked = useRef<Set<string>>(new Set());

  // An answer arriving while it is open folds it up; reopening is the person's call, not the stream's.
  useEffect(() => { if (answered) { setOpen(false); setZoom(null); } }, [answered]);

  // Which layouts each template has: the site reports them, so the list can never drift from what it can render.
  useEffect(() => {
    let alive = true;
    api.templates(siteId)
      .then((r) => {
        if (!alive) return;
        const list = (r.components ?? []).filter((t) => (t.variants ?? []).length > 0);
        setRows(list);
        const norm = (x: string) => x.replace(/-/g, "_");
        const row = (r.components ?? []).find((t) => norm(t.id) === norm(template));
        if (row) setId(row.id);
        if (!(row?.variants ?? []).length) setError("This site's template library does not report any layouts for this section. Update the Livecrafts plugin to see them.");
      })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [siteId, template]);

  const row = useMemo(() => rows?.find((t) => t.id === id) ?? null, [rows, id]);
  /** The narrowed list applies to the section the assistant asked about, not to one they went looking at. */
  const variants = useMemo(() => {
    const all = row?.variants ?? [];
    if (id !== template || !only?.length) return all;
    const kept = all.filter((v) => only.includes(v));
    return kept.length ? kept : all;
  }, [row, id, template, only]);

  // Render each one once, per section AND layout, so switching back shows what was already drawn.
  useEffect(() => {
    if (!open) return;
    for (const v of variants) {
      const key = `${id}:${v}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      api.renderTemplate(siteId, id, v)
        .then((r: any) => setShots((m) => ({ ...m, [key]: { html: r.html, css: r.css ?? [], custom: r.custom } })))
        .catch((e) => setShots((m) => ({ ...m, [key]: { html: "", css: [], error: (e as Error).message } })));
    }
  }, [variants, siteId, id, open]);

  const send = useCallback((v: string) => onSend(`Use the "${v}" layout for the ${niceId(id)}.`), [onSend, id]);

  /**
   * The frames render at desktop width and are scaled down. The factor has to follow the tile, or the preview is
   * cropped in the narrow on-site widget and leaves a gap in the wide app - so it is measured, not guessed.
   */
  const grid = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.167);
  const fit = useCallback(() => {
    const shot = grid.current?.querySelector<HTMLElement>(".lay-shot");
    if (shot?.clientWidth) setScale(shot.clientWidth / FRAME_W);
  }, []);
  useEffect(() => {
    fit();
    const el = grid.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, open, variants, shots]);

  // Full size: the frame is as wide as the device and scaled to whatever room the overlay has.
  const stage = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(0);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const read = () => setStageW(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoom, device]);

  // Arrow keys walk the layouts while one is open; Escape closes it without choosing anything.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setZoom(null); return; }
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = variants.indexOf(zoom);
      if (i >= 0 && variants.length > 1) setZoom(variants[(i + step + variants.length) % variants.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, variants]);

  const nice = niceId(template);
  const zoomShot = zoom ? shots[`${id}:${zoom}`] : null;
  const zoomScale = stageW ? Math.min(1, stageW / DEVICE[device]) : 1;
  const zoomKey = zoom ? `${id}:${zoom}:${device}` : "";
  const zoomH = (zoom ? heights[zoomKey] : 0) || FRAME_H;

  return (
    <div className={`lay-card${answered ? " done" : ""}`}>
      <div className="lay-head">
        <Icon.Sparkle size={14} />
        {answered ? (
          <>
            <b>Layout for the {nice}{chosen ? <>: {label(chosen)}</> : null}</b>
            <span className="grow" />
            <button type="button" className="lay-link" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide layouts" : chosen ? "Change the layout" : "Show the layouts"}
            </button>
          </>
        ) : (
          <b>Which layout for the {nice}?</b>
        )}
      </div>
      {intro && !answered && <p className="lay-intro">{intro}</p>}
      {error && open && <div className="lay-error">{error}</div>}

      {open && (
        <>
          {/* Every other section of the library, for when this is not the one they want to look at. */}
          {(rows?.length ?? 0) > 1 && (
            <div className="lay-sections">
              <button type="button" className="lay-link" onClick={() => setBrowsing((b) => !b)}>
                {browsing ? "Hide other sections" : `Another section (${(rows?.length ?? 1) - 1} more)`}
              </button>
              {browsing && (
                <div className="lay-chips" role="tablist" aria-label="Section">
                  {(rows ?? []).map((t) => (
                    <button key={t.id} type="button" role="tab" aria-selected={t.id === id}
                      className={t.id === id ? "on" : ""} onClick={() => { setId(t.id); setZoom(null); }}>
                      {(t.title || t.id).replace(/\s*\(.*\)$/, "")}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {id !== template && (
            <p className="lay-intro">Layouts of the <b>{niceId(id)}</b> section. Picking one asks for that section instead.</p>
          )}

          <div className="lay-grid" ref={grid} style={{ ["--lay-scale" as any]: String(scale) }}>
            {variants.map((v) => {
              const key = `${id}:${v}`;
              const shot = shots[key];
              const h = heights[key] || FRAME_H;
              return (
                <div key={key} className={`lay-tile${chosen === v && id === template ? " picked" : ""}`}>
                  <button type="button" className="lay-open" disabled={busy}
                    title="See this layout full size" aria-label={`See the ${label(v)} layout full size`}
                    onClick={() => { setZoom(v); setDevice("desktop"); }}>
                    <span className="lay-shot" style={{ height: Math.max(90, Math.round(h * scale)) }}>
                      {shot?.error ? <span className="lay-failed">This layout could not be drawn here.</span>
                        : shot ? (
                          // The frame is 1280px wide and scaled down, so the tile shows the DESKTOP layout, not a
                          // phone-width version of it. It is inert: nothing inside can be clicked or scrolled.
                          <iframe title={`${id} ${v}`} sandbox="allow-same-origin" scrolling="no" tabIndex={-1}
                            srcDoc={docFor(shot)} style={{ height: h }}
                            onLoad={(e) => {
                              const m = measure(e.currentTarget);
                              if (m) setHeights((x) => (x[key] === m ? x : { ...x, [key]: m }));
                            }} />
                        ) : <span className="lay-loading"><span className="spin" /></span>}
                      <span className="lay-zoom"><Icon.Search size={13} /> Full size</span>
                    </span>
                    <span className="lay-name">{label(v)}</span>
                    <span className="lay-id"><code>{v}</code></span>
                  </button>
                  <button type="button" className="lay-use" disabled={busy} onClick={() => send(v)}>
                    {chosen === v && id === template ? "Chosen" : "Use this"}
                  </button>
                </div>
              );
            })}
            {!rows && !error && <div className="lay-loading"><span className="spin" /> Drawing each layout on your site…</div>}
          </div>

          {!answered && (
            <div className="lay-foot">
              <button type="button" className="btn sm" disabled={busy} onClick={onDismiss}>You choose</button>
              <span className="grow" />
              <button type="button" className="lay-never" disabled={busy} onClick={onNeverAsk}>Don't ask me again</button>
            </div>
          )}
        </>
      )}

      {/* Full size, over everything: the one thing a tile cannot be, however tall it is. */}
      {zoom && (
        <div className="lay-modal" role="dialog" aria-modal="true" aria-label={`${label(zoom)} layout, full size`}
          onClick={(e) => { if (e.target === e.currentTarget) setZoom(null); }}>
          <div className="lay-modal-box">
            <header className="lay-modal-head">
              <div className="lay-modal-title">
                <b>{label(zoom)}</b>
                <code>{niceId(id)} · {zoom}</code>
              </div>
              <span className="grow" />
              <div className="lay-devices" role="tablist" aria-label="Screen size">
                {(Object.keys(DEVICE) as Device[]).map((d) => (
                  <button key={d} role="tab" aria-selected={device === d} className={device === d ? "on" : ""}
                    onClick={() => setDevice(d)}>{d === "desktop" ? "Desktop" : d === "tablet" ? "Tablet" : "Phone"}</button>
                ))}
              </div>
              <button type="button" className="lay-x" onClick={() => setZoom(null)} aria-label="Close">×</button>
            </header>

            <div className="lay-stage" ref={stage}>
              {zoomShot?.error ? <p className="lay-failed">This layout could not be drawn here.</p>
                : zoomShot ? (
                  <iframe key={`${id}:${zoom}:${device}`} title={`${id} ${zoom} full size`} sandbox="allow-same-origin"
                    srcDoc={docFor(zoomShot, DEVICE[device])}
                    style={{ width: DEVICE[device], height: Math.round(zoomH), transform: `scale(${zoomScale})` }}
                    onLoad={(e) => {
                      const m = measure(e.currentTarget);
                      if (m) setHeights((x) => (x[zoomKey] === m ? x : { ...x, [zoomKey]: m }));
                    }} />
                ) : <p className="lay-loading"><span className="spin" /> Drawing it on your site…</p>}
            </div>

            <footer className="lay-modal-foot">
              {variants.length > 1 && (
                <>
                  <button type="button" className="btn sm" onClick={() => {
                    const i = variants.indexOf(zoom);
                    setZoom(variants[(i - 1 + variants.length) % variants.length]);
                  }}>← Previous</button>
                  <button type="button" className="btn sm" onClick={() => {
                    const i = variants.indexOf(zoom);
                    setZoom(variants[(i + 1) % variants.length]);
                  }}>Next →</button>
                  <span className="lay-count">{variants.indexOf(zoom) + 1} of {variants.length}</span>
                </>
              )}
              <span className="grow" />
              <button type="button" className="btn primary" disabled={busy}
                onClick={() => { setZoom(null); send(zoom); }}>Use this layout</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
