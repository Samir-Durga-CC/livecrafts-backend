import path from "node:path";
import { config } from "./config.js";
import { JsonStore, newId } from "./store.js";
import type { Bridge, PostType } from "./bridge.js";
import type { SiteFiles } from "./sitefiles.js";

/**
 * The change ledger: every successful write records HOW to undo it, so any change can be reverted later with one
 * click (or by asking in the chat) - not only "the last one".
 */
export type RevertSpec =
  | { kind: "content"; target: string; previous: string }                 // set_content -> write the old value back
  | { kind: "file"; backupId: string }                                     // edit_file / create_file -> restore backup
  | { kind: "post-content"; type: PostType; id: number; backupId: string } // edit_post_content -> old content back
  | { kind: "post-status"; type: PostType; id: number; previous: string }  // set_post_status -> old status back
  | { kind: "trash"; type: PostType; id: number }                          // create_page / create_post -> move to Trash
  | { kind: "menu"; id: number }                                           // create_menu -> delete that menu
  | { kind: "menu-item"; id: number };                                     // add_menu_item -> delete that item

export interface ChangeRecord {
  id: string; tool: string; title: string;
  key: string;              // what was touched; a newer change to the same key must be reverted first
  at: string; link?: string;
  revert: RevertSpec | null; note?: string;
  revertedAt?: string; revertError?: string;
}

export interface PostBackup { id: string; siteId: string; type: PostType; postId: number; before: string; after: string; createdAt: string }
let postBackupStore: JsonStore<PostBackup> | null = null;
export const postBackups = () => (postBackupStore ??= new JsonStore<PostBackup>(path.join(config.dataDir, "post-backups")));
export const resetPostBackups = () => { postBackupStore = null; };

const short = (s: unknown, n = 70) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Build the ledger entry for a successful write tool call (null = not a write / nothing to record). */
export function recordFor(tool: string, input: any, out: any): ChangeRecord | null {
  if (!out || out.ok === false) return null;
  const base = { id: newId("chg"), tool, at: new Date().toISOString() };
  const why = (fallback: string) => short(input?.reason || fallback, 120);
  switch (tool) {
    case "set_content": {
      const revertable = typeof out.previous === "string";
      return { ...base, title: why("Change content"), key: `target:${input.target}`, revert: revertable ? { kind: "content", target: input.target, previous: out.previous } : null,
        note: revertable ? undefined : "The old value could not be captured; use “undo the last change” in the chat." };
    }
    case "edit_file": case "create_file":
      return { ...base, title: why(tool === "create_file" ? `Create ${input.path}` : `Edit ${input.path}`), key: `file:${out.path ?? input.path}`, revert: out.backupId ? { kind: "file", backupId: out.backupId } : null };
    case "edit_post_content":
      return { ...base, title: why("Edit page content"), key: `post:${input.type}:${input.id}`, link: out.link, revert: { kind: "post-content", type: input.type, id: input.id, backupId: out.backupId } };
    case "set_post_status":
      return { ...base, title: why(`Set status to ${input.status}`), key: `post:${input.type}:${input.id}`, link: out.link, revert: { kind: "post-status", type: input.type, id: input.id, previous: out.previousStatus } };
    case "create_page": case "create_post": {
      const type: PostType = tool === "create_page" ? "pages" : "posts";
      return { ...base, title: why(`Create ${tool === "create_page" ? "page" : "post"} “${input.title}”`), key: `post:${type}:${out.id}`, link: out.link, revert: { kind: "trash", type, id: out.id } };
    }
    case "create_menu":
      return { ...base, title: why(`Create menu “${input.name}”`), key: `menu:${out.menuId}`, revert: { kind: "menu", id: out.menuId } };
    case "add_menu_item":
      return { ...base, title: why(`Add “${input.title}” to the menu`), key: `menu-item:${out.itemId}`, revert: { kind: "menu-item", id: out.itemId } };
    case "upload_media_from_chat": case "upload_media_from_url":
      return { ...base, title: why(`Upload image “${out.title ?? input.title ?? "image"}”`), key: `media:${out.id}`, link: out.url, revert: null, note: "Uploaded images stay in the Media Library (delete them there if not needed)." };
    case "undo_last_change": case "restore_file": case "revert_change":
      return null; // these are undo actions themselves
    default:
      return null;
  }
}

/** Is there a newer, still-active change to the same thing? Then that one must be reverted first. */
export function blockingChange(all: ChangeRecord[], c: ChangeRecord): ChangeRecord | null {
  const idx = all.findIndex((x) => x.id === c.id);
  const sameMenu = (x: ChangeRecord) => c.revert?.kind === "menu" && x.revert?.kind === "menu-item"; // items inside a menu we are deleting are fine
  return all.slice(idx + 1).find((x) => !x.revertedAt && x.key === c.key && !sameMenu(x)) ?? null;
}

export interface RevertDeps { bridge: Bridge; siteFiles?: SiteFiles | null; healthUrls: string[]; siteId: string }

/** Undo one change. Throws with a clear message if it cannot be undone. */
export async function revertChange(c: ChangeRecord, d: RevertDeps): Promise<Record<string, unknown>> {
  const r = c.revert;
  if (!r) throw new Error(c.note ?? "This change cannot be reverted automatically.");
  switch (r.kind) {
    case "content": {
      const res: any = await d.bridge.setTarget(r.target, r.previous);
      return { ok: res?.ok !== false, restored: r.previous };
    }
    case "file": {
      if (!d.siteFiles) throw new Error("File access is not available for this site right now (plugin 0.7+ or Hostinger needed).");
      const res = await d.siteFiles.restore(r.backupId, d.healthUrls);
      if (!res.ok) throw new Error(String(res.error ?? "restore failed"));
      return res;
    }
    case "post-content": {
      const b = postBackups().get(r.backupId);
      if (!b || b.siteId !== d.siteId) throw new Error("The backup of this page's content is missing.");
      const cur: any = await d.bridge.getPost(r.type, r.id);
      if ((cur?.content?.raw ?? "") !== b.after) throw new Error("The page content was changed again after this edit. Revert the newer change first (or edit it in WordPress).");
      await d.bridge.updatePost(r.type, r.id, { content: b.before });
      const check: any = await d.bridge.getPost(r.type, r.id);
      if ((check?.content?.raw ?? "") !== b.before) throw new Error("WordPress did not keep the restored content.");
      return { ok: true, link: check.link };
    }
    case "post-status": {
      const res: any = await d.bridge.updatePost(r.type, r.id, { status: r.previous });
      return { ok: true, status: res?.status };
    }
    case "trash": {
      await d.bridge.trashPost(r.type, r.id);
      return { ok: true, note: "Moved to the Trash (restore it from WordPress → Trash if needed)." };
    }
    case "menu": await d.bridge.deleteMenu(r.id); return { ok: true };
    case "menu-item": await d.bridge.deleteMenuItem(r.id); return { ok: true };
  }
}
