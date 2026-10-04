import { useState } from "react";
import { Icon } from "../icons";
import type { ApprovalMode, ChangeRecord } from "../types";
import { chipLabel, type RequestGroup, type RequestState } from "../util";
import { DiffView } from "./DiffView";

const STATE: Record<RequestState, string> = {
  pending: "Waiting for approval", working: "Working…", applied: "Applied & checked", partial: "Partly reverted",
  reverted: "Reverted", denied: "Not approved", failed: "Failed",
};

const chipIcon = (c: ChangeRecord) => {
  if (c.key?.startsWith("file:")) return <Icon.Code size={12} />;
  if (c.key?.startsWith("post:")) return <Icon.Page size={12} />;
  if (c.key?.startsWith("menu")) return <Icon.Menu size={12} />;
  if (c.key?.startsWith("media:")) return <Icon.Image size={12} />;
  return <Icon.Text size={12} />;
};

/**
 * The Changes list: ONE card per request ("make the title blue", "add a blog page"), whatever number of files it
 * touched. Each touched file/field is a small chip - click it to see the exact diff, like on GitHub.
 * "Revert" undoes the whole request.
 */
export function RequestChanges({ jobId, groups, busy, onRevert, onOpen, emptyText }: {
  jobId: string; groups: RequestGroup[]; busy: boolean;
  onRevert: (g: RequestGroup) => Promise<void>; onOpen?: (url: string) => void; emptyText?: string;
}) {
  const [diff, setDiff] = useState<ChangeRecord | null>(null);
  const [reverting, setReverting] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  if (!groups.length) {
    return (
      <div className="rempty">
        <div className="r-big"><Icon.List size={22} /></div>
        <strong>No changes yet</strong>
        <p>{emptyText ?? "Each request you make shows up here as one item. Click a file to see exactly what changed, or revert the whole request with one click."}</p>
      </div>
    );
  }

  return (
    <div className="rlist">
      {[...groups].reverse().map((g) => {
        const active = g.changes.filter((c) => !c.revertedAt && c.revert);
        const link = g.changes.find((c) => c.link && !c.revertedAt)?.link;
        return (
          <div key={g.requestId} className={`rgroup ${g.state}`}>
            <div className="rg-top">
              <span className={`rstate ${g.state}`}>{g.state === "working" && <span className="spin" />}{STATE[g.state]}</span>
              <span className="grow" />
              {g.at && <span className="rg-time">{new Date(g.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
            </div>
            <div className="rg-title" title={g.text}>{g.text}</div>
            {g.changes.length > 0 && (
              <div className="rg-chips">
                {g.changes.map((c) => (
                  <button key={c.id} className={`dchip ${c.revertedAt ? "off" : ""}`} title={`${c.title}${c.diff ? " - click to see the changes" : ""}`}
                    disabled={!c.diff} onClick={() => setDiff(c)}>
                    {chipIcon(c)}<span>{chipLabel(c)}</span>{c.diff && <Icon.Code size={11} />}
                  </button>
                ))}
              </div>
            )}
            {g.failures.map((f, i) => <div key={i} className="rdetail">{f.title}: {f.error}</div>)}
            {g.changes.some((c) => c.revertError && !c.revertedAt) && <div className="rdetail">Revert failed: {g.changes.find((c) => c.revertError)?.revertError}</div>}
            {g.changes.some((c) => c.note && !c.revert) && <div className="rnote">{g.changes.find((c) => c.note && !c.revert)?.note}</div>}
            {(active.length > 0 || link) && (
              <div className="rfoot">
                <span className="rnote">{g.changes.length} change{g.changes.length === 1 ? "" : "s"}</span>
                <span className="grow" />
                {link && onOpen && <button className="rbtn" onClick={() => onOpen(link)}><Icon.Eye size={13} /> View</button>}
                {active.length > 0 && confirming !== g.requestId && (
                  <button className="rbtn danger" disabled={busy || reverting !== null} onClick={() => setConfirming(g.requestId)}>
                    {reverting === g.requestId ? <><span className="spin" /> Reverting…</> : <><Icon.Retry size={13} /> Revert</>}
                  </button>
                )}
              </div>
            )}
            {confirming === g.requestId && (
              <div className="rconfirm" role="alertdialog" aria-label="Confirm revert">
                <span>Undo {active.length === 1 ? "this change" : `all ${active.length} changes`} on the live site?</span>
                <button className="rbtn" onClick={() => setConfirming(null)}>Cancel</button>
                <button className="rbtn danger solid" autoFocus
                  onClick={async () => { setConfirming(null); setReverting(g.requestId); try { await onRevert(g); } finally { setReverting(null); } }}>
                  <Icon.Retry size={13} /> Yes, revert
                </button>
              </div>
            )}
          </div>
        );
      })}
      {diff && <DiffView jobId={jobId} changeId={diff.id} title={diff.title} onClose={() => setDiff(null)} />}
    </div>
  );
}

const MODES: { id: ApprovalMode; label: string; hint: string }[] = [
  { id: "request", label: "Once per request", hint: "Shows its plan, one click runs all steps" },
  { id: "every", label: "Every change", hint: "Approve each single change" },
  { id: "auto", label: "Auto", hint: "No questions - every change is still checked and can be reverted" },
];

/** Small dropdown in the composer: how the assistant asks before changing the site. */
export function ApprovalModePicker({ mode, onChange, up = true }: { mode: ApprovalMode; onChange: (m: ApprovalMode) => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const cur = MODES.find((m) => m.id === mode) ?? MODES[0];
  return (
    <div className="mode-pick">
      <button className={`model-pill mode-${mode}`} onClick={() => setOpen(!open)} title="How changes get approved" aria-expanded={open}>
        <Icon.Shield size={13} /> {cur.label} <Icon.ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="mode-scrim" onMouseDown={() => setOpen(false)} />
          <div className={`menu ${up ? "up" : "down"} mode-menu`}>
            <div className="menu-label">Approval</div>
            {MODES.map((m) => (
              <button key={m.id} className="menu-item mode-item" onClick={() => { onChange(m.id); setOpen(false); }}>
                <span className="grow"><b>{m.label}</b><small>{m.hint}</small></span>{m.id === mode && <Icon.Check size={15} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
