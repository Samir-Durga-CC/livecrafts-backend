import { useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import { api } from "../api";
import { Icon } from "../icons";
import type { DiffData } from "../types";

type Row = { kind: "add" | "del" | "ctx"; text: string; a?: number; b?: number } | { kind: "gap"; hidden: number; id: number };
const CONTEXT = 3;

/** Unified diff rows with line numbers; long unchanged stretches fold into "N unchanged lines". */
function buildRows(before: string, after: string, expanded: Set<number>): { rows: Row[]; added: number; removed: number } {
  const parts = diffLines(before, after);
  const flat: Exclude<Row, { kind: "gap" }>[] = [];
  let a = 1, b = 1, added = 0, removed = 0;
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.value === "") continue;
    for (const text of lines) {
      if (p.added) { flat.push({ kind: "add", text, b: b++ }); added++; }
      else if (p.removed) { flat.push({ kind: "del", text, a: a++ }); removed++; }
      else flat.push({ kind: "ctx", text, a: a++, b: b++ });
    }
  }
  // fold unchanged runs that are far from any change
  const near = flat.map((r, i) => r.kind !== "ctx" || flat.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== "ctx"));
  const rows: Row[] = [];
  let i = 0, gapId = 0;
  while (i < flat.length) {
    if (near[i]) { rows.push(flat[i]); i++; continue; }
    let j = i; while (j < flat.length && !near[j]) j++;
    const id = gapId++;
    if (expanded.has(id)) rows.push(...flat.slice(i, j));
    else rows.push({ kind: "gap", hidden: j - i, id });
    i = j;
  }
  return { rows, added, removed };
}

export function DiffView({ jobId, changeId, title, onClose }: { jobId: string; changeId: string; title: string; onClose: () => void }) {
  const [data, setData] = useState<DiffData | null>(null);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [split, setSplit] = useState(false);

  useEffect(() => { api.changeDiff(jobId, changeId).then(setData).catch((e) => setErr(e.message)); }, [jobId, changeId]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const view = useMemo(() => (data ? buildRows(data.before, data.after, expanded) : null), [data, expanded]);
  const isNew = data && data.before === "";

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="diff-modal" role="dialog" aria-label={`Changes in ${data?.label ?? title}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <Icon.Code size={16} />
          <div className="diff-titles">
            <div className="diff-file">{data?.label ?? "Loading…"}</div>
            <div className="diff-sub">{title}</div>
          </div>
          {view && <span className="diff-stat"><b className="plus">+{view.added}</b> <b className="minus">−{view.removed}</b></span>}
          {view && !isNew && <button className="rbtn" onClick={() => setSplit(!split)}>{split ? "Unified" : "Split"}</button>}
          <button className="ghost-icon" onClick={onClose} aria-label="Close"><Icon.Close size={18} /></button>
        </div>
        <div className="diff-body">
          {err && <div className="banner error">{err}</div>}
          {!data && !err && <div className="diff-loading"><span className="spin" /> Loading the change…</div>}
          {view && view.added + view.removed === 0 && <div className="diff-loading">No differences.</div>}
          {view && !split && (
            <table className="diff-table"><tbody>
              {view.rows.map((r, i) => r.kind === "gap" ? (
                <tr key={i} className="d-gap"><td colSpan={3}><button onClick={() => setExpanded(new Set([...expanded, r.id]))}><Icon.ChevronDown size={13} /> {r.hidden} unchanged line{r.hidden === 1 ? "" : "s"}</button></td></tr>
              ) : (
                <tr key={i} className={`d-${r.kind}`}>
                  <td className="d-num">{r.a ?? ""}</td><td className="d-num">{r.b ?? ""}</td>
                  <td className="d-code"><span className="d-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>{r.text || " "}</td>
                </tr>
              ))}
            </tbody></table>
          )}
          {view && split && <SplitView rows={view.rows} onExpand={(id) => setExpanded(new Set([...expanded, id]))} />}
        </div>
      </div>
    </div>
  );
}

/** Side-by-side: removed lines on the left, added on the right, paired in order. */
function SplitView({ rows, onExpand }: { rows: Row[]; onExpand: (id: number) => void }) {
  const out: { l?: Row; r?: Row; gap?: Extract<Row, { kind: "gap" }> }[] = [];
  let dels: Row[] = [], adds: Row[] = [];
  const flush = () => { const n = Math.max(dels.length, adds.length); for (let i = 0; i < n; i++) out.push({ l: dels[i], r: adds[i] }); dels = []; adds = []; };
  for (const r of rows) {
    if (r.kind === "del") dels.push(r);
    else if (r.kind === "add") adds.push(r);
    else { flush(); if (r.kind === "gap") out.push({ gap: r }); else out.push({ l: r, r }); }
  }
  flush();
  const cell = (r: Row | undefined, side: "a" | "b") => r && r.kind !== "gap"
    ? <><td className="d-num">{side === "a" ? r.a ?? "" : r.b ?? ""}</td><td className={`d-code d-${r.kind}`}>{r.text || " "}</td></>
    : <><td className="d-num" /><td className="d-code d-empty" /></>;
  return (
    <table className="diff-table split"><tbody>
      {out.map((p, i) => p.gap ? (
        <tr key={i} className="d-gap"><td colSpan={4}><button onClick={() => onExpand(p.gap!.id)}><Icon.ChevronDown size={13} /> {p.gap.hidden} unchanged lines</button></td></tr>
      ) : <tr key={i}>{cell(p.l, "a")}{cell(p.r, "b")}</tr>)}
    </tbody></table>
  );
}
