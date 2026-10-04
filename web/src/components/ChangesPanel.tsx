import { useState, type ReactElement } from "react";
import { Icon } from "../icons";
import type { Context } from "./Composer";
import { Preview } from "./Preview";
import type { Change, ChangeState } from "../util";

const STATE_TEXT: Record<ChangeState, string> = { pending: "Waiting for approval", denied: "Denied", applied: "Applied & checked", failed: "Failed", reverted: "Reverted" };
export type PanelTab = "preview" | "changes";

const ICONS: Record<Change["icon"], (p: { size?: number }) => ReactElement> = {
  image: Icon.Image, link: Icon.Link, undo: Icon.Retry, code: Icon.Code, text: Icon.Text, page: Icon.Page, menu: Icon.Menu,
};

export function ChangesPanel({ tab, onTab, changes, context, siteUrl, reloadKey, navigate, busy, onRevert, onOpen, onClose }: {
  tab: PanelTab; onTab: (t: PanelTab) => void; changes: Change[]; context: Context; siteUrl?: string; reloadKey: number;
  navigate?: { url: string; n: number }; busy: boolean;
  onRevert: (changeId: string, title: string) => Promise<void>; onOpen: (url: string) => void; onClose: () => void;
}) {
  const [reverting, setReverting] = useState("");
  const active = changes.filter((c) => c.state === "applied" && c.record?.revert && !c.record.revertedAt).length;

  async function revert(c: Change) {
    if (!c.record) return;
    setReverting(c.record.id);
    try { await onRevert(c.record.id, c.title); } finally { setReverting(""); }
  }

  return (
    <aside className={`rpanel ${tab === "preview" ? "is-preview" : ""}`}>
      <div className="rpanel-head">
        <div className="rtabs" role="tablist">
          <button role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "on" : ""} onClick={() => onTab("preview")}><Icon.Eye size={15} /> Preview</button>
          <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => onTab("changes")}><Icon.List size={15} /> Changes {changes.length > 0 && <span className="count">{changes.length}</span>}</button>
        </div>
        <button className="ghost-icon" onClick={onClose} aria-label="Close"><Icon.Close size={18} /></button>
      </div>

      {tab === "preview" ? <Preview siteUrl={siteUrl} pageUrl={context.pageUrl} reloadKey={reloadKey} navigate={navigate} /> : (
        <>
          {(context.pageUrl || context.selectedTarget) && (
            <div className="ctx-card">
              <div className="ctx-title">Context from the page</div>
              {context.pageUrl && <div className="ctx-line"><Icon.Globe size={14} /> {context.pageUrl.replace(/^https?:\/\//, "")}</div>}
              {context.selectedTarget && <div className="ctx-line"><Icon.Pin size={14} /> <code>{context.selectedTarget}</code></div>}
            </div>
          )}

          {changes.length === 0 ? (
            <div className="rempty">
              <div className="r-big"><Icon.List size={22} /></div>
              <strong>No changes yet</strong>
              <p>Every edit you ask for shows up here with its status, and each one can be reverted with one click{siteUrl ? ` on ${siteUrl.replace(/^https?:\/\//, "")}` : ""}.</p>
            </div>
          ) : (
            <>
              {active > 0 && <p className="rhint">Revert undoes one change. If two changes touched the same thing, revert the newest first.</p>}
              <div className="rlist">
                {changes.map((c, n) => {
                  const I = ICONS[c.icon];
                  const rec = c.record;
                  const canRevert = c.state === "applied" && !!rec?.revert && !rec.revertedAt;
                  return (
                    <div key={c.key} className={`rcard ${c.state}`}>
                      <div className="rcard-top">
                        <span className="rnum">{n + 1}</span>
                        <span className="rico"><I size={16} /></span>
                        <span className="rtarget" title={c.target}>{c.target}</span>
                      </div>
                      <div className="rtitle">{c.title}</div>
                      {c.from !== undefined && (
                        <div className={`rsnippet ${c.icon === "code" || c.icon === "page" ? "mono" : ""}`}><s>{c.from}</s><Icon.ChevronRight size={12} /><b>{c.to}</b></div>
                      )}
                      {c.from === undefined && c.to && <div className="rsnippet"><b>{c.to}</b></div>}
                      <div className="rfoot">
                        <span className={`rstate ${c.state}`}>{STATE_TEXT[c.state]}</span>
                        <span className="grow" />
                        {rec?.link && c.state !== "reverted" && <button className="rbtn" onClick={() => onOpen(rec.link!)} title="Show it in the preview"><Icon.Eye size={13} /> View</button>}
                        {canRevert && (
                          <button className="rbtn danger" disabled={busy || !!reverting} onClick={() => void revert(c)}>
                            {reverting === rec!.id ? <><span className="spin" /> Reverting…</> : <><Icon.Retry size={13} /> Revert</>}
                          </button>
                        )}
                      </div>
                      {c.detail && <div className="rdetail">{c.detail}</div>}
                      {rec?.revertError && !rec.revertedAt && <div className="rdetail">Revert failed: {rec.revertError}</div>}
                      {rec?.note && c.state === "applied" && !rec.revert && <div className="rnote">{rec.note}</div>}
                      {rec?.revertedAt && <div className="rnote">Reverted {new Date(rec.revertedAt).toLocaleTimeString()}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
