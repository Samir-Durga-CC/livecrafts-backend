import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A ready-made section's content as fields - heading, intro, each card's title and text, each button's words and
 * link - instead of its markup.
 *
 * On an Elementor (or blocks) page a gallery section is stored as ONE piece of HTML: the section inside a text
 * editor widget. Picking anything in it resolved to that widget, whose only content field was the whole section's
 * code. Here that code is read, the texts in it become fields, and editing one changes only its own words; the
 * markup, classes and order around it are written back exactly as they were.
 *
 * Nothing is applied from here: every edit is handed up as the section's new HTML (onStage), so it goes out with the
 * other pending changes in one Apply.
 */

/** True when this HTML is a Livecrafts gallery section, which is what this editor understands. */
export const isGallerySection = (html: unknown) => typeof html === "string" && /<section[^>]*\bclass="[^"]*\blcs\b/.test(html);

interface Field { key: string; group: string; label: string; kind: "text" | "link"; node: Element; initial: string }

const LABELS: Array<[RegExp, string]> = [
  [/\blcs-eyebrow\b/, "Label above the heading"],
  [/\blcs-h\b|\blcs-h2\b/, "Heading"],
  [/\blcs-h3\b/, "Title"],
  [/\blcs-lead\b/, "Intro"],
  [/\blcs-ico\b/, "Icon or number"],
  [/\blcs-proof\b/, "Small print"],
  [/\blcs-btn\b/, "Button"],
];
const labelOf = (el: Element) => {
  const cls = el.getAttribute("class") ?? "";
  for (const [re, label] of LABELS) if (re.test(cls)) return label;
  if (/^H[1-6]$/.test(el.tagName)) return "Heading";
  if (el.tagName === "A") return "Link";
  return "Text";
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** An element that holds words and nothing structural: no child elements, or only inline ones. */
const isLeaf = (el: Element) => Array.from(el.children).every((c) => /^(B|STRONG|EM|I|SPAN|BR|SMALL|SUP|SUB)$/.test(c.tagName));

function readFields(root: Element): Field[] {
  const out: Field[] = [];
  const items = Array.from(root.querySelectorAll("li"));
  Array.from(root.querySelectorAll("*")).forEach((el, i) => {
    if (/^(SCRIPT|STYLE|SVG|PATH|IMG)$/i.test(el.tagName) || el.closest("svg")) return;
    const li = el.closest("li");
    const group = li ? `Item ${items.indexOf(li) + 1}` : "Section";
    if (el.tagName === "A") {
      if (isLeaf(el) && el.textContent?.trim()) out.push({ key: `t${i}`, group, label: labelOf(el), kind: "text", node: el, initial: el.textContent.trim() });
      out.push({ key: `h${i}`, group, label: `${labelOf(el)} link`, kind: "link", node: el, initial: el.getAttribute("href") ?? "" });
      return;
    }
    if (el.closest("a")) return; // a link's words are its own field, above
    if (!isLeaf(el) || !el.textContent?.trim()) return;
    out.push({ key: `t${i}`, group, label: labelOf(el), kind: "text", node: el, initial: el.textContent.trim() });
  });
  return out;
}

export function SectionFields({ html, focusText, disabled, onStage }: {
  html: string;
  /** The words of the element the person clicked, so its field is the one that opens ready. */
  focusText?: string;
  disabled: boolean;
  onStage: (html: string | undefined) => void;
}) {
  const parsed = useMemo(() => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    return { root: doc.body, fields: readFields(doc.body) };
  }, [html]);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [html]);
  const focusKey = useMemo(() => {
    const want = norm(focusText ?? "");
    return want ? parsed.fields.find((f) => f.kind === "text" && norm(f.initial) === want)?.key : undefined;
  }, [parsed, focusText]);
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => { first.current?.focus(); first.current?.scrollIntoView({ block: "nearest" }); }, [focusKey]);

  // Every change is written into the parsed copy and handed up as the whole section; equal to the original = nothing.
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;
  useEffect(() => {
    let changed = false;
    for (const f of parsed.fields) {
      const v = values[f.key];
      const now = v ?? f.initial;
      if (v !== undefined && v !== f.initial) changed = true;
      if (f.kind === "link") f.node.setAttribute("href", now);
      else if (v !== undefined) f.node.textContent = now;
    }
    onStageRef.current(changed ? parsed.root.innerHTML : undefined);
  }, [values, parsed]);

  const groups = [...new Set(parsed.fields.map((f) => f.group))];
  if (!parsed.fields.length) return <p className="muted small">This section has no text to edit here. Ask the assistant to change it.</p>;
  return (
    <div className="sf">
      {groups.map((g) => (
        <fieldset key={g} className="sf-group">
          {groups.length > 1 && <legend>{g}</legend>}
          {parsed.fields.filter((f) => f.group === g).map((f) => {
            const v = values[f.key] ?? f.initial;
            const dirty = values[f.key] !== undefined && values[f.key] !== f.initial;
            const set = (x: string) => setValues((s) => ({ ...s, [f.key]: x }));
            const ref = f.key === focusKey ? (el: HTMLInputElement | HTMLTextAreaElement | null) => { first.current = el; } : undefined;
            return (
              <label key={f.key} className={`sf-field${dirty ? " dirty" : ""}${f.key === focusKey ? " picked" : ""}`}>
                <span className="ep-label">{f.label}{dirty && <i className="sf-dot" title="Changed - goes out with Apply" />}</span>
                {f.kind === "link"
                  ? <input ref={ref} type="url" value={v} disabled={disabled} placeholder="https://… or /page" onChange={(e) => set(e.target.value)} />
                  : v.length > 70
                    ? <textarea ref={ref} rows={3} value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />
                    : <input ref={ref} value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />}
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
