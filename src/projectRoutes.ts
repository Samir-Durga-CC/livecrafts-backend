import { canUseSite, callerName, isStaff } from "./auth.js";
import { jiraOwner, type RouteContext } from "./adminRoutes.js";
import { JiraClient } from "./jira.js";
import { secrets } from "./secrets.js";
import { defaultProjectId, projects } from "./projects.js";
import { log } from "./usage.js";

/**
 * /projects - the workspaces the app's sidebar lists, each with its sessions (projects.ts).
 *
 *   GET   /projects        the projects of every site this caller may use, with how many sessions each has
 *   POST  /projects        a new project on a site (owners and developers)
 *   PATCH /projects/:id    name, description, instructions, default model / approval mode, archive (owners and developers)
 *
 * The sessions themselves are the jobs (GET /jobs), each carrying its projectId.
 */
export async function handleProjectRoutes(c: RouteContext): Promise<boolean> {
  const { req, res, url, route, caller, send, readJson } = c;
  if (route === "GET /projects") {
    const visible = c.sites.list().filter((s) => canUseSite(caller, s.id));
    const jobs = c.runner.list();
    const all = url.searchParams.get("archived") === "1";
    const rows = projects.forSites(visible).filter((p) => all || !p.archived).map((p) => {
      const mine = jobs.filter((j) => (j.projectId ?? defaultProjectId(j.siteId)) === p.id);
      return { ...p, sessions: mine.length, running: mine.filter((j) => j.status === "running" || j.status === "queued").length, lastActivity: mine[0]?.updatedAt ?? null };
    });
    return send(res, 200, rows), true;
  }
  if (route === "POST /projects") {
    if (!isStaff(caller)) return send(res, 403, { error: "Only owners and developers make projects." }), true;
    const b = await readJson(req);
    const site = c.sites.get(String(b.siteId ?? ""));
    if (!site) return send(res, 400, { error: "Pick the site this project works on." }), true;
    try {
      const p = projects.create(site, b, callerName(caller));
      log("info", "project created", { project: p.id, site: site.id, by: callerName(caller) });
      return send(res, 201, { ...p, sessions: 0, running: 0, lastActivity: null }), true;
    } catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
  }
  const m = url.pathname.match(/^\/projects\/(prj_\w+)$/);
  if (m && req.method === "PATCH") {
    if (!isStaff(caller)) return send(res, 403, { error: "Only owners and developers change projects." }), true;
    const p = projects.get(m[1]);
    if (!p || !canUseSite(caller, p.siteId)) return send(res, 404, { error: "Unknown project." }), true;
    try {
      const b = await readJson(req);
      // Linking a Jira project: checked with the linking person's own Jira, so a key that does not exist (or that
      // they cannot see) is caught here, not in the middle of someone's session.
      if (b.jira !== undefined && b.jira !== null) {
        const key = String(b.jira?.projectKey ?? "").trim().toUpperCase();
        if (!key) b.jira = null;
        else {
          const conn = secrets.jira(jiraOwner(caller));
          if (!conn) return send(res, 400, { error: "Connect your own Jira first (account menu → Jira), then link the project." }), true;
          try { const jp = await new JiraClient(conn).project(key); b.jira = { projectKey: jp.key, projectName: jp.name }; }
          catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
        }
      }
      const next = projects.update(p.id, b);
      log("info", "project changed", { project: p.id, by: callerName(caller) });
      return send(res, 200, next), true;
    } catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
  }
  return false;
}
