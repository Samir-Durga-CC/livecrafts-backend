/** Plugin update types (the Livecrafts plugin 0.19+ API, passed through by the backend). */
export interface PluginBackup { id: string; version: string; at: string; size: number }
export interface PluginInfo {
  plugin: string; slug: string; name: string; version: string; author: string; active: boolean; self: boolean; wporg: boolean; dbHeavy: boolean;
  update: { version: string; requires: string; requiresPhp: string; tested: string; compatible: boolean; package: boolean } | null;
  backups: PluginBackup[];
}
export interface PluginList { plugins: PluginInfo[]; wp: string; php: string; canModify: boolean; blocked: string; checkedAt: string | null }
export interface PluginHistoryEntry { at: string; by: string; plugin: string; name: string; action: "update" | "auto_rollback" | "rollback"; from: string; to: string; result: string; note?: string }
export interface PluginActionResult {
  ok: boolean; plugin: string; name: string; from: string; to: string; message: string; rolledBack?: boolean; verified?: boolean; dbHeavy?: boolean; backup?: string | null;
  health?: { ok: boolean | null; checks: Array<{ name: string; ok: boolean | null; detail: string }> };
}

export interface PluginJob {
  id: string; siteId: string; plugin: string; name?: string; from?: string; to?: string;
  phase: "preparing" | "installing" | "recovering" | "done"; startedAt: string; finishedAt?: string; result?: PluginActionResult; error?: string;
}
export const PHASE_TEXT: Record<PluginJob["phase"], string> = {
  preparing: "Checking the site and saving a backup…",
  installing: "Installing the new version and checking the site…",
  recovering: "The server cut the update off. Repairing it from the backup…",
  done: "Done",
};

/** Plugins that can be updated from the list (an update, a package, compatible, not Livecrafts itself). */
export const updatable = (p: PluginInfo) => !!p.update && p.update.package && p.update.compatible && !p.self;

/** "3 Oct 14:05" */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
