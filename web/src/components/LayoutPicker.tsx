import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";

/**
 * "Which of these should it look like?" - the assistant's offer_layouts tool, as pictures.
 *
 * Every other design decision the assistant takes from the site itself. The layout of a section is the exception:
 * it changes what the page says about the person, and they can judge that from a picture in a second. So each
 * layout is rendered BY THEIR OWN SITE (the same route the component gallery uses), which means the tiles carry
 * their brand colour, their fonts and their spacing - not a stock screenshot of someone else's website.
 *
 * Picking one sends an ordinary message back, so the assistant continues exactly as if they had typed it.
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

interface Shot { html: string; css: string[]; custom?: string; error?: string }

/** A whole little document for the frame: the site's stylesheets, then the section, and nothing else. */
const docFor = (r: Shot) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=1280, initial-scale=1">
${r.css.map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`).join("")}
<style>${r.custom ?? ""}
html,body{margin:0;padding:0;background:#fff;}
body>*{max-width:100%}</style>
</head><body>${r.html}</body></html>`;

export function LayoutPicker({ siteId, template, intro, only, busy, onSend, onDismiss, onNeverAsk }: {
  siteId: string;
  template: string;
  intro?: string;
  /** Only these layouts, when the assistant narrowed the choice. */
  only?: string[] | null;
  busy: boolean;
  onSend: (text: string) => void;
  /** "You choose" - the assistant decides this once. */
  onDismiss: () => void;
  /** Turn the picker off for good. */
  onNeverAsk: () => void;
}) {
  const [variants, setVariants] = useState<string[] | null>(null);
  /** The id the SITE knows this template by ("hero_centered"), which is not always what the model called it. */
  const [id, setId] = useState(template);
  const [shots, setShots] = useState<Record<string, Shot>>({});
  const [error, setError] = useState("");
  const asked = useRef<Set<string>>(new Set());

  // Which layouts this template has: the site reports them, so the list can never drift from what it can render.
  useEffect(() => {
    let alive = true;
    api.templates(siteId)
      .then((r) => {
        if (!alive) return;
        const norm = (x: string) => x.replace(/-/g, "_");
        const row = (r.components ?? []).find((t) => norm(t.id) === norm(template));
        if (row) setId(row.id);
        const all = row?.variants ?? [];
        const list = only?.length ? all.filter((v) => only.includes(v)) : all;
        setVariants(list.length ? list : all);
        if (!all.length) setError("This site's template library does not report any layouts for this section. Update the Livecrafts plugin to see them.");
      })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [siteId, template, only]);

  // Render each one once. They arrive as they finish, so the first tiles appear while the rest are still coming.
  useEffect(() => {
    for (const v of variants ?? []) {
      if (asked.current.has(v)) continue;
      asked.current.add(v);
      api.renderTemplate(siteId, id, v)
        .then((r: any) => setShots((m) => ({ ...m, [v]: { html: r.html, css: r.css ?? [], custom: r.custom } })))
        .catch((e) => setShots((m) => ({ ...m, [v]: { html: "", css: [], error: (e as Error).message } })));
    }
  }, [variants, siteId, id]);

  const nice = useMemo(() => template.replace(/[-_]/g, " "), [template]);

  return (
    <div className="lay-card">
      <div className="lay-head">
        <Icon.Sparkle size={14} /> <b>Which layout for the {nice}?</b>
      </div>
      {intro && <p className="lay-intro">{intro}</p>}
      {error && <div className="lay-error">{error}</div>}

      <div className="lay-grid">
        {(variants ?? []).map((v) => {
          const shot = shots[v];
          return (
            <button key={v} type="button" className="lay-tile" disabled={busy}
              onClick={() => onSend(`Use the "${v}" layout for the ${nice}.`)}>
              <span className="lay-shot">
                {shot?.error ? <span className="lay-failed">This layout could not be drawn here.</span>
                  : shot ? (
                    // The frame is 1280px wide and scaled down, so the tile shows the DESKTOP layout, not a
                    // phone-width version of it. It is inert: nothing inside can be clicked or scrolled.
                    <iframe title={`${id} ${v}`} sandbox="allow-same-origin" scrolling="no" tabIndex={-1} srcDoc={docFor(shot)} />
                  ) : <span className="lay-loading"><span className="spin" /></span>}
              </span>
              <span className="lay-name">{label(v)}</span>
              <span className="lay-id"><code>{v}</code></span>
            </button>
          );
        })}
        {!variants && !error && <div className="lay-loading"><span className="spin" /> Drawing each layout on your site…</div>}
      </div>

      <div className="lay-foot">
        <button type="button" className="btn sm" disabled={busy} onClick={onDismiss}>You choose</button>
        <span className="grow" />
        <button type="button" className="lay-never" disabled={busy} onClick={onNeverAsk}>Don't ask me again</button>
      </div>
    </div>
  );
}
