import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { UploadedFile } from "../types";

/** What the plugin's element picker sends for the clicked element. */
export interface PickedElement {
  selector: string; label: string; tag: string; id: string; classes: string; text: string; html: string;
  image: { src: string; alt: string; selector?: string } | null; link: string; styles: Record<string, string>; rawText?: string; bgImage?: string;
  rect: { width: number; height: number }; section: string; pageUrl: string; viewport: number;
  pageKey?: string; elementor?: { post: number; id: string; widget: string } | null; hasChildren?: boolean;
  similarSelector?: string; similarCount?: number;
}

export type EditMode = "manual" | "agent";
export type Device = "all" | "tablet" | "mobile";
/** A manual edit (sent to the backend, no AI). */
export interface ManualEdit {
  kind: "style" | "text" | "image" | "hide" | "show" | "field"; selector: string; label: string; pageUrl: string; pageKey?: string; target?: string; value?: string; bgImage?: string;
  scope?: "page" | "site"; device?: Device; styles?: Record<string, string>; fileId?: string; imageSrc?: string;
  elementor?: PickedElement["elementor"]; oldText?: string; newText?: string; hasChildren?: boolean;
}

const toHex = (v: string) => {
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return v.startsWith("#") ? v : "";
  if (m[4] !== undefined && Number(m[4]) === 0) return "transparent";
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
};
const px = (v: string) => (v && v !== "auto" && v !== "normal" ? v : "");

type Fields = Record<string, string>;
const FIELDS: { key: string; label: string; props: string[]; kind?: "color" | "select"; options?: string[]; group: "type" | "color" | "layout" | "size" }[] = [
  { key: "fontSize", label: "Size", props: ["font-size"], group: "type" },
  { key: "fontWeight", label: "Weight", props: ["font-weight"], kind: "select", options: ["300", "400", "500", "600", "700", "800"], group: "type" },
  { key: "lineHeight", label: "Line height", props: ["line-height"], group: "type" },
  { key: "letterSpacing", label: "Letter spacing", props: ["letter-spacing"], group: "type" },
  { key: "textTransform", label: "Case", props: ["text-transform"], kind: "select", options: ["none", "uppercase", "lowercase", "capitalize"], group: "type" },
  { key: "fontFamily", label: "Font", props: ["font-family"], group: "type" },
  { key: "color", label: "Text", props: ["color"], kind: "color", group: "color" },
  { key: "background", label: "Background", props: ["background-color"], kind: "color", group: "color" },
  { key: "paddingTop", label: "Padding top", props: ["padding-top"], group: "layout" },
  { key: "paddingBottom", label: "Padding bottom", props: ["padding-bottom"], group: "layout" },
  { key: "paddingX", label: "Padding sides", props: ["padding-left", "padding-right"], group: "layout" },
  { key: "marginTop", label: "Space above", props: ["margin-top"], group: "layout" },
  { key: "marginBottom", label: "Space below", props: ["margin-bottom"], group: "layout" },
  { key: "radius", label: "Corner radius", props: ["border-radius"], group: "layout" },
  { key: "width", label: "W", props: ["width"], group: "size" },
  { key: "height", label: "H", props: ["height"], group: "size" },
  { key: "maxWidth", label: "Max width", props: ["max-width"], group: "size" },
];

function initialFields(el: PickedElement | null): Fields {
  const f: Fields = {};
  if (!el) return f;
  for (const d of FIELDS) {
    const raw = el.styles[d.props[0]] ?? "";
    f[d.key] = d.kind === "color" ? toHex(raw) : d.key === "width" || d.key === "height" ? String(d.key === "width" ? el.rect.width : el.rect.height) + "px" : px(raw);
  }
  f.align = el.styles["text-align"] ?? "";
  return f;
}

/** Turns the selected element into context for the assistant. */
export function elementContext(el: PickedElement): string {
  const keep = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "text-align", "padding-top", "padding-bottom", "margin-top", "margin-bottom", "width", "max-width"];
  const styles = keep.map((k) => `${k}: ${el.styles[k]}`).join("; ");
  return [
    `SELECTED ELEMENT on ${el.pageUrl} (viewport ${el.viewport}px wide):`,
    `- CSS selector: ${el.selector}${el.similarCount && el.similarCount > 1 ? ` (similar elements: ${el.similarSelector}, ${el.similarCount} on this page)` : ""}`,
    `- element: <${el.tag}${el.id ? ` id="${el.id}"` : ""}${el.classes ? ` class="${el.classes}"` : ""}>${el.section ? ` inside ${el.section}` : ""}`,
    el.elementor ? `- Elementor widget ${el.elementor.widget} id ${el.elementor.id} on post ${el.elementor.post}` : "",
    el.text ? `- text: "${el.text.slice(0, 200)}"` : "",
    el.image ? `- image: ${el.image.src}${el.image.alt ? ` (alt "${el.image.alt}")` : ""}` : "",
    el.link ? `- links to: ${el.link}` : "",
    `- current styles: ${styles}`,
    `- HTML (start): ${el.html.slice(0, 600)}`,
  ].filter(Boolean).join("\n");
}

const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };
const DEVICES: { id: Device; label: string; icon: ReactElement; hint: string }[] = [
  { id: "all", label: "All screens", icon: <Icon.Monitor size={14} />, hint: "" },
  { id: "tablet", label: "Tablet", icon: <Icon.Tablet size={14} />, hint: "Saved for screens up to 1024px wide." },
  { id: "mobile", label: "Mobile", icon: <Icon.Phone size={14} />, hint: "Saved for screens up to 767px wide." },
];

type Field = { target: string; source: string; label: string; key: string; type: string; value: string; widget?: string; elementId?: string };
const verAtLeast = (v: string | undefined, min: string) => { if (!v) return false; const a = v.split(".").map(Number), b = min.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); } return true; };

export function QuickActions({ siteId, widgetVersion, selected, picking, disabled, onPick, onCancelPick, onSend, onManual, onPreview, onClearPreview, onEditText, onUndo, canUndo, onHighlight }: {
  siteId: string; widgetVersion?: string;
  selected: PickedElement | null; picking: boolean; disabled: boolean;
  onPick: () => void; onCancelPick: () => void; onSend: (prompt: string, fileIds: string[], extraContext?: string) => Promise<void>;
  onManual: (edit: ManualEdit) => Promise<boolean>; onPreview: (selector: string, styles: Record<string, string>) => void; onClearPreview: () => void;
  onEditText: (selector: string) => void; onUndo: () => void; canUndo: boolean; onHighlight: (selector: string) => void;
}) {
  const [mode, setModeState] = useState<EditMode>((store.get("lcw_edit_mode") as EditMode) || "manual");
  const [device, setDevice] = useState<Device>("all");
  const [similar, setSimilar] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ key: string; preview: string; file?: UploadedFile; error?: string }[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({ type: true });
  const [fields, setFields] = useState<Fields>({});
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [textEdit, setTextEdit] = useState<string | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [fieldList, setFieldList] = useState<Field[] | null>(null);
  const [fieldErr, setFieldErr] = useState("");
  const [query, setQuery] = useState("");
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  const stylesOk = verAtLeast(widgetVersion, "0.9.0"); // style layer + inline editing need plugin 0.9+
  const pageUrl = selected?.pageUrl ?? "";
  const loadFields = () => {
    if (!pageUrl) return;
    setFieldErr(""); setFieldList(null);
    api.fields(siteId, pageUrl).then((r) => { setFieldList(r.fields); setFieldEdits({}); }).catch((e) => { setFieldErr(e.message); setFieldList([]); });
  };
  useEffect(() => { if (fieldsOpen) loadFields(); }, [fieldsOpen, pageUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => initialFields(selected), [selected]);
  const setMode = (m: EditMode) => { setModeState(m); store.set("lcw_edit_mode", m); };

  useEffect(() => { setFields(base); setText(""); setSimilar(false); setDevice("all"); setTextEdit(null); }, [base]);

  const edited = Object.keys(fields).filter((k) => (fields[k] ?? "") !== (base[k] ?? ""));
  const ready = files.filter((f) => f.file).map((f) => f.file!.id);
  const uploading = files.some((f) => !f.file && !f.error);
  const canSimilar = !!selected?.similarSelector && (selected.similarCount ?? 0) > 1;
  const targetSelector = selected ? (similar && canSimilar ? selected.similarSelector! : selected.selector) : "";

  /** The edited fields as CSS. */
  const styles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of edited) {
      if (k === "align") { out["text-align"] = fields.align; continue; }
      const d = FIELDS.find((x) => x.key === k);
      if (d) for (const p of d.props) out[p] = fields[k];
    }
    return out;
  }, [fields, edited.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // live preview on the page while editing manually (nothing is saved until "Save")
  useEffect(() => {
    if (mode !== "manual" || !selected || !Object.keys(styles).length) { onClearPreview(); return; }
    onPreview(targetSelector, styles);
  }, [mode, targetSelector, JSON.stringify(styles)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onClearPreview(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function attach(list: FileList) {
    for (const f of Array.from(list)) {
      if (!f.type.startsWith("image/")) continue;
      const key = Math.random().toString(36).slice(2);
      setFiles((a) => [...a, { key, preview: URL.createObjectURL(f) }]);
      api.uploadFile(f).then((file) => setFiles((a) => a.map((x) => (x.key === key ? { ...x, file } : x))))
        .catch((e) => setFiles((a) => a.map((x) => (x.key === key ? { ...x, error: e.message } : x))));
    }
  }

  /** AI agent: `request` is shown in the chat; `howTo` + element details go to the assistant as context. */
  async function ask(request: string, fileIds: string[] = ready, howTo = "") {
    if (!selected) return;
    setBusy(true);
    try {
      const scope = similar && canSimilar ? `Apply it to ALL similar elements (${selected.similarSelector}), on every page where they appear.` : "Change only this element (if others share the same CSS rule, say so).";
      const dev = device === "all" ? "" : ` Only for ${device} screens (${device === "tablet" ? "≤1024px" : "≤767px"}).`;
      await onSend(`${request}${similar && canSimilar ? " (all similar)" : ""}${device !== "all" ? ` (${device})` : ""}`, fileIds, `${howTo ? howTo + "\n" : ""}${scope}${dev}\n\n${elementContext(selected)}`);
      setText(""); setFiles([]);
    } finally { setBusy(false); }
  }

  /** Manual: saved straight into the safe style overlay / the real field. No AI. */
  async function manual(edit: Omit<ManualEdit, "selector" | "label" | "pageUrl" | "pageKey" | "elementor">) {
    if (!selected) return false;
    setBusy(true);
    try {
      return await onManual({
        selector: edit.kind === "style" || edit.kind === "hide" || edit.kind === "show" ? targetSelector : selected.selector,
        label: similar && canSimilar && (edit.kind === "style" || edit.kind === "hide") ? `all ${selected.similarSelector}` : selected.label,
        pageUrl: selected.pageUrl, pageKey: selected.pageKey, elementor: selected.elementor ?? null,
        scope: similar && canSimilar ? "site" : "page", device, ...edit,
      });
    } finally { setBusy(false); }
  }

  function applyStyles() {
    if (mode === "manual") { void manual({ kind: "style", styles }); return; }
    const lines = Object.entries(styles).map(([p, v]) => `- ${p}: ${base[FIELDS.find((d) => d.props.includes(p))?.key ?? "align"] || "(not set)"} → ${v}`);
    void ask(`Change the style of ${selected?.label ?? "the selected element"}:\n${lines.join("\n")}`, [],
      "Keep it responsive - scale sizes down sensibly on tablet and mobile. Use the right place for this site (see your rules: style_patch on Elementor/third-party themes, the theme stylesheet on the site's own theme).");
  }

  const agentOnly = [
    { id: "dup", icon: <Icon.Duplicate size={16} />, label: "Duplicate", prompt: "Duplicate this element/section right below itself (same design), so I can change the copy afterwards." },
    { id: "del", icon: <Icon.Trash size={16} />, label: "Remove", prompt: "Remove this element/section from the page." },
    { id: "mobile", icon: <Icon.Phone size={16} />, label: "Fix mobile", prompt: "Check this element on mobile and tablet and fix anything that looks broken, too big, cramped or overflowing." },
    { id: "improve", icon: <Icon.Wand size={16} />, label: "Improve", prompt: "Improve this element professionally: better copy, spacing, typography and visual hierarchy, consistent with the rest of the site's design. Keep it responsive and accessible." },
  ];

  if (!selected) {
    return (
      <div className="qa-empty">
        <div className="qa-orb"><Icon.Cursor size={26} /></div>
        <strong>Pick something on the page</strong>
        <p>Click <b>Pick element</b>, then click any heading, button, image or section. Change it yourself (manual, saved instantly and safely) or let the AI agent do it.</p>
        {picking
          ? <button className="btn" onClick={onCancelPick}>Cancel picking</button>
          : <button className="btn primary" disabled={disabled} onClick={onPick}><Icon.Cursor size={15} /> Pick element</button>}
      </div>
    );
  }

  const isManual = mode === "manual";
  return (
    <div className="qa">
      <div className="qa-sel">
        <div className="qa-sel-main" onClick={() => onHighlight(selected.selector)} title="Show it on the page">
          <code>{selected.label}{selected.elementor ? " · Elementor" : ""}</code>
          <span>{selected.text ? `“${selected.text.slice(0, 70)}${selected.text.length > 70 ? "…" : ""}”` : selected.image ? "Image" : selected.tag}</span>
        </div>
        <button className="rbtn" onClick={picking ? onCancelPick : onPick} disabled={disabled}><Icon.Cursor size={13} /> {picking ? "Picking…" : "Pick another"}</button>
      </div>

      <div className="qa-mode" role="tablist" aria-label="How to change it">
        <button role="tab" aria-selected={isManual} className={isManual ? "on" : ""} onClick={() => setMode("manual")}><Icon.Edit size={14} /> Manual</button>
        <button role="tab" aria-selected={!isManual} className={!isManual ? "on" : ""} onClick={() => setMode("agent")}><Icon.Sparkle size={14} /> AI agent</button>
      </div>
      <p className="qa-mode-hint">{isManual
        ? "You change it yourself - saved instantly in a safe style layer (no theme files touched), works with Elementor, ACF and any theme. Revert any time in Changes."
        : "The AI agent makes the change properly in the right place (theme, Elementor or field) and verifies it."}</p>

      <div className="qa-label">Quick actions</div>
      <div className="qa-quick">
        <button className="qa-q" disabled={disabled || busy || !selected.text} title={isManual ? "Edit the text right on the page" : "Ask the AI to change the text"}
          onClick={() => (isManual ? setTextEdit(selected.rawText ?? selected.text) : setText(`Change the text to: "${selected.text.slice(0, 120)}"`))}>
          <Icon.Type size={16} /><span>Edit text</span>
        </button>

        <button className="qa-q" disabled={disabled || busy} title={`Hide it${device !== "all" ? ` on ${device}` : ""}`}
          onClick={() => (isManual ? void manual({ kind: "hide" }) : void ask(`Hide this element${device !== "all" ? ` on ${device}` : ""}.`))}>
          <Icon.Hide size={16} /><span>Hide{device !== "all" ? ` (${device})` : ""}</span>
        </button>
        <button className="qa-q" title="Revert the last request" disabled={disabled || !canUndo} onClick={onUndo}><Icon.Retry size={16} /><span>Undo</span></button>
        {agentOnly.map((q) => (
          <button key={q.id} className="qa-q ai" title={`${q.label} - done by the AI agent`} disabled={disabled || busy} onClick={() => void ask(q.prompt)}>
            {q.icon}<span>{q.label}</span><i className="qa-ai-badge"><Icon.Sparkle size={10} /></i>
          </button>
        ))}
      </div>
      <input ref={imageInput} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = "";
        if (!f) return;
        setBusy(true);
        try { const up = await api.uploadFile(f); await manual({ kind: "image", fileId: up.id, imageSrc: selected.image?.src, bgImage: selected.bgImage }); }
        catch (x) { alert((x as Error).message); } finally { setBusy(false); }
      }} />

      {isManual && !stylesOk && (
        <div className="qa-warn"><Icon.Shield size={14} /><span>Your site runs an older Livecrafts plugin{widgetVersion ? ` (${widgetVersion})` : ""}. Text, image and field edits work; <b>style editing needs plugin 0.9.1</b> - install the latest <code>livecrafts.zip</code> (Plugins → Add New → Upload → Replace current).</span></div>
      )}

      {textEdit !== null && (
        <div className="qa-textedit">
          <div className="qa-label">Edit text</div>
          <textarea autoFocus value={textEdit} onChange={(e) => setTextEdit(e.target.value)} rows={Math.min(8, Math.max(2, Math.ceil(textEdit.length / 40)))} />
          <p className="qa-mode-hint">Saved into the Elementor widget or ACF field this text comes from (exact text, not the on-screen capitals).</p>
          <div className="qa-ai-bar">
            {stylesOk && <button className="rbtn" onClick={() => { setTextEdit(null); onEditText(selected.selector); }}><Icon.Cursor size={13} /> Edit on the page</button>}
            <span className="grow" />
            <button className="rbtn" onClick={() => setTextEdit(null)}>Cancel</button>
            <button className="btn accent sm" disabled={busy || !textEdit.trim() || textEdit.trim() === (selected.rawText ?? selected.text).trim()}
              onClick={async () => { if (await manual({ kind: "text", oldText: selected.rawText ?? selected.text, newText: textEdit.trim(), hasChildren: selected.hasChildren })) setTextEdit(null); }}>
              {busy ? <span className="spin" /> : <Icon.Check size={14} />} Save text
            </button>
          </div>
        </div>
      )}

      {(selected.image || selected.bgImage) && (
        <>
          <div className="qa-label">Image</div>
          <div className="qa-image">
            <img src={selected.image?.src || selected.bgImage} alt={selected.image?.alt ?? ""} />
            <div className="qa-image-actions">
              <button className="rbtn" disabled={disabled || busy} onClick={() => (isManual ? imageInput.current?.click() : fileInput.current?.click())}><Icon.Image size={13} /> Replace</button>
              {selected.image?.selector && (
                <button className="rbtn danger" disabled={disabled || busy || !stylesOk} title={stylesOk ? "Hide this image (revertable)" : "Needs plugin 0.9.1"}
                  onClick={() => (isManual ? void onManual({ kind: "hide", selector: selected.image!.selector!, label: "image", pageUrl: selected.pageUrl, pageKey: selected.pageKey, scope: "page", device }) : void ask("Remove this image from the page."))}>
                  <Icon.Trash size={13} /> Remove
                </button>
              )}
              {!isManual && <button className="rbtn" disabled={disabled || busy} onClick={() => void ask("Add a suitable image next to this element (ask me for the image if needed).")}><Icon.Plus size={13} /> Add image</button>}
            </div>
          </div>
        </>
      )}

      <div className="qa-sec">
        <button className="qa-sec-head" onClick={() => setFieldsOpen(!fieldsOpen)} aria-expanded={fieldsOpen}>
          <Icon.List size={15} /><span className="grow">Content fields on this page</span><Icon.ChevronDown size={14} className={fieldsOpen ? "up" : ""} />
        </button>
        {fieldsOpen && (
          <div className="qa-fields">
            <div className="qa-ai-bar">
              <input className="qa-search" placeholder="Search label, key or value…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="rbtn" onClick={loadFields} title="Reload"><Icon.Retry size={13} /></button>
            </div>
            {fieldErr && <div className="rdetail">{fieldErr}</div>}
            {!fieldList && !fieldErr && <div className="qa-mode-hint"><span className="spin" /> Reading the fields…</div>}
            {fieldList && fieldList.length === 0 && !fieldErr && <div className="qa-mode-hint">No ACF or Elementor fields on this page.</div>}
            {fieldList?.filter((f) => { const q = query.trim().toLowerCase(); return !q || `${f.label} ${f.key} ${f.value} ${f.source}`.toLowerCase().includes(q); }).slice(0, 60).map((f) => {
              const val = fieldEdits[f.target] ?? f.value;
              const changed = val !== f.value;
              return (
                <div key={f.target} className={`qa-frow ${changed ? "changed" : ""}`}>
                  <div className="qa-fhead"><b>{f.label || f.key}</b><span className="qa-ftag">{f.source}{f.widget ? ` · ${f.widget.split(".")[0]}` : ""}</span>{f.key && <code title={f.target}>{f.key}</code>}</div>
                  {f.type === "image"
                    ? <div className="qa-fimg">{f.value ? <img src={f.value} alt="" /> : <em>no image</em>}</div>
                    : f.type === "html" || f.type === "wysiwyg" || f.type === "textarea" || f.value.length > 60
                      ? <textarea rows={3} value={val} onChange={(e) => setFieldEdits({ ...fieldEdits, [f.target]: e.target.value })} />
                      : <input value={val} onChange={(e) => setFieldEdits({ ...fieldEdits, [f.target]: e.target.value })} />}
                  {changed && (
                    <div className="qa-ai-bar">
                      <span className="grow" />
                      <button className="rbtn" onClick={() => setFieldEdits({ ...fieldEdits, [f.target]: f.value })}>Undo</button>
                      <button className="btn accent sm" disabled={busy} onClick={async () => { if (await onManual({ kind: "field", target: f.target, value: val, selector: "field", label: f.label || f.key, pageUrl: selected.pageUrl, pageKey: selected.pageKey })) { setFieldList((l) => l?.map((x) => (x.target === f.target ? { ...x, value: val } : x)) ?? null); } }}>
                        <Icon.Check size={13} /> Save
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="qa-label">Apply to</div>
      <div className="qa-row">
        <div className="qa-seg">
          <button className={!similar ? "on" : ""} onClick={() => setSimilar(false)}>This element</button>
          <button className={similar ? "on" : ""} disabled={!canSimilar} onClick={() => setSimilar(true)} title={canSimilar ? selected.similarSelector : "No similar elements on this page"}>
            All similar{canSimilar ? ` (${selected.similarCount})` : ""}
          </button>
        </div>
        <div className="qa-seg icons" role="radiogroup" aria-label="Screen size">
          {DEVICES.map((d) => <button key={d.id} className={device === d.id ? "on" : ""} title={d.label} aria-label={d.label} onClick={() => setDevice(d.id)}>{d.icon}</button>)}
        </div>
      </div>
      {device !== "all" && <p className="qa-mode-hint">{DEVICES.find((d) => d.id === device)!.hint} Other screen sizes stay as they are.</p>}

      {!isManual && (
        <>
          <div className="qa-label">Describe the change</div>
          <div className="qa-ai">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={disabled}
              placeholder="Describe your changes - what it’s for, style preferences, and specific features you want…"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void ask(text.trim()); }} />
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
            <div className="qa-ai-bar">
              <button className="rbtn" onClick={() => fileInput.current?.click()} disabled={disabled}><Icon.Image size={13} /> Images</button>
              <span className="grow" />
              <button className="btn primary sm" disabled={disabled || busy || uploading || (!text.trim() && !ready.length)} onClick={() => void ask(text.trim() || "Use the attached image(s) for this element.")}>Submit <Icon.ChevronRight size={13} /></button>
            </div>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) attach(e.target.files); e.target.value = ""; }} />
          </div>
        </>
      )}

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
        <button className="btn accent" disabled={disabled || busy || edited.length === 0 || (isManual && !stylesOk)} title={isManual && !stylesOk ? "Style editing needs Livecrafts plugin 0.9.1" : undefined} onClick={applyStyles}>
          {busy ? <span className="spin" /> : isManual ? <Icon.Check size={15} /> : <Icon.Sparkle size={15} />}
          {isManual
            ? (edited.length ? `Save ${edited.length} change${edited.length === 1 ? "" : "s"}` : "Save changes")
            : (edited.length ? `Ask AI to apply ${edited.length} change${edited.length === 1 ? "" : "s"}` : "Ask AI to apply")}
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
