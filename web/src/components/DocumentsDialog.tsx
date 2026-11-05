import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import type { DocBrief, DocFull, DocTask, Project } from "../types";

/**
 * A project's documents - its AMC first of all. Upload, and the backend reads it in the background and turns what the
 * contract promises into tasks. From here a person picks: a Jira ticket per task (filed as them, in the project's Jira
 * project), or a session on the site for a site task. Reading alone changes nothing anywhere.
 */
const STATUS: Record<DocBrief["status"], string> = { reading: "Reading…", analysing: "Finding the tasks…", ready: "Ready", failed: "Failed" };
const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function DocumentsDialog({ project, onClose, onOpenJob }: { project: Project; onClose: () => void; onOpenJob: (jobId: string) => void }) {
  const [list, setList] = useState<DocBrief[] | null>(null);
  const [openId, setOpenId] = useState("");
  const [doc, setDoc] = useState<DocFull | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = () => api.documents(project.id).then((r) => { setList(r.documents); setOpenId((cur) => cur || r.documents[0]?.id || ""); }).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  useEffect(() => { void loadList(); }, [project.id]);
  // The open document, and again every two seconds while it is still being read.
  useEffect(() => {
    if (!openId) { setDoc(null); return; }
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const load = () => api.document(openId).then((d) => {
      if (!alive) return;
      setDoc(d);
      if (d.status === "reading" || d.status === "analysing") timer = setTimeout(load, 2000); else void loadList();
    }).catch((e) => alive && setMsg({ ok: false, text: (e as Error).message }));
    setPicked(new Set());
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [openId]);

  async function upload(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy("upload"); setMsg(null);
    try { const d = await api.uploadDocument(project.id, f); await loadList(); setOpenId(d.id); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(""); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function tickets() {
    if (!doc) return;
    setBusy("tickets"); setMsg(null);
    try {
      const r = await api.fileTickets(doc.id, [...picked]);
      setDoc({ ...doc, tasks: r.document.tasks }); setPicked(new Set());
      setMsg({ ok: !r.failed.length, text: [r.created.length ? `Filed ${r.created.map((c) => c.key).join(", ")}.` : "", ...r.failed.map((f) => `${f.taskId}: ${f.error}`)].filter(Boolean).join(" ") || "Nothing new to file." });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  }
  async function session(t: DocTask) {
    if (!doc) return;
    setBusy("s:" + t.id); setMsg(null);
    try { const r = await api.startTaskSession(doc.id, t.id); onOpenJob(r.jobId); onClose(); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); setBusy(""); }
  }
  async function dismiss(t: DocTask) {
    if (!doc) return;
    const d = await api.dismissTask(doc.id, t.id, !t.dismissed).catch((e) => { setMsg({ ok: false, text: (e as Error).message }); return null; });
    if (d) setDoc({ ...doc, tasks: d.tasks });
  }
  async function remove() {
    if (!doc || !confirm(`Delete "${doc.filename}"? Tickets and sessions made from it stay.`)) return;
    await api.deleteDocument(doc.id).catch(() => {});
    setOpenId(""); setDoc(null); void loadList();
  }

  const tasks = doc?.tasks ?? [];
  const canPick = (t: DocTask) => !t.jiraKey && !t.dismissed;
  const c = doc?.analysis?.contract;

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog xl docs" onMouseDown={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}>
        <div className="docs-head">
          <div className="grow">
            <h2>Documents · {project.name}</h2>
            <p className="muted small">Upload the AMC (PDF or Word). It is read in the background and turned into tasks; nothing happens on the site or in Jira until you choose.</p>
          </div>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={(e) => void upload(e.target.files)} />
          <button className="btn primary sm" disabled={busy === "upload"} onClick={() => fileRef.current?.click()}><Icon.Upload size={14} /> {busy === "upload" ? "Uploading…" : "Upload"}</button>
          <button className="ghost-icon" title="Close" onClick={onClose}><Icon.Close size={16} /></button>
        </div>
        {drag && <div className="docs-drop">Drop the file to upload it</div>}
        {msg && <div className={`banner ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}

        <div className="docs-body">
          <div className="docs-list">
            {list === null && <p className="muted small"><span className="spin" /> Loading…</p>}
            {list?.length === 0 && <div className="docs-empty" onClick={() => fileRef.current?.click()}><Icon.Page size={22} /><span>No documents yet. Upload the AMC, or drop it here.</span></div>}
            {list?.map((d) => (
              <button key={d.id} className={`docs-item${d.id === openId ? " on" : ""}`} onClick={() => setOpenId(d.id)}>
                <Icon.Page size={15} />
                <span className="grow"><b>{d.filename}</b><small>{STATUS[d.status]}{d.status === "ready" ? ` · ${d.tasks} tasks${d.ticketed ? ` · ${d.ticketed} in Jira` : ""}` : ""} · {kb(d.bytes)}</small></span>
                {(d.status === "reading" || d.status === "analysing") && <span className="spin" />}
              </button>
            ))}
          </div>

          <div className="docs-detail">
            {!doc && list?.length ? <p className="muted small">Pick a document.</p> : null}
            {doc && (doc.status === "reading" || doc.status === "analysing") && <p className="muted"><span className="spin" /> {STATUS[doc.status]} This takes a minute for a few pages.</p>}
            {doc?.status === "failed" && (
              <div className="banner error">{doc.error} <button className="rbtn" onClick={() => void api.reanalyseDocument(doc.id).then(() => { setOpenId(""); setTimeout(() => setOpenId(doc.id), 50); })}>Try again</button></div>
            )}
            {doc?.status === "ready" && doc.analysis && (
              <>
                <p className="docs-summary">{doc.analysis.summary}</p>
                {doc.analysis.truncated && <p className="muted small">The document is long: only its first part was read.</p>}
                <div className="ad-facts">
                  {c?.client && <div><span>Client</span><b>{c.client}</b></div>}
                  {c?.provider && <div><span>Provider</span><b>{c.provider}</b></div>}
                  {c?.period && <div><span>Period</span><b>{c.period}</b></div>}
                  {!!c?.responseTimes.length && <div><span>Response times</span><b>{c.responseTimes.join(" · ")}</b></div>}
                  {!!c?.exclusions.length && <div><span>Not covered</span><b>{c.exclusions.join(" · ")}</b></div>}
                  {c?.reporting && <div><span>Reporting</span><b>{c.reporting}</b></div>}
                </div>

                <div className="docs-actions">
                  <b className="grow">{tasks.length} tasks</b>
                  {!project.jira && <span className="muted small">Link a Jira project in the project settings to file tickets.</span>}
                  <button className="btn sm" disabled={!tasks.some(canPick)} onClick={() => setPicked(picked.size ? new Set() : new Set(tasks.filter(canPick).map((t) => t.id)))}>{picked.size ? "Clear" : "Pick all"}</button>
                  <button className="btn primary sm" disabled={!picked.size || !project.jira || busy === "tickets"} onClick={() => void tickets()}>
                    {busy === "tickets" ? "Filing…" : `Create ${picked.size || ""} Jira ticket${picked.size === 1 ? "" : "s"}${project.jira ? ` in ${project.jira.projectKey}` : ""}`}
                  </button>
                </div>
                <table className="us-table docs-tasks">
                  <tbody>
                    {tasks.map((t) => (
                      <tr key={t.id} className={t.dismissed ? "ad-off" : ""}>
                        <td className="docs-pick">{canPick(t) && <input type="checkbox" aria-label={`Pick ${t.title}`} checked={picked.has(t.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(t.id); else n.delete(t.id); setPicked(n); }} />}</td>
                        <th scope="row">
                          <span className="us-name">{t.title}</span>
                          {t.detail && <small className="us-note">{t.detail}</small>}
                          {t.source && <small className="docs-quote">“{t.source}”</small>}
                        </th>
                        <td><span className={`docs-kind ${t.kind}`}>{t.kind === "site" ? "Site" : "Ticket"}</span> <span className="dim small">{t.frequency}</span>{t.priority === "high" && <span className="docs-high"> high</span>}</td>
                        <td className="docs-state">
                          {t.jiraKey && <a href={t.jiraUrl} target="_blank" rel="noreferrer">{t.jiraKey} <Icon.External size={11} /></a>}
                          {t.jobId ? <button className="rbtn" onClick={() => { onOpenJob(t.jobId!); onClose(); }}>Open session</button>
                            : t.kind === "site" && !t.dismissed && <button className="rbtn" disabled={busy === "s:" + t.id} onClick={() => void session(t)}>{busy === "s:" + t.id ? "Starting…" : "Start session"}</button>}
                          <button className="rbtn ghost" title={t.dismissed ? "Bring back" : "Set aside"} onClick={() => void dismiss(t)}>{t.dismissed ? "Restore" : "Set aside"}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">Read by {doc.analysis.model} in {Math.round(doc.analysis.ms / 1000)}s · uploaded by {doc.uploadedBy}.
                  {" "}<button className="fd-link" onClick={() => void api.reanalyseDocument(doc.id).then(() => { setOpenId(""); setTimeout(() => setOpenId(doc.id), 50); })}>Read again</button>
                  {" · "}<button className="fd-link danger" onClick={() => void remove()}>Delete</button></p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
