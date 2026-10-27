import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SectionCatalogue } from "../api";
import { Icon } from "../icons";

/**
 * The Section Gallery: ready-made sections a person browses and adds to the page with one click.
 *
 * It opens inside the side panel, like the rest of the chat. The expand icon makes it a large popup over the page:
 * the widget asks the plugin to widen its panel (lc:wide, plugin 0.24+) and fills it, and the collapse icon puts it
 * back. With an older plugin the gallery simply stays in the panel.
 *
 * Each picture is the real section, rendered as a page of its own with this site's brand colour and fonts and scaled
 * down, never a stock screenshot. A section opens in its own detail view (desktop / tablet / phone, the other layouts
 * of the same kind, where to put it) and "Add to this page" writes it as a draft: no AI, no tokens, undo from Changes.
 */

const DEVICE = { desktop: 1280, tablet: 820, phone: 390 } as const;
type Device = keyof typeof DEVICE;

/** One request per section per site, shared by the tile and the detail view. */
const htmlCache = new Map<string, Promise<string>>();
type Brand = { color: string; on: string; radius?: number };
function usePreview(siteId: string, id: string, brand: Brand | null) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const key = `${siteId}|${id}|${brand ? `${brand.color}${brand.on}${brand.radius ?? ""}` : ""}`;
    setHtml(null); setErr("");
    if (!htmlCache.has(key)) htmlCache.set(key, api.sectionPreview(siteId, id, brand).then((r) => r.html));
    htmlCache.get(key)!.then((h) => { if (alive) setHtml(h); }).catch((e) => { htmlCache.delete(key); if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [siteId, id, brand]);
  return { html, err };
}

/** A section rendered at a real screen width and scaled to the box. Inert: nothing inside can be clicked. */
function Frame({ html, width, cap }: { html: string; width: number; cap?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [h, setH] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const measure = () => {
    const d = frame.current?.contentDocument;
    if (d) setH(Math.max(160, d.body.scrollHeight));
  };
  const scale = boxW ? Math.min(1, boxW / width) : 0;
  const shown = Math.round(h * scale);
  return (
    <div ref={box} className="sg-frame" style={{ height: cap ? Math.min(shown, cap) : shown }}>
      {scale > 0 && (
        <iframe ref={frame} title="Section preview" srcDoc={html} onLoad={measure} tabIndex={-1} aria-hidden="true" sandbox="allow-same-origin"
          style={{ width, height: h, transform: `scale(${scale})`, marginLeft: Math.max(0, (boxW - width * scale) / 2) }} />
      )}
    </div>
  );
}

function Tile({ siteId, s, brand, onOpen }: { siteId: string; s: SectionCatalogue["sections"][number]; brand: Brand | null; onOpen: () => void }) {
  const { html, err } = usePreview(siteId, s.id, brand);
  return (
    <button type="button" className="sg-tile" onClick={onOpen}>
      <span className="sg-thumb">
        {html ? <Frame html={html} width={DEVICE.desktop} cap={230} /> : <span className="sg-ph">{err ? "Preview not available" : <span className="spin" />}</span>}
      </span>
      <span className="sg-tile-text"><b>{s.name}</b><small>{s.summary}</small></span>
    </button>
  );
}

function Detail({ siteId, data, id, postId, layout, onBack, onPick, onAdded }: {
  siteId: string; data: SectionCatalogue; id: string; postId: number; layout: Layout | null;
  onBack: () => void; onPick: (id: string) => void; onAdded: (name: string) => void;
}) {
  const s = data.sections.find((x) => x.id === id)!;
  const siblings = data.sections.filter((x) => x.category === s.category);
  const places = data.page?.places ?? [];
  const [device, setDevice] = useState<Device>("desktop");
  const [place, setPlace] = useState(places.length ? places[places.length - 1].value : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { html, err: previewErr } = usePreview(siteId, id, layout?.brand ?? null);

  // Arrow keys step through the layouts of the same kind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "SELECT") return;
      const i = siblings.findIndex((x) => x.id === id);
      if (e.key === "ArrowRight" && i < siblings.length - 1) onPick(siblings[i + 1].id);
      if (e.key === "ArrowLeft" && i > 0) onPick(siblings[i - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, siblings, onPick]);

  const cannot = !postId ? "Open the page you want to add it to, then try again." : data.page?.unsupported ?? (places.length ? "" : "This page cannot take a section yet.");

  async function add() {
    setBusy(true); setErr("");
    try { const r = await api.addSection(siteId, { id, post: postId, place, layout }); onAdded(r.name); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="sg-detail" role="dialog" aria-modal="true" aria-label={s.name}>
      <div className="sg-dhead">
        <button type="button" className="btn ghost small sg-back" onClick={onBack}><Icon.ChevronRight size={14} /> All sections</button>
        <b className="sg-dtitle">{s.name}</b>
        <div className="sg-devices" role="group" aria-label="Screen size">
          {(["desktop", "tablet", "phone"] as Device[]).map((d) => (
            <button key={d} type="button" aria-pressed={device === d} className={device === d ? "on" : ""} onClick={() => setDevice(d)}>
              {d === "desktop" ? <Icon.Monitor size={14} /> : d === "tablet" ? <Icon.Tablet size={14} /> : <Icon.Phone size={14} />}
              <span>{d === "desktop" ? "Desktop" : d === "tablet" ? "Tablet" : "Phone"}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="sg-dbody">
        <div className="sg-stage">
          {html ? <Frame html={html} width={DEVICE[device]} /> : <div className="sg-ph big">{previewErr ? `Preview not available: ${previewErr}` : <span className="spin" />}</div>}
          <p className="sg-note">Shown in your site's colours and fonts. Use the arrow keys to switch layouts.</p>
        </div>
        <aside className="sg-side">
          <p className="muted">{s.summary}</p>
          {siblings.length > 1 && (
            <>
              <div className="sg-label">Layouts</div>
              <div className="sg-sibs">
                {siblings.map((x) => (
                  <button key={x.id} type="button" className={x.id === id ? "on" : ""} aria-pressed={x.id === id} onClick={() => onPick(x.id)}>{x.name.replace(/^[^,]+,\s*/, "")}</button>
                ))}
              </div>
            </>
          )}
          <label className="sg-label" htmlFor="sg-place">Place it</label>
          <select id="sg-place" className="sg-select" value={place} onChange={(e) => setPlace(e.target.value)} disabled={!places.length || busy}>
            {places.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <button type="button" className="btn primary wide sg-add" disabled={busy || !!cannot} onClick={() => void add()}>
            {busy ? <span className="spin" /> : <Icon.Plus size={16} />} {busy ? "Adding…" : "Add to this page"}
          </button>
          {(cannot || err) && <div className="banner error sg-err">{err || cannot}</div>}
          <p className="sg-note">Added as a draft: visitors see it only after you deploy. Undo it any time from Changes.</p>
        </aside>
      </div>
    </div>
  );
}

type Layout = { container?: number; gutter?: number; className?: string; brand?: Brand };

export function SectionGallery({ siteId, postId, onClose, onAdded, post, parentOrigin }: {
  siteId: string; postId: number; onClose: () => void; onAdded: (name: string) => void;
  /** The page around the widget: it measures the site's content width (lc:measure, plugin 0.24.3+). */
  parentOrigin: string;
  /** Talk to the plugin around the widget (lc:wide). */
  post: (msg: Record<string, unknown>) => void;
}) {
  const [data, setData] = useState<SectionCatalogue | null>(null);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [measured, setMeasured] = useState(false); // previews wait for the page's brand (briefly: older plugins never answer)

  // Ask the page how wide the theme's content box is, so added sections line up with it (older plugins never answer).
  useEffect(() => {
    const id = Math.random().toString(36).slice(2);
    const on = (e: MessageEvent) => {
      if (e.origin !== parentOrigin || e.data?.type !== "lc:measure-result" || e.data.id !== id) return;
      const l = e.data.layout;
      if (l && typeof l === "object") {
        setLayout(l as Layout); // the backend checks every value before it uses one
        void api.sectionSite(siteId, l).catch(() => {}); // remembered for the site; sections already on it wear the theme's container class
      }
      setMeasured(true);
    };
    window.addEventListener("message", on);
    post({ type: "lc:measure", id });
    const t = setTimeout(() => setMeasured(true), 900);
    return () => { window.removeEventListener("message", on); clearTimeout(t); };
  }, [post, parentOrigin, siteId]);

  // In the side panel until the person asks for room; never left widened behind a closed gallery.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    post({ type: "lc:wide", on: wide });
    return () => { if (wide) post({ type: "lc:wide", on: false }); };
  }, [post, wide]);
  useEffect(() => {
    let alive = true;
    api.sections(siteId, postId || undefined).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [siteId, postId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (open) setOpen(null); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const list = useMemo(() => {
    if (!data) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.sections.filter((s) => (cat === "all" || s.category === cat)
      && words.every((w) => `${s.name} ${s.summary} ${s.category}`.toLowerCase().includes(w)));
  }, [data, cat, q]);

  return (
    <div className="sg" role="dialog" aria-modal="true" aria-label="Add a section">
      <header className="sg-head">
        <b className="sg-title">Add a section</b>
        <label className="sg-search">
          <Icon.Search size={15} />
          <input id="sg-search" type="search" placeholder="Search: hero, features, call to action" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="w-icon" onClick={() => setWide((w) => !w)}
          title={wide ? "Back to the side panel" : "Open larger, in the middle of the screen"} aria-label={wide ? "Collapse" : "Expand"}>
          {wide ? <Icon.Collapse size={16} /> : <Icon.Expand size={16} />}
        </button>
        <button type="button" className="btn ghost small" onClick={onClose}><Icon.Close size={15} /> Close</button>
      </header>
      {err && <div className="banner error w-banner">{err}</div>}
      {data?.page?.unsupported && <div className="banner warn w-banner">{data.page.unsupported}</div>}
      {!data && !err && <div className="sg-ph big"><span className="spin" /></div>}
      {data && (
        <div className="sg-body">
          <nav className="sg-cats" aria-label="Kinds of section">
            {[{ id: "all", name: "All sections", count: data.sections.length }, ...data.categories].map((c) => (
              <button key={c.id} type="button" className={cat === c.id ? "on" : ""} aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
                <span>{c.name}</span><small>{c.count}</small>
              </button>
            ))}
          </nav>
          <div className="sg-grid">
            {!measured && <div className="sg-ph big"><span className="spin" /></div>}
            {measured && list.map((s) => <Tile key={s.id} siteId={siteId} s={s} brand={layout?.brand ?? null} onOpen={() => setOpen(s.id)} />)}
            {measured && !list.length && <p className="muted sg-empty">No section matches "{q}". Try another word, or pick a kind on the left.</p>}
          </div>
        </div>
      )}
      {data && open && <Detail siteId={siteId} data={data} id={open} postId={postId} layout={layout} onBack={() => setOpen(null)} onPick={setOpen} onAdded={onAdded} />}
    </div>
  );
}
