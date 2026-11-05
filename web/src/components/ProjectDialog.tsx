import { useEffect, useState } from "react";
import { api } from "../api";
import type { ApprovalMode, JiraStatus, Project, Site } from "../types";

const MODES: { id: ApprovalMode | ""; label: string }[] = [
  { id: "", label: "No default (each person's own choice)" },
  { id: "every", label: "Every change asks" },
  { id: "request", label: "Once per request (approve the plan)" },
  { id: "auto", label: "Nothing asks (still drafts, still checked)" },
];

/**
 * A new project, or the settings of one. What is set here holds for every session of the project: its instructions
 * are added to the assistant's rules, and its model and approval mode are the defaults a session starts with.
 */
export function ProjectDialog({ project, sites, siteId, onClose, onSaved }: {
  project?: Project; sites: Site[]; siteId?: string; onClose: () => void; onSaved: (p: Project) => void;
}) {
  const [f, setF] = useState({
    name: project?.name ?? "", siteId: project?.siteId ?? siteId ?? sites[0]?.id ?? "", description: project?.description ?? "",
    instructions: project?.instructions ?? "", model: project?.model ?? "", approvalMode: (project?.approvalMode ?? "") as ApprovalMode | "",
  });
  const [models, setModels] = useState<string[]>([]);
  // Jira: linked with the editing person's own Jira, which also checks that the key exists.
  const [jira, setJira] = useState<JiraStatus | null>(null);
  const [jiraKey, setJiraKey] = useState(project?.jira?.projectKey ?? "");
  const [jiraList, setJiraList] = useState<{ key: string; name: string }[]>([]);
  useEffect(() => {
    if (!project) return;
    api.jira().then((s) => { setJira(s); if (s.connected) api.jiraProjects().then((r) => setJiraList(r.projects)).catch(() => {}); }).catch(() => {});
  }, [project?.id]); // the id: the list refreshes every few seconds with new objects, Jira need not be asked again
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { api.models().then((r) => setModels(r.choices.map((c) => c.id))).catch(() => {}); }, []);

  async function save(patch?: Partial<Project>) {
    setBusy(true); setErr("");
    try {
      const jiraChanged = !!project && jiraKey.trim().toUpperCase() !== (project.jira?.projectKey ?? "");
      const body = { name: f.name, description: f.description, instructions: f.instructions, model: f.model, approvalMode: f.approvalMode || undefined,
        ...(jiraChanged ? { jira: jiraKey.trim() ? { projectKey: jiraKey.trim().toUpperCase() } : null } : {}), ...patch };
      const p = project ? await api.updateProject(project.id, body as any) : await api.createProject({ ...body, siteId: f.siteId } as any);
      onSaved(p); onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>{project ? "Project settings" : "New project"}</h2>
        <p className="muted small">A project keeps its own sessions. What you set here holds for every one of them.</p>
        <label>Name <input required value={f.name} onChange={set("name")} placeholder="Homepage redesign, AMC 2026, Blog…" autoFocus={!project} /></label>
        {project ? (
          <p className="small muted">Site: <b>{sites.find((s) => s.id === project.siteId)?.name ?? project.siteId}</b>{project.isDefault ? " - this is the site's own project: chats that name no project, and the WordPress widget's, land here." : ""}</p>
        ) : (
          <label>Site
            <select required value={f.siteId} onChange={set("siteId")}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name} - {s.url.replace(/^https?:\/\//, "")}</option>)}
            </select>
          </label>
        )}
        <label>Description <small className="muted">(optional)</small><input value={f.description} onChange={set("description")} maxLength={400} /></label>
        <label>Instructions for the assistant <small className="muted">(added to its rules in every session of this project)</small>
          <textarea className="instr-text" rows={5} maxLength={4000} value={f.instructions} onChange={set("instructions")}
            placeholder="For example: This is the AMC for Acme. Every change gets a one-line note for the monthly report. Never touch the shop pages." />
        </label>
        <div className="ad-grid">
          <label>Default model
            <input value={f.model} onChange={set("model")} list="prj-models" placeholder="the site's / backend's default" />
            <datalist id="prj-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label>Default approval
            <select value={f.approvalMode} onChange={set("approvalMode")}>{MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          </label>
        </div>
        {project ? (
          <fieldset className="ad-sites prj-jira"><legend>Jira</legend>
            {jira?.connected ? (
              <label>Jira project key <small className="muted">(the assistant reads and files tickets here, as each person, with approval for every write)</small>
                <input value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} list="prj-jira" placeholder="e.g. ACME - empty = no Jira for this project" />
                <datalist id="prj-jira">{jiraList.map((j) => <option key={j.key} value={j.key}>{j.name}</option>)}</datalist>
              </label>
            ) : (
              <p className="muted small">{project.jira ? <>Linked to <b>{project.jira.projectKey}</b>{project.jira.projectName ? ` (${project.jira.projectName})` : ""}. </> : ""}Connect your own Jira (account menu → Jira) to {project.jira ? "change" : "link"} it.</p>
            )}
            {jira?.connected && project.jira && <p className="muted small">Now: <b>{project.jira.projectKey}</b>{project.jira.projectName ? ` - ${project.jira.projectName}` : ""}. Each person's sessions use their own Jira connection; someone without one gets no Jira tools.</p>}
          </fieldset>
        ) : <p className="muted small">Jira can be linked in the project's settings once it is made.</p>}
        {err && <div className="banner error">{err}</div>}
        <div className="dialog-actions">
          {project && !project.isDefault && (
            <button type="button" className="btn ghost danger" disabled={busy} onClick={() => { if (confirm(`Archive "${project.name}"? Its sessions are kept; it leaves the sidebar and takes no new sessions until restored.`)) void save({ archived: true }); }}>Archive</button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !f.name.trim() || (!project && !f.siteId)}>{busy ? "Saving…" : project ? "Save" : "Create project"}</button>
        </div>
      </form>
    </div>
  );
}
