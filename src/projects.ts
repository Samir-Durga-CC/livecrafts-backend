import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import type { ApprovalMode, Site } from "./types.js";

/**
 * Projects: named workspaces on a site, each with its own sessions (chats) - the way a coding app keeps a folder per
 * project and a list of sessions inside it.
 *
 * A site can hold several projects ("Homepage redesign", "AMC 2026"), and each project can carry what is the same for
 * all its sessions: instructions for the assistant, a default model, a default approval mode (and later its Jira
 * project and its documents). Who may open a project follows the site: a client sees the projects of their sites.
 *
 * Every site has a default project (named after the site) that is made the first time it is needed. Chats from
 * before projects existed, and chats started from the WordPress widget, belong to it - nothing has to be migrated.
 */
export interface Project {
  id: string;
  name: string;
  siteId: string;
  description?: string;
  /** Added to the assistant's rules for every session of this project (after the site owner's, before the person's). */
  instructions?: string;
  /** "provider:model" for sessions that do not pick one. */
  model?: string;
  approvalMode?: ApprovalMode;
  /** The site's own project: holds the chats that name no project. Cannot be archived. */
  isDefault?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export const defaultProjectId = (siteId: string) => "prj_" + siteId.replace(/^site_/, "");
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const MODES: ApprovalMode[] = ["every", "request", "auto"];

export class Projects {
  private store: JsonStore<Project>;
  constructor(dataDir = config.dataDir) { this.store = new JsonStore<Project>(path.join(dataDir, "projects")); }

  get(id: string) { return this.store.get(id); }

  /** The site's default project, made on first use. */
  defaultFor(site: Site): Project {
    const id = defaultProjectId(site.id);
    const have = this.store.get(id);
    if (have) return have;
    const now = new Date().toISOString();
    return this.store.put({ id, name: site.name || site.url.replace(/^https?:\/\//, ""), siteId: site.id, isDefault: true, createdAt: now, updatedAt: now });
  }

  /** Every project of these sites, default projects included (made now if missing), oldest first. */
  forSites(sites: Site[]): Project[] {
    const ids = new Set(sites.map((s) => s.id));
    for (const s of sites) this.defaultFor(s);
    return this.store.list().filter((p) => ids.has(p.siteId)).sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.createdAt.localeCompare(b.createdAt));
  }

  create(site: Site, input: { name?: string; description?: string; instructions?: string; model?: string; approvalMode?: string }, by: string): Project {
    const name = clean(input.name, 80);
    if (!name) throw new Error("A project needs a name.");
    const now = new Date().toISOString();
    return this.store.put({
      id: newId("prj"), name, siteId: site.id, createdAt: now, updatedAt: now, createdBy: by,
      ...this.settings(input),
    });
  }

  update(id: string, patch: { name?: string; description?: string; instructions?: string; model?: string; approvalMode?: string; archived?: boolean }): Project {
    const p = this.store.get(id);
    if (!p) throw new Error("Unknown project.");
    if (patch.archived && p.isDefault) throw new Error("A site's own project cannot be archived.");
    const next: Project = { ...p, ...this.settings({ ...p, ...patch }), updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) next.name = clean(patch.name, 80) || p.name;
    if (patch.archived !== undefined) next.archived = !!patch.archived || undefined;
    return this.store.put(next);
  }

  /** The settings a project may carry, cleaned; an empty value removes the setting. */
  private settings(i: { description?: string; instructions?: string; model?: string; approvalMode?: string }) {
    const description = clean(i.description, 400), instructions = clean(i.instructions, 4000), model = clean(i.model, 120);
    return {
      description: description || undefined,
      instructions: instructions || undefined,
      model: model || undefined,
      approvalMode: MODES.includes(i.approvalMode as ApprovalMode) ? (i.approvalMode as ApprovalMode) : undefined,
    };
  }
}

/** The one project store of this backend. */
export const projects = new Projects();
