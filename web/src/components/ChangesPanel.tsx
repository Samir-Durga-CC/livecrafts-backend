import { Icon } from "../icons";
import type { Context } from "./Composer";
import { Preview } from "./Preview";
import { RequestChanges } from "./RequestChanges";
import type { RequestGroup } from "../util";

export type PanelTab = "preview" | "changes";

export function ChangesPanel({ tab, onTab, jobId, groups, context, siteUrl, reloadKey, navigate, busy, onRevert, onOpen, onClose }: {
  tab: PanelTab; onTab: (t: PanelTab) => void; jobId: string; groups: RequestGroup[]; context: Context; siteUrl?: string; reloadKey: number;
  navigate?: { url: string; n: number }; busy: boolean;
  onRevert: (g: RequestGroup) => Promise<void>; onOpen: (url: string) => void; onClose: () => void;
}) {
  const count = groups.filter((g) => g.changes.length).length;
  return (
    <aside className={`rpanel ${tab === "preview" ? "is-preview" : ""}`}>
      <div className="rpanel-head">
        <div className="rtabs" role="tablist">
          <button role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "on" : ""} onClick={() => onTab("preview")}><Icon.Eye size={15} /> Preview</button>
          <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => onTab("changes")}><Icon.List size={15} /> Changes {count > 0 && <span className="count">{count}</span>}</button>
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
          <RequestChanges jobId={jobId} groups={groups} busy={busy} onRevert={onRevert} onOpen={onOpen} />
        </>
      )}
    </aside>
  );
}
