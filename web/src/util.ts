import type { ChangeRecord, JobSummary, TimelineItem } from "./types";

// ---------------------------------------------------------------- tiny local preferences (this browser only)
const read = <T,>(k: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? "") as T; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

export const prefs = {
  pins: () => read<string[]>("lc_pins", []),
  togglePin(id: string) { const p = prefs.pins(); const n = p.includes(id) ? p.filter((x) => x !== id) : [...p, id]; write("lc_pins", n); return n; },
  titles: () => read<Record<string, string>>("lc_titles", {}),
  setTitle(id: string, t: string) { const all = prefs.titles(); if (t.trim()) all[id] = t.trim(); else delete all[id]; write("lc_titles", all); return all; },
  collapsed: () => read<Record<string, boolean>>("lc_collapsed", {}),
  setCollapsed(label: string, v: boolean) { const c = prefs.collapsed(); c[label] = v; write("lc_collapsed", c); return c; },
};

export const titleOf = (j: JobSummary, titles: Record<string, string>) => titles[j.id] ?? (j.prompt.split("\n")[0] || "New chat");

// ---------------------------------------------------------------- history grouping: Pinned / Today / Yesterday / Previous 7 days / Older
export interface JobGroup { label: string; jobs: JobSummary[] }
export function groupJobs(jobs: JobSummary[], pinned: string[]): JobGroup[] {
  const groups: JobGroup[] = [{ label: "Pinned", jobs: [] }, { label: "Today", jobs: [] }, { label: "Yesterday", jobs: [] }, { label: "Previous 7 days", jobs: [] }, { label: "Older", jobs: [] }];
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  for (const j of [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (pinned.includes(j.id)) { groups[0].jobs.push(j); continue; }
    const days = Math.floor((startOfToday.getTime() - new Date(j.updatedAt).getTime()) / 86_400_000) + 1;
    groups[days <= 0 ? 1 : days === 1 ? 2 : days <= 7 ? 3 : 4].jobs.push(j);
  }
  return groups.filter((g) => g.jobs.length);
}

// ---------------------------------------------------------------- chat blocks (consecutive tool steps collapse into one card)
export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
export type Block = { key: string } & (
  | { kind: "user"; item: Extract<TimelineItem, { kind: "user" }> }
  | { kind: "steps"; items: ToolItem[] }
  | { kind: "approval"; item: Extract<TimelineItem, { kind: "approval" }> }
  | { kind: "assistant"; item: Extract<TimelineItem, { kind: "assistant" }> }
  | { kind: "error"; item: Extract<TimelineItem, { kind: "error" }> }
);

export function toBlocks(items: TimelineItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.items.push(it); else out.push({ key: "b" + out.length, kind: "steps", items: [it] });
    } else out.push({ key: "b" + out.length, kind: it.kind, item: it } as Block);
  }
  return out;
}

// ---------------------------------------------------------------- the "Changes" side panel: one entry per requested write
/** Tools that write to the live site (each one needs approval). */
export const WRITE_TOOLS = [
  "set_content", "upload_media_from_chat", "upload_media_from_url", "undo_last_change", "edit_file", "create_file", "restore_file",
  "create_page", "create_post", "edit_post_content", "set_post_status", "create_menu", "add_menu_item", "revert_change",
];

export type ChangeState = "pending" | "denied" | "applied" | "failed" | "reverted";
export interface Change {
  key: string; tool: string; icon: "text" | "link" | "image" | "undo" | "code" | "page" | "menu"; title: string; target: string;
  from?: string; to?: string; state: ChangeState; detail?: string; record?: ChangeRecord;
}

const short = (s: unknown, n = 60) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function changeFor(it: Extract<TimelineItem, { kind: "approval" }>): Change {
  const i = it.input ?? {};
  const base = { key: it.approvalId, tool: it.tool, state: "pending" as const };
  const reason = (d: string) => String(i.reason || d);
  switch (it.tool) {
    case "set_content":
      return { ...base, icon: /image|photo|picture/i.test(String(i.reason ?? "")) ? "image" : /link|url/i.test(String(i.target ?? "") + String(i.reason ?? "")) ? "link" : "text", title: reason("Change content"), target: String(i.target ?? ""), from: it.current == null || it.current === "" ? "(empty)" : String(it.current), to: String(i.value ?? "") };
    case "upload_media_from_chat": return { ...base, icon: "image", title: "Upload image to the Media Library", target: String(i.fileId ?? ""), to: String(i.title ?? "") };
    case "upload_media_from_url": return { ...base, icon: "image", title: reason("Import an image to the Media Library"), target: short(i.url, 80) };
    case "undo_last_change": return { ...base, icon: "undo", title: "Undo the last change", target: `page #${i.postId}` };
    case "edit_file": return { ...base, icon: "code", title: reason("Edit a theme file"), target: String(i.path ?? ""), from: short(i.find), to: short(i.replace) };
    case "create_file": return { ...base, icon: "code", title: reason("Create a theme file"), target: String(i.path ?? "") };
    case "create_page": case "create_post": return { ...base, icon: "page", title: reason(`Create “${i.title}”`), target: `${it.tool === "create_page" ? "page" : "post"} · ${i.status ?? "publish"}` };
    case "edit_post_content": return { ...base, icon: "page", title: reason("Edit page content"), target: `${i.type === "posts" ? "post" : "page"} #${i.id}`, from: short(i.find), to: short(i.replace) };
    case "set_post_status": return { ...base, icon: "page", title: reason(`Set status to ${i.status}`), target: `${i.type === "posts" ? "post" : "page"} #${i.id}` };
    case "create_menu": return { ...base, icon: "menu", title: reason(`Create menu “${i.name}”`), target: `location: ${i.location}`, to: (i.items ?? []).map((x: any) => x.title).join(" · ") };
    case "add_menu_item": return { ...base, icon: "menu", title: reason(`Add “${i.title}” to the menu`), target: `menu #${i.menuId}` };
    case "revert_change": return { ...base, icon: "undo", title: `Revert: ${(it.current as any)?.title ?? i.changeId}`, target: String(i.changeId ?? "") };
    default: return { ...base, icon: "undo", title: reason("Restore a file from its backup"), target: String((it.current as any)?.path ?? i.backupId ?? "") };
  }
}

export function changesFrom(items: TimelineItem[], ledger: Map<string, ChangeRecord>): Change[] {
  const changes: Change[] = [];
  const awaiting: Change[] = []; // approved writes whose result has not arrived yet
  for (const it of items) {
    if (it.kind === "approval" && WRITE_TOOLS.includes(it.tool)) {
      const c = changeFor(it);
      if (it.answer) { c.state = it.answer.approved ? "applied" : "denied"; if (it.answer.approved) awaiting.push(c); }
      changes.push(c);
    }
    if (it.kind === "tool" && WRITE_TOOLS.includes(it.tool) && it.state !== "running") {
      const c = awaiting.find((x) => x.tool === it.tool);
      if (c) {
        awaiting.splice(awaiting.indexOf(c), 1);
        if (it.state === "failed") { c.state = "failed"; c.detail = it.error; }
        const rec = it.changeId ? ledger.get(it.changeId) : undefined;
        if (rec) { c.record = rec; if (rec.revertedAt) c.state = "reverted"; }
      }
    }
  }
  return changes;
}

/** Bumps every time a write finished successfully - the preview reloads on it. */
export const writeCount = (items: TimelineItem[]) => items.filter((i) => i.kind === "tool" && i.state === "ok" && WRITE_TOOLS.includes(i.tool)).length;

export function ago(iso: string) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ---------------------------------------------------------------- Changes panel: ONE card per request
export type RequestState = "pending" | "working" | "applied" | "partial" | "reverted" | "denied" | "failed";
export interface RequestGroup {
  requestId: number; text: string; at?: string;
  changes: ChangeRecord[];                 // applied writes of this request (from the ledger)
  pending: number; denied: number;         // approval cards waiting / refused in this request
  failures: { title: string; error?: string }[];
  state: RequestState;
}

/** Walk the chat: every person message starts a request; collect what that request changed. */
export function groupRequests(items: TimelineItem[], ledger: Map<string, ChangeRecord>, working: boolean): RequestGroup[] {
  const groups: RequestGroup[] = [];
  const all = [...ledger.values()];
  let cur: RequestGroup | null = null;
  let n = 0;
  for (const it of items) {
    if (it.kind === "user") {
      n += 1;
      const id = it.requestId ?? n;
      cur = { requestId: id, text: it.text, changes: all.filter((c) => (c.requestId ?? 1) === id), pending: 0, denied: 0, failures: [], state: "applied" };
      groups.push(cur);
      continue;
    }
    if (!cur) continue;
    if (it.kind === "approval" && WRITE_TOOLS.concat("propose_plan").includes(it.tool)) {
      if (!it.answer) cur.pending++;
      else if (!it.answer.approved) cur.denied++;
    }
    if (it.kind === "tool" && WRITE_TOOLS.includes(it.tool) && it.state === "failed") cur.failures.push({ title: it.tool.replace(/_/g, " "), error: it.error });
  }
  const last = groups[groups.length - 1];
  for (const g of groups) {
    g.at = g.changes[0]?.at;
    const active = g.changes.filter((c) => !c.revertedAt).length;
    g.state = g.pending ? "pending"
      : working && g === last ? "working"
      : g.changes.length && active === 0 ? "reverted"
      : g.changes.length && active < g.changes.length ? "partial"
      : g.changes.length ? "applied"
      : g.denied ? "denied" : g.failures.length ? "failed" : "applied";
  }
  return groups.filter((g) => g.changes.length || g.pending || g.denied || g.failures.length || (working && g === last));
}

/** Short name for a change chip: the file name, page or field it touched. */
export function chipLabel(c: ChangeRecord): string {
  const k = c.key ?? "";
  if (k.startsWith("file:")) return k.slice(5).split("/").pop() || k.slice(5);
  if (c.diff?.label) return c.diff.label.length > 34 ? c.diff.label.slice(0, 33) + "…" : c.diff.label;
  return c.title.length > 34 ? c.title.slice(0, 33) + "…" : c.title;
}
