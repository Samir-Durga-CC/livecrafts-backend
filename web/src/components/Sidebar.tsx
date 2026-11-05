import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import type { AccountInfo, JobSummary, Project, Site } from "../types";
import { prefs, titleOf } from "../util";

export interface SidebarProps {
  sites: Site[]; site?: Site; jobs: JobSummary[]; jobId: string; titles: Record<string, string>; pinned: string[]; model: string;
  hostingerOk?: boolean;
  onSelectSite: (id: string) => void; onAddSite: () => void; onManageSites: () => void; onToken: () => void; onIntegrations: () => void;
  onSelectJob: (id: string) => void; onNewChat: () => void; onTogglePin: (id: string) => void; onHide: () => void;
  /** Who is signed in (null = not known yet / an open local backend). */
  me?: { root: boolean; account: AccountInfo | null } | null;
  onInstructions: () => void; onPassword: () => void; onSignOut: () => void;
  /** The projects in the tree, the open one, and what can be done with them. */
  projects: Project[]; projectId: string;
  onSelectProject: (id: string) => void; onNewSession: (projectId: string) => void; onNewProject: () => void; onProjectSettings: (id: string) => void;
}

/** One session in the tree. */
function Session({ j, jobId, titles, pinned, onSelectJob, onTogglePin }: SidebarProps & { j: JobSummary }) {
  return (
    <div className={`hist ${j.id === jobId ? "on" : ""}`}>
      <button className="hist-main" onClick={() => onSelectJob(j.id)} title={titleOf(j, titles)}>
        <span className={`dot ${j.status}`} />
        <span className="hist-text">{titleOf(j, titles)}</span>
      </button>
      <button className={`pin-btn ${pinned.includes(j.id) ? "on" : ""}`} title={pinned.includes(j.id) ? "Unpin" : "Pin"} onClick={() => onTogglePin(j.id)}><Icon.Pin size={14} /></button>
    </div>
  );
}

export function Sidebar(p: SidebarProps) {
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(prefs.collapsed());
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const matches = (j: JobSummary) => titleOf(j, p.titles).toLowerCase().includes(q.toLowerCase());
  // Sessions under their project, newest first; pinned ones also sit on top, across projects.
  const byProject = useMemo(() => {
    const m = new Map<string, JobSummary[]>();
    for (const j of [...p.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) m.set(j.projectId, [...(m.get(j.projectId) ?? []), j]);
    return m;
  }, [p.jobs]);
  const pinnedJobs = p.jobs.filter((j) => p.pinned.includes(j.id) && (!q || matches(j)));
  const acc = p.me?.account ?? null;
  // A client sees the chat on their own sites, nothing that holds keys or other people's work.
  const client = acc?.role === "client";
  const initial = (acc?.name || p.site?.username || "L").slice(0, 1).toUpperCase();

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="brand"><span className="logo"><Icon.Sparkle size={16} /></span> Livecrafts</div>
        <div className="sb-icons">
          <button className="ghost-icon" title="Search sessions" onClick={() => { setSearching(!searching); setQ(""); }}><Icon.Search size={17} /></button>
          <button className="ghost-icon" title="Hide sidebar" onClick={p.onHide}><Icon.Sidebar size={17} /></button>
        </div>
      </div>

      {searching && <input className="sb-search" autoFocus placeholder="Search sessions…" value={q} onChange={(e) => setQ(e.target.value)} />}

      <button className="newchat" disabled={!p.projectId} onClick={p.onNewChat} title={p.projects.find((x) => x.id === p.projectId)?.name}><Icon.Plus size={16} /> New session</button>

      <nav className="nav">
        <button className="nav-item on"><Icon.Chat size={17} /> Chat</button>
        {!client && <button className="nav-item" onClick={p.onManageSites}><Icon.Globe size={17} /> Sites <span className="count">{p.sites.length}</span></button>}
        {!client && <button className="nav-item" onClick={p.onIntegrations}><Icon.Plug size={17} /> Integrations <span className={`conn-dot ${p.hostingerOk ? "ok" : ""}`} title={p.hostingerOk ? "Hostinger connected" : "Hostinger not connected"} /></button>}
        {!client && <a className="nav-item" href="/admin"><Icon.Gauge size={17} /> Admin panel</a>}
        {!client && <>
        <div className="nav-label">Library</div>
        <a className="nav-item" href={`/templates${p.site ? `?site=${p.site.id}` : ""}`}><Icon.List size={17} /> Templates</a>
        <a className="nav-item" href="/section-usage"><Icon.Layout size={17} /> Section usage</a>
        <a className="nav-item" href={`/model-usage${p.site ? `?site=${p.site.id}` : ""}`}><Icon.Gauge size={17} /> Model usage</a>
        </>}
      </nav>
      <div className="divider" />

      <div className="history">
        <div className="pj-head">
          <span>Projects</span>
          <span className="grow" />
          {!client && <button className="ghost-icon sm" title="New project" onClick={p.onNewProject}><Icon.Plus size={15} /></button>}
        </div>
        {pinnedJobs.length > 0 && (
          <div className="group">
            <div className="group-head static"><Icon.Pin size={12} /><span>Pinned</span></div>
            {pinnedJobs.map((j) => <Session key={j.id} j={j} {...p} />)}
          </div>
        )}
        {p.projects.length === 0 && <div className="empty-hist">{client ? "No project yet. Ask your team to give you a site." : "Connect a site to make your first project."}</div>}
        {p.projects.map((pr) => {
          const all = byProject.get(pr.id) ?? [];
          const shown = q ? all.filter(matches) : all;
          if (q && !shown.length) return null;
          const key = "prj:" + pr.id;
          const isOpen = q ? true : collapsed[key] === undefined ? pr.id === p.projectId : !collapsed[key];
          const more = !showAll[pr.id] && shown.length > 8;
          const site = p.sites.find((s) => s.id === pr.siteId);
          return (
            <div key={pr.id} className={`pj${pr.id === p.projectId ? " on" : ""}`}>
              <div className="pj-row">
                <button className="pj-main" onClick={() => { setCollapsed(prefs.setCollapsed(key, isOpen)); p.onSelectProject(pr.id); }} title={pr.description || pr.name}>
                  {isOpen ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
                  <span className="pj-name">{pr.name}</span>
                  {pr.running > 0 && <span className="dot running" title={`${pr.running} running`} />}
                  {p.sites.length > 1 && !pr.isDefault && site && <small className="pj-site">{site.name}</small>}
                </button>
                <button className="ghost-icon sm" title={`New session in ${pr.name}`} onClick={() => p.onNewSession(pr.id)}><Icon.Plus size={14} /></button>
                {!client && <button className="ghost-icon sm" title="Project settings" onClick={() => p.onProjectSettings(pr.id)}><Icon.Settings size={14} /></button>}
              </div>
              {isOpen && (
                <div className="pj-sessions">
                  {shown.length === 0 && <div className="empty-hist">No sessions yet.</div>}
                  {(more ? shown.slice(0, 8) : shown).map((j) => <Session key={j.id} j={j} {...p} />)}
                  {more && <button className="pj-more" onClick={() => setShowAll({ ...showAll, [pr.id]: true })}>Show {shown.length - 8} more</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="safe-row" title="Safe mode: every change waits for your approval and is checked on the live page afterwards.">
        <span className="safe-ico"><Icon.Shield size={14} /></span>
        <strong>Safe mode on</strong>
        <span className="grow" />
        {p.site && !client && <button className="safe-link" onClick={p.onIntegrations} title={p.site.hosting ? "Theme files are linked (Hostinger)" : "Connect Hostinger so the assistant can edit theme files"}>{p.site.hosting ? <><Icon.Check size={12} /> Theme files</> : <><Icon.Plug size={12} /> Connect files</>}</button>}
      </div>

      <div className="user-wrap" ref={menuRef}>
        {menu && (
          <div className="menu up">
            <div className="menu-label">Sites</div>
            {p.sites.map((s) => (
              <button key={s.id} className="menu-item" onClick={() => { p.onSelectSite(s.id); setMenu(false); }}>
                <span className="site-dot" /> <span className="grow site-two"><span>{s.name}</span><small>{s.username} · {s.url.replace(/^https?:\/\//, "")}</small></span>{s.id === p.site?.id && <Icon.Check size={15} />}
              </button>
            ))}
            {!client && <>
              <button className="menu-item" onClick={() => { setMenu(false); p.onManageSites(); }}><Icon.Settings size={15} /> Manage sites</button>
              <button className="menu-item" onClick={() => { setMenu(false); p.onAddSite(); }}><Icon.Plus size={15} /> Connect a site</button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { setMenu(false); p.onIntegrations(); }}><Icon.Plug size={15} /> Integrations (AI models, Hostinger)</button>
            </>}
            <div className="menu-sep" />
            {acc ? <>
              <div className="menu-label">{acc.name} · {acc.role}</div>
              <button className="menu-item" onClick={() => { setMenu(false); p.onInstructions(); }}><Icon.Edit size={15} /> My instructions{acc.instructions ? " (custom)" : ""}</button>
              <button className="menu-item" onClick={() => { setMenu(false); p.onPassword(); }}><Icon.Key size={15} /> Change password</button>
              <button className="menu-item" onClick={() => { setMenu(false); p.onSignOut(); }}><Icon.Close size={15} /> Sign out</button>
            </> : p.me?.root
              ? <button className="menu-item" onClick={() => { setMenu(false); p.onSignOut(); }}><Icon.Close size={15} /> Forget the root key</button>
              : <button className="menu-item" onClick={() => { setMenu(false); p.onToken(); }}><Icon.Key size={15} /> Access token</button>}
            <div className="menu-foot">Model: {p.model}</div>
          </div>
        )}
        <button className="user-row" onClick={() => setMenu(!menu)}>
          <span className="avatar-lg">{initial}</span>
          <span className="user-meta"><strong>{acc?.name ?? p.site?.username ?? "No site"}</strong><small>{p.site ? p.site.url.replace(/^https?:\/\//, "") : "Connect a site"}</small></span>
          <Icon.ChevronDown size={16} />
        </button>
      </div>
    </aside>
  );
}
