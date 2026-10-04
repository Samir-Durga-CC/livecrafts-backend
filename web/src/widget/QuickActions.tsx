import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { UploadedFile } from "../types";

/** What the plugin's element picker sends for the clicked element. */
export interface PickedElement {
  selector: string; label: string; tag: string; id: string; classes: string; text: string; html: string;
  image: { src: string; alt: string } | null; link: string; styles: Record<string, string>;
  rect: { width: number; height: number }; section: string; pageUrl: string; viewport: number;
}

const toHex = (v: string) => {
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return v.startsWith("#") ? v : "";
  if (m[4] !== undefined && Number(m[4]) === 0) return "transparent";
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
};
const px = (v: string) => (v && v !== "auto" && v !== "normal" ? v : "");

type Fields = Record<string, string>;
const FIELDS: { key: string; label: string; prop: string; kind?: "color" | "select"; options?: string[]; group: "type" | "color" | "layout" | "size" }[] = [
  { key: "fontSize", label: "Size", prop: "font-size", group: "type" },
  { key: "fontWeight", label: "Weight", prop: "font-weight", kind: "select", options: ["300", "400", "500", "600", "700", "800"], group: "type" },
  { key: "lineHeight", label: "Line height", prop: "line-height", group: "type" },
  { key: "letterSpacing", label: "Letter spacing", prop: "letter-spacing", group: "type" },
  { key: "textTransform", label: "Case", prop: "text-transform", kind: "select", options: ["none", "uppercase", "lowercase", "capitalize"], group: "type" },
  { key: "fontFamily", label: "Font", prop: "font-family", group: "type" },
  { key: "color", label: "Text", prop: "color", kind: "color", group: "color" },
  { key: "background", label: "Background", prop: "background-color", kind: "color", group: "color" },
  { key: "paddingTop", label: "Padding top", prop: "padding-top", group: "layout" },
  { key: "paddingBottom", label: "Padding bottom", prop: "padding-bottom", group: "layout" },
  { key: "paddingX", label: "Padding sides", prop: "padding-left", group: "layout" },
  { key: "marginTop", label: "Space above", prop: "margin-top", group: "layout" },
  { key: "marginBottom", label: "Space below", prop: "margin-bottom", group: "layout" },
  { key: "radius", label: "Corner radius", prop: "border-radius", group: "layout" },
  { key: "width", label: "W", prop: "width", group: "size" },
  { key: "height", label: "H", prop: "height", group: "size" },
  { key: "maxWidth", label: "Max width", prop: "max-width", group: "size" },
];

function initialFields(el: PickedElement | null): Fields {
  const f: Fields = {};
  if (!el) return f;
  for (const d of FIELDS) {
    const raw = el.styles[d.prop] ?? "";
    f[d.key] = d.kind === "color" ? toHex(raw) : d.key === "width" || d.key === "height" ? String(d.key === "width" ? el.rect.width : el.rect.height) + "px" : px(raw);
  }
  f.align = el.styles["text-align"] ?? "";
  return f;
}

/** Turns the selected element + what the person asked into one precise request for the assistant. */
export function elementContext(el: PickedElement): string {
  const keep = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "text-align", "padding-top", "padding-bottom", "margin-top", "margin-bottom", "width", "max-width"];
  const styles = keep.map((k) => `${k}: ${el.styles[k]}`).join("; ");
  return [
    `SELECTED ELEMENT on ${el.pageUrl} (viewport ${el.viewport}px wide):`,
    `- CSS selector: ${el.selector}`,
    `- element: <${el.tag}${el.id ? ` id="${el.id}"` : ""}${el.classes ? ` class="${el.classes}"` : ""}>${el.section ? ` inside ${el.section}` : ""}`,
    el.text ? `- text: "${el.text.slice(0, 200)}"` : "",
    el.image ? `- image: ${el.image.src}${el.image.alt ? ` (alt "${el.image.alt}")` : ""}` : "",
    el.link ? `- links to: ${el.link}` : "",
    `- current styles: ${styles}`,
    `- HTML (start): ${el.html.slice(0, 600)}`,
  ].filter(Boolean).join("\n");
}

export function QuickActions({ selected, picking, disabled, onPick, onCancelPick, onSend, onUndo, canUndo, onHighlight }: {
  selected: PickedElement | null; picking: boolean; disabled: boolean;
  onPick: () => void; onCancelPick: () => void; onSend: (prompt: string, fileIds: string[], extraContext?: string) => Promise<void>;
  onUndo: () => void; canUndo: boolean; onHighlight: (selector: string) => void;
}) {
  const [text, setText] = useState("");
  const [allSimilar, setAllSimilar] = useState(false);
  const [files, setFiles] = useState<{ key: string; preview: string; file?: UploadedFile; error?: string }[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({ type: true });
  const [fields, setFields] = useState<Fields>({});
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const base = useMemo(() => initialFields(selected), [selected]);

  useEffect(() => { setFields(base); setText(""); setAllSimilar(false); }, [base]);

  const edited = Object.keys(fields).filter((k) => (fields[k] ?? "") !== (base[k] ?? ""));
  const ready = files.filter((f) => f.file).map((f) => f.file!.id);
  const uploading = files.some((f) => !f.file && !f.error);

  function attach(list: FileList) {
    for (const f of Array.from(list)) {
      if (!f.type.startsWith("image/")) continue;
      const key = Math.random().toString(36).slice(2);
      setFiles((a) => [...a, { key, preview: URL.createObjectURL(f) }]);
      api.uploadFile(f).then((file) => setFiles((a) => a.map((x) => (x.key === key ? { ...x, file } : x))))
        .catch((e) => setFiles((a) => a.map((x) => (x.key === key ? { ...x, error: e.message } : x))));
    }
  }

  /** `request` is what the person sees in the chat; `howTo` + the element details go to the assistant as context. */
  async function go(request: string, fileIds: string[] = ready, howTo = "") {
    if (!selected) return;
    setBusy(true);
    try {
      const scope = allSimilar ? "Apply it to ALL similar elements/sections on the site (same component), not only this one." : "Change only this element (and identical instances if they share the same CSS rule, say so).";
      await onSend(`${request}${allSimilar ? " (all similar sections)" : ""}`, fileIds, `${howTo ? howTo + "\n" : ""}${scope}\n\n${elementContext(selected)}`);
      setText(""); setFiles([]);
    } finally { setBusy(false); }
  }

  function applyStyles() {
    const lines = edited.filter((k) => k !== "align").map((k) => {
      const d = FIELDS.find((x) => x.key === k)!;
      const prop = d.key === "paddingX" ? "padding-left and padding-right" : d.prop;
      return `- ${prop}: ${base[k] || "(not set)"} → ${fields[k]}`;
    });
    if (fields.align !== base.align) lines.push(`- text-align: ${base.align} → ${fields.align}`);
    void go(`Change the style of ${selected?.label ?? "the selected element"}:\n${lines.join("\n")}`, [],
      "Do it in the theme stylesheet by editing the rule that sets these properties (no inline styles, no !important unless needed). Keep it responsive - scale sizes down sensibly on tablet and mobile.");
  }

  const quick = [
    { id: "dup", icon: <Icon.Duplicate size={16} />, label: "Duplicate", prompt: "Duplicate this element/section right below itself (same design), so I can change the copy afterwards." },
    { id: "hide", icon: <Icon.Hide size={16} />, label: "Hide", prompt: "Hide this element on the site (keep it in the code so it can be shown again)." },
    { id: "del", icon: <Icon.Trash size={16} />, label: "Remove", prompt: "Remove this element/section from the page." },
    { id: "text", icon: <Icon.Type size={16} />, label: "Edit text", fill: `Change the text to: "${selected?.text.slice(0, 120) ?? ""}"` },
    { id: "img", icon: <Icon.Image size={16} />, label: "Replace image", image: true },
    { id: "mobile", icon: <Icon.Phone size={16} />, label: "Fix mobile", prompt: "Check this element on mobile and tablet with screenshots and fix anything that looks broken, too big, cramped or overflowing." },
  ];

  if (!selected) {
    return (
      <div className="qa-empty">
        <div className="qa-orb"><Icon.Cursor size={26} /></div>
        <strong>Pick something on the page</strong>
        <p>Click <b>Pick element</b>, then click any heading, button, image or section on the page. You can then change it with quick actions, style controls or plain words.</p>
        {picking
          ? <button className="btn" onClick={onCancelPick}>Cancel picking</button>
          : <button className="btn primary" disabled={disabled} onClick={onPick}><Icon.Cursor size={15} /> Pick element</button>}
      </div>
    );
  }

  return (
    <div className="qa">
      <div className="qa-sel">
        <div className="qa-sel-main" onClick={() => onHighlight(selected.selector)} title="Show it on the page">
          <code>{selected.label}</code>
          <span>{selected.text ? `“${selected.text.slice(0, 70)}${selected.text.length > 70 ? "…" : ""}”` : selected.image ? "Image" : selected.tag}</span>
        </div>
        <button className="rbtn" onClick={picking ? onCancelPick : onPick} disabled={disabled}><Icon.Cursor size={13} /> {picking ? "Picking…" : "Pick another"}</button>
      </div>

      <div className="qa-label">Quick actions</div>
      <div className="qa-quick">
        {quick.map((q) => (
          <button key={q.id} className="qa-q" title={q.label} disabled={disabled || busy || (q.id === "img" && !selected.image)}
            onClick={() => { if (q.image) fileInput.current?.click(); else if (q.fill) setText(q.fill); else void go(q.prompt!); }}>
            {q.icon}<span>{q.label}</span>
          </button>
        ))}
        <button className="qa-q" title="Revert the last request" disabled={disabled || !canUndo} onClick={onUndo}><Icon.Retry size={16} /><span>Undo</span></button>
      </div>

      <div className="qa-label">AI edit</div>
      <div className="qa-ai">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={disabled}
          placeholder="Describe your changes - what it’s for, style preferences, and specific features you want…"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void go(text.trim()); }} />
        {files.length > 0 && (
          <div className="attachments">
            {files.map((f) => (
              <div key={f.key} className={`att ${f.file ? "ready" : f.error ? "error" : "uploading"}`} title={f.error}>
                <img src={f.preview} alt="" />{!f.file && !f.error && <span className="att-badge"><span className="spin" /></span>}
                <button className="att-x" aria-label="remove" onClick={() => setFiles((a) => a.filter((x) => x.key !== f.key))}><Icon.Close size={11} /></button>
              </div>
            ))}
          </div>
        )}
        <label className="qa-check"><input type="checkbox" checked={allSimilar} onChange={(e) => setAllSimilar(e.target.checked)} /> Apply to all similar sections</label>
        <div className="qa-ai-bar">
          <button className="rbtn" onClick={() => fileInput.current?.click()} disabled={disabled}><Icon.Image size={13} /> Images</button>
          <button className="rbtn" disabled={disabled || busy} onClick={() => void go("Improve this element professionally: better copy, spacing, typography and visual hierarchy, consistent with the rest of the site's design. Keep it responsive and accessible.")}><Icon.Wand size={13} /> Improve</button>
          <span className="grow" />
          <button className="btn primary sm" disabled={disabled || busy || uploading || (!text.trim() && !ready.length)} onClick={() => void go(text.trim() || "Use the attached image(s) for this element.")}>Submit <Icon.ChevronRight size={13} /></button>
        </div>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) attach(e.target.files); e.target.value = ""; }} />
      </div>

      <div className="qa-label">Alignment</div>
      <div className="qa-align">
        {["left", "center", "right", "justify"].map((a) => (
          <button key={a} className={fields.align === a || (a === "left" && fields.align === "start") ? "on" : ""} onClick={() => setFields({ ...fields, align: a })} title={`Align ${a}`}>
            <AlignIcon kind={a} />
          </button>
        ))}
      </div>

      {([["type", "Typography", <Icon.Type size={15} key="t" />], ["color", "Colors", <Icon.Palette size={15} key="c" />], ["layout", "Spacing", <Icon.Layout size={15} key="l" />], ["size", "Dimensions", <Icon.Ruler size={15} key="s" />]] as const).map(([g, label, icon]) => (
        <div key={g} className="qa-sec">
          <button className="qa-sec-head" onClick={() => setOpen({ ...open, [g]: !open[g] })} aria-expanded={!!open[g]}>
            {icon}<span className="grow">{label}</span>{FIELDS.some((d) => d.group === g && edited.includes(d.key)) && <span className="qa-dot" />}<Icon.ChevronDown size={14} className={open[g] ? "up" : ""} />
          </button>
          {open[g] && (
            <div className={`qa-grid ${g === "size" ? "two" : ""}`}>
              {FIELDS.filter((d) => d.group === g).map((d) => (
                <label key={d.key} className={`qa-field ${edited.includes(d.key) ? "changed" : ""} ${d.key === "fontFamily" ? "wide" : ""}`}>
                  <span>{d.label}</span>
                  {d.kind === "select" ? (
                    <select value={fields[d.key] ?? ""} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })}>
                      {!d.options!.includes(fields[d.key] ?? "") && <option value={fields[d.key]}>{fields[d.key] || "-"}</option>}
                      {d.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : d.kind === "color" ? (
                    <span className="qa-color">
                      <input type="color" value={/^#[0-9a-f]{6}$/i.test(fields[d.key] ?? "") ? fields[d.key] : "#ffffff"} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })} />
                      <input value={fields[d.key] ?? ""} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })} spellCheck={false} />
                    </span>
                  ) : (
                    <input value={fields[d.key] ?? ""} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })} spellCheck={false} />
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="qa-apply">
        {edited.length > 0 && <button className="rbtn" onClick={() => setFields(base)}>Reset</button>}
        <button className="btn accent" disabled={disabled || busy || edited.length === 0} onClick={applyStyles}>
          <Icon.ChevronRight size={15} /> {edited.length ? `Apply ${edited.length} change${edited.length === 1 ? "" : "s"}` : "Apply changes"}
        </button>
      </div>
    </div>
  );
}

function AlignIcon({ kind }: { kind: string }) {
  const lines = kind === "center" ? [[6, 18], [4, 20], [7, 17]] : kind === "right" ? [[8, 20], [4, 20], [11, 20]] : kind === "justify" ? [[4, 20], [4, 20], [4, 20]] : [[4, 16], [4, 20], [4, 13]];
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      {lines.map(([a, b], i) => <path key={i} d={`M${a} ${7 + i * 5}h${b - a}`} />)}
    </svg>
  );
}
