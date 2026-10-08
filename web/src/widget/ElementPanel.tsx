import { useEffect, useRef, useState, type ReactElement } from "react";
import { Icon } from "../icons";
import type { Resolved, ResolvedAction } from "../types";
import type { PickedElement } from "./element";
import { pickMedia, uploadToMedia, wp } from "./parent";

const GROUPS: { id: ResolvedAction["group"]; label: string; icon: ReactElement }[] = [
  { id: "content", label: "Content", icon: <Icon.Text size={15} /> },
  { id: "style", label: "Style", icon: <Icon.Palette size={15} /> },
  { id: "layout", label: "Layout", icon: <Icon.Layout size={15} /> },
  { id: "visibility", label: "Visibility", icon: <Icon.Hide size={15} /> },
  { id: "motion", label: "Animation", icon: <Icon.Sparkle size={15} /> },
];
const SOURCE: Record<string, string> = {
  elementor: "Elementor", block: "Block editor", acf: "ACF field", menu: "Menu", theme: "Theme / plugin", ambiguous: "Not sure",
};

/** Put what the person entered into a change: in its "{value}" placeholders, or as its value. */
function fill(change: Record<string, any>, value: unknown): Record<string, any> {
  const json = JSON.stringify(change);
  if (json.includes('"{value}"')) return JSON.parse(json.replace(/"\{value\}"/g, JSON.stringify(value)));
  return value === undefined ? { ...change } : { ...change, value };
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
  const [open, setOpen] = useState<string>("content");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [scope, setScope] = useState<"page" | "site">("page");
  const [question, setQuestion] = useState("");
  useEffect(() => { setView(resolved); setProblem(""); setScope("page"); }, [resolved]);

  async function apply(a: ResolvedAction, value?: unknown) {
    setBusy(a.id); setProblem("");
    try {
      let change = fill(a.change, value);
      if (scope === "site" && view?.css_scopes && change.value?.selector === view.css_scopes.page) change = { ...change, value: { ...change.value, selector: view.css_scopes.site } };
      if (a.requires) await wp("POST", "changes", a.requires);
      const r = await wp<any>("POST", "changes", change);
      if (r.unchanged) setProblem("It already is that way - nothing changed.");
      else onApplied(r.change?.summary ?? a.label);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(""); }
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

  const actions = view?.actions ?? [];
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
      {view?.css_scopes && (
        <div className="qa-seg ep-scope" role="radiogroup" aria-label="Where style changes apply">
          <button role="radio" aria-checked={scope === "page"} className={scope === "page" ? "on" : ""} onClick={() => setScope("page")}>This page</button>
          <button role="radio" aria-checked={scope === "site"} className={scope === "site" ? "on" : ""} onClick={() => setScope("site")}>Whole site</button>
        </div>
      )}
      {view && view.device !== "desktop" && <div className="qa-mode-hint">You are looking at the {view.device} size: style changes here apply to {view.device} only.</div>}

      {resolving && !view && <div className="qa-empty"><span className="spin" /></div>}
      {GROUPS.filter((g) => actions.some((a) => a.group === g.id && a.input !== "ask")).map((g) => (
        <section key={g.id} className="qa-sec">
          <button className="qa-sec-head" aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? "" : g.id)}>
            {g.icon}<span className="grow">{g.label}</span><Icon.ChevronDown size={15} className={open === g.id ? "up" : ""} />
          </button>
          {open === g.id && (
            <div className="ep-actions">
              {actions.filter((a) => a.group === g.id && a.input !== "ask").map((a) => (
                <ActionRow key={a.id} a={a} busy={busy === a.id} disabled={disabled || (!!busy && busy !== a.id)} onApply={(v) => apply(a, v)}
                  canUpload={canUpload} onProblem={setProblem}
                  onEditOnPage={a.input === "text" || a.input === "html" ? () => onEditOnPage(selected.selector, (text) => apply(a, text)) : undefined} />
              ))}
            </div>
          )}
        </section>
      ))}

      <section className="qa-sec ep-ask">
        <div className="qa-label">Ask the assistant about this element</div>
        <textarea rows={2} value={question} placeholder={actions.some((a) => a.input === "ask") ? "e.g. change this text, rebuild this section…" : "e.g. make this section look like the reference image…"}
          onChange={(e) => setQuestion(e.target.value)} />
        <button className="btn accent sm" disabled={disabled || !question.trim()} onClick={() => { onAsk(question.trim()); setQuestion(""); }}><Icon.Send size={14} /> Ask</button>
      </section>
    </div>
  );
}

function ActionRow({ a, busy, disabled, onApply, onEditOnPage, canUpload, onProblem }: {
  a: ResolvedAction; busy: boolean; disabled: boolean; onApply: (v?: unknown) => Promise<void>; onEditOnPage?: () => void;
  canUpload: boolean; onProblem: (message: string) => void;
}) {
  const [v, setV] = useState(initial(a));
  const [num, setNum] = useState(() => (initial(a).match(/^-?[\d.]+/) ?? [""])[0]);
  const [unit, setUnit] = useState(() => (initial(a).match(/[a-z%]+$/i) ?? [a.units?.[0] ?? "px"])[0]);
  const go = (value?: unknown) => void onApply(value);
  const applyBtn = (value: unknown, ok = true) => <button className="btn accent sm" disabled={disabled || busy || !ok} onClick={() => go(value)}>{busy ? <span className="spin" /> : "Apply"}</button>;

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
          <span className="ep-label">{a.label}</span>
          {a.input === "html" || v.length > 60 ? <textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} /> : <input value={v} onChange={(e) => setV(e.target.value)} />}
          <div className="qa-row">{onEditOnPage && <button className="btn sm" disabled={disabled || busy} onClick={onEditOnPage}><Icon.Edit size={14} /> Edit on the page</button>}<span className="grow" />{applyBtn(v, v.trim() !== "" && v !== initial(a))}</div>
        </div>
      );
    case "url":
      return <div className="ep-field"><span className="ep-label">{a.label}</span><div className="qa-row"><input className="grow" type="url" value={v} placeholder="https://…" onChange={(e) => setV(e.target.value)} />{applyBtn(v, v.trim() !== "" && v !== initial(a))}</div></div>;
    case "color": {
      const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000";
      return (
        <div className="ep-row">
          <span className="grow">{a.label}</span>
          <input type="color" value={hex} onChange={(e) => setV(e.target.value)} aria-label={a.label} />
          <input className="ep-short" value={v} placeholder="#1d4ed8" onChange={(e) => setV(e.target.value)} />
          {applyBtn(v, v.trim() !== "" && v !== initial(a))}
        </div>
      );
    }
    case "size":
      return (
        <div className="ep-row">
          <span className="grow">{a.label}</span>
          <input className="ep-num" type="number" value={num} onChange={(e) => setNum(e.target.value)} aria-label={a.label} />
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="unit">{(a.units?.length ? a.units : ["px", "rem", "em", "%"]).map((u) => <option key={u}>{u}</option>)}</select>
          {applyBtn(`${num}${unit}`, num !== "")}
        </div>
      );
    case "spacing":
      return <div className="ep-row"><span className="grow">{a.label}</span><input className="ep-short" value={v} placeholder="20px or 10px 20px" onChange={(e) => setV(e.target.value)} />{applyBtn(v, v.trim() !== "" && v !== initial(a))}</div>;
    case "select":
      return (
        <div className="ep-row">
          <span className="grow">{a.label}</span>
          <select value={v} onChange={(e) => setV(e.target.value)}>
            {!Object.prototype.hasOwnProperty.call(a.options ?? {}, "") && <option value="">-</option>}
            {Object.entries(a.options ?? {}).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {applyBtn(v, v !== initial(a))}
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
