import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import type { JobSummary, Site } from "../types";
import { groupJobs, prefs, titleOf } from "../util";

export interface SidebarProps {
  sites: Site[]; site?: Site; jobs: JobSummary[]; jobId: string; titles: Record<string, string>; pinned: string[]; model: string;
  hostingerOk?: boolean;
  onSelectSite: (id: string) => void; onAddSite: () => void; onManageSites: () => void; onToken: () => void; onIntegrations: () => void;
  onSelectJob: (id: string) => void; onNewChat: () => void; onTogglePin: (id: string) => void; onHide: () => void;
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

  const groups = useMemo(() => groupJobs(p.jobs.filter((j) => !q || titleOf(j, p.titles).toLowerCase().includes(q.toLowerCase())), p.pinned), [p.jobs, p.pinned, p.titles, q]);
  const initial = (p.site?.username || "L").slice(0, 1).toUpperCase();

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="brand"><span className="logo"><Icon.Sparkle size={16} /></span> Livecrafts</div>
        <div className="sb-icons">
          <button className="ghost-icon" title="Search chats" onClick={() => { setSearching(!searching); setQ(""); }}><Icon.Search size={17} /></button>
          <button className="ghost-icon" title="Hide sidebar" onClick={p.onHide}><Icon.Sidebar size={17} /></button>
        </div>
      </div>

      {searching && <input className="sb-search" autoFocus placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} />}

      <button className="newchat" disabled={!p.site} onClick={p.onNewChat}><Icon.Plus size={16} /> New Chat</button>

      <nav className="nav">
        <button className="nav-item on"><Icon.Chat size={17} /> Chat</button>
        <button className="nav-item" onClick={p.onManageSites}><Icon.Globe size={17} /> Sites <span className="count">{p.sites.length}</span></button>
        <button className="nav-item" onClick={p.onIntegrations}><Icon.Plug size={17} /> Integrations <span className={`conn-dot ${p.hostingerOk ? "ok" : ""}`} title={p.hostingerOk ? "Hostinger connected" : "Hostinger not connected"} /></button>
      </nav>
      <div className="divider" />

      <div className="history">
        {groups.length === 0 && <div className="empty-hist">{q ? "No chats match." : "No chats yet. Start one!"}</div>}
        {groups.map((g) => {
          const isClosed = !!collapsed[g.label];
          return (
            <div key={g.label} className="group">
              <button className="group-head" onClick={() => setCollapsed(prefs.setCollapsed(g.label, !isClosed))}>
                {g.label === "Pinned" && <Icon.Pin size={12} />}<span>{g.label}</span>
                <span className="grow" />{isClosed ? <Icon.ChevronRight size={14} /> : <Icon.ChevronDown size={14} />}
              </button>
              {!isClosed && g.jobs.map((j) => (
                <div key={j.id} className={`hist ${j.id === p.jobId ? "on" : ""}`}>
                  <button className="hist-main" onClick={() => p.onSelectJob(j.id)} title={titleOf(j, p.titles)}>
                    <span className={`dot ${j.status}`} />
                    <span className="hist-text">{titleOf(j, p.titles)}</span>
                  </button>
                  <button className={`pin-btn ${p.pinned.includes(j.id) ? "on" : ""}`} title={p.pinned.includes(j.id) ? "Unpin" : "Pin"} onClick={() => p.onTogglePin(j.id)}><Icon.Pin size={14} /></button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="safe-card">
        <div className="safe-ico"><Icon.Shield size={18} /></div>
        <div>
          <strong>Safe mode is on</strong><p>Every change waits for your approval and is checked on the live page afterwards.</p>
          {p.site && <button className="safe-link" onClick={p.onIntegrations}>{p.site.hosting ? <><Icon.Check size={12} /> Theme files: linked</> : <><Icon.Plug size={12} /> Theme files: connect Hostinger</>}</button>}
        </div>
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
            <button className="menu-item" onClick={() => { setMenu(false); p.onManageSites(); }}><Icon.Settings size={15} /> Manage sites</button>
            <button className="menu-item" onClick={() => { setMenu(false); p.onAddSite(); }}><Icon.Plus size={15} /> Connect a site</button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { setMenu(false); p.onIntegrations(); }}><Icon.Plug size={15} /> Integrations (AI models, Hostinger)</button>
            <button className="menu-item" onClick={() => { setMenu(false); p.onToken(); }}><Icon.Key size={15} /> Access token</button>
            <div className="menu-foot">Model: {p.model}</div>
          </div>
        )}
        <button className="user-row" onClick={() => setMenu(!menu)}>
          <span className="avatar-lg">{initial}</span>
          <span className="user-meta"><strong>{p.site?.username ?? "No site"}</strong><small>{p.site ? p.site.url.replace(/^https?:\/\//, "") : "Connect a site"}</small></span>
          <Icon.ChevronDown size={16} />
        </button>
      </div>
    </aside>
  );
}
