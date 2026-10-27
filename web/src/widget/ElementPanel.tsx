import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Icon } from "../icons";
import type { Resolved, ResolvedAction } from "../types";
import type { PickedElement } from "./element";
import { pickMedia, uploadToMedia, wp } from "./parent";
import { SectionFields, isGallerySection } from "./SectionFields";
import { SectionPart, findPart, partName } from "./SectionPart";

const GROUPS: { id: ResolvedAction["group"]; label: string; icon: ReactElement }[] = [
  { id: "content", label: "Content", icon: <Icon.Text size={15} /> },
  { id: "style", label: "Style", icon: <Icon.Palette size={15} /> },
  { id: "layout", label: "Layout", icon: <Icon.Layout size={15} /> },
  { id: "visibility", label: "Visibility", icon: <Icon.Hide size={15} /> },
  { id: "motion", label: "Animation", icon: <Icon.Sparkle size={15} /> },
];
const SOURCE: Record<string, string> = {
  elementor: "Elementor", block: "Block editor", acf: "ACF field", menu: "Menu", section: "Livecrafts section", theme: "Theme / plugin", ambiguous: "Not sure",
};

/** Put what the person entered into a change: in its "{value}" placeholders, or as its value. */
function fill(change: Record<string, any>, value: unknown): Record<string, any> {
  const json = JSON.stringify(change);
  if (json.includes('"{value}"')) return JSON.parse(json.replace(/"\{value\}"/g, JSON.stringify(value)));
  return value === undefined ? { ...change } : { ...change, value };
}

/**
 * Colour and font set on a ready-made section - or on the Elementor widget that holds one - have to reach its words.
 * The section gives its headings the theme's heading font and their own colour rule, so a rule on the section alone
 * stopped at the paragraphs: "saved", refreshed, and the heading never changed. These two properties are written for
 * the section's headings as well, in one rule; :is() keeps it inside the selector length the plugin accepts.
 */
const SECTION_TEXT = ["color", "font-family"];
function forSection(change: Record<string, any>, sectionish: boolean): Record<string, any> {
  const v = change.value;
  if (!sectionish || change.kind !== "css.rule" || typeof v?.selector !== "string" || v.selector.includes(",") || !v.declarations) return change;
  if (!Object.keys(v.declarations).some((p) => SECTION_TEXT.includes(p))) return change;
  const wide = `${v.selector}, ${v.selector} :is(.lcs, .lcs-h, .lcs-h2, .lcs-h3)`;
  return wide.length > 300 ? change : { ...change, value: { ...v, selector: wide } };
}

/**
 * Style, visibility and animation for ONE part of a ready-made section, written as style rules on that element.
 * The resolver only knows the Elementor widget the whole section lives in, so its own options all acted on the
 * whole section. The selector is the picker's (unique on the page) behind the page's own wrapper, so a rule for
 * the second card's title on this page never reaches another page.
 */
const WEIGHTS = { "300": "Light", "400": "Regular", "500": "Medium", "600": "Semi-bold", "700": "Bold", "800": "Extra bold" };
function partActions(selector: string, device: string, font: string): ResolvedAction[] {
  const media = device === "desktop" ? "" : device;
  const on = device === "desktop" ? " (all screens)" : ` (${device})`;
  const rule = (prop: string) => ({ kind: "css.rule", label: "Part of a section", value: { selector, media, declarations: { [prop]: "{value}" } } });
  const fonts: Record<string, string> = { inherit: "Same as the page" };
  if (font) fonts[font] = `${font.split(",")[0].replace(/["']/g, "").trim()} (as now)`;
  Object.assign(fonts, { 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif': "System sans-serif", 'Georgia, "Times New Roman", serif': "Serif", "ui-monospace, Consolas, monospace": "Monospace" });
  const a = (id: string, group: ResolvedAction["group"], label: string, input: ResolvedAction["input"], change: Record<string, any>, extra: Partial<ResolvedAction> = {}): ResolvedAction =>
    ({ id: `part:${id}`, group, label, input, value: null, change, ...extra });
  return [
    a("color", "style", `Text colour${on}`, "color", rule("color")),
    a("background", "style", `Background${on}`, "color", rule("background-color")),
    a("font-family", "style", `Font${on}`, "select", rule("font-family"), { options: fonts }),
    a("font-size", "style", `Font size${on}`, "size", rule("font-size"), { units: ["px", "rem", "em", "%"] }),
    a("font-weight", "style", `Font weight${on}`, "select", rule("font-weight"), { options: WEIGHTS }),
    a("text-align", "style", `Alignment${on}`, "select", rule("text-align"), { options: { left: "Left", center: "Center", right: "Right" } }),
    a("padding", "style", `Inner spacing${on}`, "spacing", rule("padding")),
    a("margin", "style", `Outer spacing${on}`, "spacing", rule("margin")),
    a("radius", "style", `Corner radius${on}`, "size", rule("border-radius"), { units: ["px", "%", "rem"] }),
    a("hide", "visibility", `Hide on ${device}`, "confirm", { kind: "css.rule", label: "Part of a section", value: { selector, media: device, declarations: { display: "none" } } }),
    a("animation", "motion", "Entrance animation", "select", rule("animation-name"), { options: { none: "None", "lc-fade-in": "Fade in", "lc-fade-up": "Fade up", "lc-zoom-in": "Zoom in", "lc-slide-in-left": "Slide in from left", "lc-slide-in-right": "Slide in from right" } }),
  ];
}

/** The input's starting text from the value the plugin reported. */
function initial(a: ResolvedAction): string {
  const v = a.value;
  if (v === null || v === undefined) return "";
  if (a.input === "size" && typeof v === "object") return v.size !== undefined && v.size !== "" ? `${v.size}${v.unit ?? "px"}` : "";
  if (a.input === "spacing" && typeof v === "object") return ["top", "right", "bottom", "left"].every((k) => v[k] === "" || v[k] === undefined) ? "" : `${v.top || 0}${v.unit ?? "px"} ${v.right || 0}${v.unit ?? "px"} ${v.bottom || 0}${v.unit ?? "px"} ${v.left || 0}${v.unit ?? "px"}`;
  if (typeof v === "object") return "";
  return String(v);
}

/**
 * The click panel: what the clicked element is (its real source) and only the options that source supports.
 * Every option makes one draft change directly in WordPress - no AI. Drafts are seen by editors only until deployed.
 */
export function ElementPanel({ selected, resolved, resolving, error, picking, disabled, canUpload, onPick, onCancelPick, onApplied, onAsk, onEditOnPage, onHighlight }: {
  selected: PickedElement | null; resolved: Resolved | null; resolving: boolean; error: string; picking: boolean; disabled: boolean;
  /** The plugin can save images from this computer into the Media Library (0.11+, and the account may upload). */
  canUpload: boolean;
  onPick: () => void; onCancelPick: () => void; onApplied: (summary: string) => void; onAsk: (prompt: string) => void;
  onEditOnPage: (selector: string, apply: (text: string) => Promise<void>) => void; onHighlight: (selector: string) => void;
}) {
  const [view, setView] = useState<Resolved | null>(resolved);
  // Several groups can be open at once: in the dialog they sit side by side, and changing a font while looking at
  // the colours is the point.
  const [open, setOpen] = useState<Set<string>>(() => new Set(["content", "style"]));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [scope, setScope] = useState<"page" | "site">("page");
  const [question, setQuestion] = useState("");
  useEffect(() => { setView(resolved); setProblem(""); setScope("page"); setStaged({}); setTarget("part"); }, [resolved]);
  // Inside a ready-made section: edit the part that was clicked (default) or the whole section.
  const [target, setTarget] = useState<"part" | "section">("part");

  /*
   * Field edits are staged, not applied one by one. Each Apply used to save, then refresh the page - so the colour,
   * size and spacing still being set in the other fields were thrown away, and only one thing could change per
   * round. Now every changed field waits here, and one Apply sends them all, followed by one refresh.
   */
  const [staged, setStaged] = useState<Record<string, unknown>>({});
  const [resetKey, setResetKey] = useState(0);
  const stage = useCallback((id: string, v: unknown) => setStaged((s) => {
    if (v === undefined) { if (!(id in s)) return s; const { [id]: _gone, ...rest } = s; return rest; }
    return s[id] === v ? s : { ...s, [id]: v };
  }), []);
  const discard = () => { setStaged({}); setResetKey((k) => k + 1); setProblem(""); };

  // The stored section this click landed in (Elementor / blocks keep a whole section as one HTML field), and the
  // clicked element inside it. A click on the section itself, or one that cannot be found in it, edits the whole.
  const htmlAction = (view?.actions ?? []).find((a) => a.input === "html" && isGallerySection(a.value));
  const part = useMemo(() => {
    if (!htmlAction || !selected) return null;
    const f = findPart(String(htmlAction.value), selected);
    return f.node && !f.isRoot ? { name: partName(f.node) } : null;
  }, [htmlAction, selected]);
  const pagePrefix = selected?.elementor ? `.elementor-${selected.elementor.post} `
    : view?.css_scopes && view.css_scopes.page.endsWith(view.css_scopes.site) ? view.css_scopes.page.slice(0, -view.css_scopes.site.length) : "";
  const editingPart = !!part && target === "part";

  // A ready-made section, or the widget it lives in: its colour and font must be written for its headings too.
  const sectionish = () => !!selected && (/(^|\s)lcs(\s|$)/.test(selected.classes ?? "") || (view?.actions ?? []).some((a) => a.input === "html" && isGallerySection(a.value)));
  // "This part" content is the whole stored section with one part edited, so it goes out as the section's change.
  const changeOf = (a: ResolvedAction) => (a.id === "part:content" && htmlAction ? htmlAction.change : a.change);
  async function apply(a: ResolvedAction, value?: unknown) {
    setBusy(a.id); setProblem("");
    try {
      let change = fill(changeOf(a), value);
      if (scope === "site" && view?.css_scopes && change.value?.selector === view.css_scopes.page) change = { ...change, value: { ...change.value, selector: view.css_scopes.site } };
      change = forSection(change, sectionish());
      if (a.requires) await wp("POST", "changes", a.requires);
      const r = await wp<any>("POST", "changes", change);
      if (r.unchanged) setProblem("It already is that way - nothing changed.");
      else onApplied(r.change?.summary ?? a.label);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(""); }
  }
  async function applyAll() {
    const list = shownActions().filter((a) => a.id in staged);
    if (!list.length) return;
    setBusy("all"); setProblem("");
    const done: string[] = [];
    try {
      for (const a of list) {
        let change = fill(changeOf(a), staged[a.id]);
        if (scope === "site" && view?.css_scopes && change.value?.selector === view.css_scopes.page) change = { ...change, value: { ...change.value, selector: view.css_scopes.site } };
        change = forSection(change, sectionish());
        if (a.requires) await wp("POST", "changes", a.requires);
        const r = await wp<any>("POST", "changes", change);
        if (!r.unchanged) done.push(r.change?.summary ?? a.label);
        stage(a.id, undefined); // saved: it is no longer pending, even if a later one fails
      }
      if (done.length) onApplied(done.length === 1 ? done[0] : `${done.length} changes to ${view?.source.label ?? "this element"}`);
      else setProblem("It already is that way - nothing changed.");
    } catch (e) {
      setProblem(`${done.length ? `${done.length} saved, then this one failed: ` : ""}${(e as Error).message}`);
      if (done.length) onApplied(`${done.length} changes`);
    } finally { setBusy(""); }
  }
  /** What the panel offers now: the clicked part's own options, or the resolver's (the whole widget / section). */
  function shownActions(): ResolvedAction[] {
    if (!selected) return [];
    // A picture has no words: a text colour or a font on it saves, refreshes, and changes nothing anyone can see.
    const wordless = !selected.text?.trim() && /^(img|figure|picture|svg|video|iframe)$/i.test(selected.tag);
    const base = editingPart && htmlAction
      ? [{ ...htmlAction, id: "part:content", label: "This part" }, ...partActions(`${pagePrefix}${selected.selector}`.trim(), view?.device ?? "desktop", selected.styles?.["font-family"] ?? "")]
      : (view?.actions ?? []);
    return base.filter((a) => !(wordless && /^(css|part):(color|font-family|font-size|font-weight|text-align)$/.test(a.id)));
  }
  async function parent() {
    if (!view?.parent || !selected) return;
    setBusy("parent");
    try {
      setView(await wp<Resolved>("POST", "resolve", { page: 0, device: view.device, elementor: view.parent.elementor ?? null, block: view.parent.block ?? "", selector: "" }));
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(""); }
  }

  if (!selected) {
    return (
      <div className="qa-empty">
        <div className="qa-orb"><Icon.Cursor size={24} /></div>
        <strong>Click anything on the page</strong>
        <p className="muted">You get the options that really work for it - text, links, images, colours, spacing, layout, animation. Every change is a draft only editors see until you deploy, and can be reverted.</p>
        {picking ? <button className="btn" onClick={onCancelPick}><Icon.Close size={15} /> Cancel picking</button>
          : <button className="btn accent" onClick={onPick} disabled={disabled}><Icon.Cursor size={15} /> Pick an element</button>}
      </div>
    );
  }

  const actions = shownActions();
  return (
    <div className="ep">
      <div className="qa-sel">
        <Icon.Cursor size={16} />
        <div className="qa-sel-main">
          <b>{view?.source.label ?? selected.label}</b>
          <small>{view ? `${SOURCE[view.source.kind] ?? view.source.kind}${view.source.where ? ` · ${view.source.where}` : ""}` : resolving ? "Finding where it is stored…" : selected.label}</small>
        </div>
        <button className="w-icon" title="Show it on the page" onClick={() => onHighlight(selected.selector)}><Icon.Eye size={15} /></button>
        <button className="w-icon" title="Pick another element" onClick={onPick} disabled={disabled}><Icon.Cursor size={15} /></button>
      </div>

      {view?.parent && <button className="ep-parent" onClick={() => void parent()} disabled={!!busy}><Icon.ChevronUp size={14} /> Select the {view.parent.label.toLowerCase()} around it</button>}
      {error && <div className="banner error">{error}</div>}
      {problem && <div className="banner error">{problem}</div>}
      {view?.notes.map((n) => <div key={n} className="qa-warn">{n}</div>)}
      {part && (
        <div className="qa-seg ep-scope" role="radiogroup" aria-label="What to edit">
          <button role="radio" aria-checked={target === "part"} className={target === "part" ? "on" : ""} disabled={!!busy}
            onClick={() => { if (target !== "part") { discard(); setTarget("part"); } }}>This {part.name.toLowerCase()}</button>
          <button role="radio" aria-checked={target === "section"} className={target === "section" ? "on" : ""} disabled={!!busy}
            onClick={() => { if (target !== "section") { discard(); setTarget("section"); } }}>Whole section</button>
        </div>
      )}
      {view?.css_scopes && !editingPart && (
        <div className="qa-seg ep-scope" role="radiogroup" aria-label="Where style changes apply">
          <button role="radio" aria-checked={scope === "page"} className={scope === "page" ? "on" : ""} onClick={() => setScope("page")}>This page</button>
          <button role="radio" aria-checked={scope === "site"} className={scope === "site" ? "on" : ""} onClick={() => setScope("site")}>Whole site</button>
        </div>
      )}
      {view && view.device !== "desktop" && <div className="qa-mode-hint">You are looking at the {view.device} size: style changes here apply to {view.device} only.</div>}

      {resolving && !view && <div className="qa-empty"><span className="spin" /></div>}
      {GROUPS.filter((g) => actions.some((a) => a.group === g.id && a.input !== "ask")).map((g) => (
        <section key={g.id} className="qa-sec">
          <button className="qa-sec-head" aria-expanded={open.has(g.id)} onClick={() => toggle(g.id)}>
            {g.icon}<span className="grow">{g.label}</span>
            {actions.some((a) => a.group === g.id && a.id in staged) && <i className="sf-dot" title="Has changes waiting to be applied" />}
            <Icon.ChevronDown size={15} className={open.has(g.id) ? "up" : ""} />
          </button>
          {/* Hidden, not unmounted: a collapsed group keeps the edits typed into it. */}
          <div className="ep-actions" hidden={!open.has(g.id)}>
            {actions.filter((a) => a.group === g.id && a.input !== "ask").map((a) => (
              a.id === "part:content" && selected
                ? <SectionPart key={`${a.id}:${resetKey}`} html={String(a.value)} picked={selected} disabled={disabled || !!busy} canUpload={canUpload}
                    onStage={(h) => stage(a.id, h)} onProblem={setProblem} />
                : a.input === "html" && isGallerySection(a.value)
                ? <SectionFields key={`${a.id}:${resetKey}`} html={a.value} focusText={selected.text} disabled={disabled || !!busy} onStage={(h) => stage(a.id, h)} />
                : <ActionRow key={`${a.id}:${resetKey}`} a={a} busy={busy === a.id} disabled={disabled || (!!busy && busy !== a.id)} onApply={(v) => apply(a, v)}
                    onStage={(v) => stage(a.id, v)} canUpload={canUpload} onProblem={setProblem}
                    onEditOnPage={a.input === "text" || a.input === "html" ? () => onEditOnPage(selected.selector, (text) => apply(a, text)) : undefined} />
            ))}
          </div>
        </section>
      ))}

      {Object.keys(staged).length > 0 && (() => {
        const n = Object.keys(staged).length;
        return (
          <div className="ep-commit" role="region" aria-label="Changes ready to apply">
            <span className="grow"><b>{n}</b> {n === 1 ? "change" : "changes"} ready</span>
            <button className="btn sm" disabled={!!busy} onClick={discard}>Discard</button>
            <button className="btn accent sm" disabled={!!busy || disabled} onClick={() => void applyAll()}>
              {busy === "all" ? <span className="spin" /> : n === 1 ? "Apply" : `Apply ${n} changes`}
            </button>
          </div>
        );
      })()}

      <section className="qa-sec ep-ask">
        <div className="qa-label">Ask the assistant about this element</div>
        <textarea rows={2} value={question} placeholder={actions.some((a) => a.input === "ask") ? "e.g. change this text, rebuild this section…" : "e.g. make this section look like the reference image…"}
          onChange={(e) => setQuestion(e.target.value)} />
        <button className="btn accent sm" disabled={disabled || !question.trim()} onClick={() => { onAsk(question.trim()); setQuestion(""); }}><Icon.Send size={14} /> Ask</button>
      </section>
    </div>
  );
}

function ActionRow({ a, busy, disabled, onApply, onStage, onEditOnPage, canUpload, onProblem }: {
  a: ResolvedAction; busy: boolean; disabled: boolean; onApply: (v?: unknown) => Promise<void>;
  /** A field's changed value (undefined = unchanged): it goes out with the panel's one Apply. */
  onStage: (v: unknown) => void;
  onEditOnPage?: () => void;
  canUpload: boolean; onProblem: (message: string) => void;
}) {
  const [v, setV] = useState(initial(a));
  const [num, setNum] = useState(() => (initial(a).match(/^-?[\d.]+/) ?? [""])[0]);
  const [unit, setUnit] = useState(() => (initial(a).match(/[a-z%]+$/i) ?? [a.units?.[0] ?? "px"])[0]);
  const go = (value?: unknown) => void onApply(value);
  // Fields hand their value up instead of applying it; buttons, switches and pictures still act at once.
  const init = initial(a);
  const candidate: unknown = a.input === "size" ? (num !== "" && `${num}${unit}` !== init ? `${num}${unit}` : undefined)
    : a.input === "select" ? (v !== init ? v : undefined)
    : ["html", "text", "url", "color", "spacing"].includes(a.input) ? (v.trim() !== "" && v !== init ? v : undefined)
    : undefined;
  const stageRef = useRef(onStage);
  stageRef.current = onStage;
  useEffect(() => { stageRef.current(candidate); }, [candidate]);
  const mark = candidate !== undefined ? <i className="sf-dot" title="Changed - goes out with Apply" /> : null;

  switch (a.input) {
    case "confirm":
      return <button className={`ep-btn ${/remove|hide/.test(a.id) ? "danger" : ""}`} disabled={disabled || busy} onClick={() => go()}>{busy ? <span className="spin" /> : null}{a.label}</button>;
    case "switch": {
      const on = !!a.value;
      const value = a.change.target === "_menu_item_target" ? (on ? "" : "_blank") : on ? "" : "yes";
      return <label className="ep-row ep-switch"><span className="grow">{a.label}</span><input type="checkbox" checked={on} disabled={disabled || busy} onChange={() => go(value)} /></label>;
    }
    case "image":
      return <ImageRow a={a} busy={busy} disabled={disabled} canUpload={canUpload} onPick={(id) => go(id)} onProblem={onProblem} />;
    case "html":
    case "text":
      return (
        <div className="ep-field">
          <span className="ep-label">{a.label}{mark}</span>
          {a.input === "html" || v.length > 60 ? <textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} /> : <input value={v} onChange={(e) => setV(e.target.value)} />}
          {onEditOnPage && <div className="qa-row"><button className="btn sm" disabled={disabled || busy} onClick={onEditOnPage}><Icon.Edit size={14} /> Edit on the page</button></div>}
        </div>
      );
    case "url":
      return <div className="ep-field"><span className="ep-label">{a.label}{mark}</span><input type="url" value={v} placeholder="https://…" onChange={(e) => setV(e.target.value)} /></div>;
    case "color": {
      const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000";
      return (
        <div className="ep-row">
          <span className="grow">{a.label}{mark}</span>
          <input type="color" value={hex} onChange={(e) => setV(e.target.value)} aria-label={a.label} />
          <input className="ep-short" value={v} placeholder="#1d4ed8" onChange={(e) => setV(e.target.value)} />
        </div>
      );
    }
    case "size":
      return (
        <div className="ep-row">
          <span className="grow">{a.label}{mark}</span>
          <input className="ep-num" type="number" value={num} onChange={(e) => setNum(e.target.value)} aria-label={a.label} />
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="unit">{(a.units?.length ? a.units : ["px", "rem", "em", "%"]).map((u) => <option key={u}>{u}</option>)}</select>
        </div>
      );
    case "spacing":
      return <div className="ep-row"><span className="grow">{a.label}{mark}</span><input className="ep-short" value={v} placeholder="20px or 10px 20px" onChange={(e) => setV(e.target.value)} /></div>;
    case "select":
      return (
        <div className="ep-row">
          <span className="grow">{a.label}{mark}</span>
          <select value={v} onChange={(e) => setV(e.target.value)}>
            {!Object.prototype.hasOwnProperty.call(a.options ?? {}, "") && <option value="">-</option>}
            {Object.entries(a.options ?? {}).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      );
  }
  return null;
}

/**
 * One image slot: the current picture, "Upload" (a file from this computer, saved into the Media Library first) and
 * "Library" (WordPress's own window: choose an existing image or upload there). Dropping a file on the row uploads it.
 */
function ImageRow({ a, busy, disabled, canUpload, onPick, onProblem }: {
  a: ResolvedAction; busy: boolean; disabled: boolean; canUpload: boolean; onPick: (attachmentId: number) => void; onProblem: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState("");
  const [drag, setDrag] = useState(false);
  const off = disabled || busy || !!uploading;

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { onProblem("That is not an image file."); return; }
    setUploading(file.name); onProblem("");
    try { const att = await uploadToMedia(file, file.name); onPick(att.id); }
    catch (e) { onProblem(`Upload failed: ${(e as Error).message}`); }
    finally { setUploading(""); }
  }

  return (
    <div className={`ep-img ${drag ? "drag" : ""}`}
      onDragOver={canUpload && !off ? (e) => { e.preventDefault(); setDrag(true); } : undefined} onDragLeave={() => setDrag(false)}
      onDrop={canUpload && !off ? (e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files[0]); } : undefined}>
      <div className="ep-img-head">
        {a.value?.url ? <img className="ep-thumb" src={a.value.url} alt="" /> : <span className="ep-thumb empty"><Icon.Image size={16} /></span>}
        <span className="grow">{a.label}{uploading && <small className="ep-img-note">Uploading {uploading}…</small>}</span>
      </div>
      <div className="qa-row">
        {canUpload && (
          <button className="btn accent sm" disabled={off} onClick={() => input.current?.click()} title="Upload an image from this computer (it is saved in the Media Library)">
            {uploading ? <span className="spin" /> : <><Icon.Upload size={14} /> Upload</>}
          </button>
        )}
        <button className={`btn sm ${canUpload ? "" : "accent"}`} disabled={off} onClick={async () => { const m = await pickMedia().catch((e) => { onProblem((e as Error).message); return null; }); if (m) onPick(m.id); }}
          title="Choose from the Media Library">
          {busy && !uploading ? <span className="spin" /> : <><Icon.Image size={14} /> Library</>}
        </button>
        {canUpload && <span className="ep-img-hint">or drop a file here</span>}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
