import type { Bridge } from "./bridge.js";
import { WRITE_TOOLS } from "./tools.js";

/**
 * The changes a chat made, for its Changes panel. The site's history in the Livecrafts plugin is the source of truth
 * (who, what, before/after, draft/live, every source - not only this chat); a chat only keeps a pointer to each
 * change it made (pluginId), grouped by the request (message) that made it.
 */
export interface ChangeRecord {
  id: string;               // "lc_<plugin id>"
  pluginId: number;
  tool: string; title: string;
  key: string;              // what was touched; a newer change to the same key must be reverted first
  at: string; link?: string;
  status?: string;          // draft | live | discarded (as reported when it was made)
  revert: { kind: "plugin" } | null; note?: string;
  revertedAt?: string; revertError?: string;
  requestId?: number;       // which person request (message) it belongs to - the Changes panel groups by this
  request?: string;
  verification?: { passed: boolean; summary: string };
}

/** Build the record for a successful write tool call (null = not a write / nothing was changed). */
export function recordFor(tool: string, _input: any, out: any): ChangeRecord | null {
  if (!WRITE_TOOLS.has(tool) || !out || out.ok === false || out.unchanged || !out.change?.id) return null;
  const c = out.change;
  return {
    id: "lc_" + c.id, pluginId: Number(c.id), tool, title: String(c.summary ?? tool).slice(0, 200),
    key: `${c.kind}:${c.object ?? ""}:${c.target ?? ""}`, at: c.at ?? new Date().toISOString(), link: out.preview ?? undefined,
    status: c.status, revert: { kind: "plugin" },
    verification: out.verification ? { passed: !!out.verification.passed, summary: String(out.verification.summary ?? "") } : undefined,
  };
}

/** All records of a write tool call: the extra changes first (e.g. the CSS blocks of place_component), the main change last. */
export function recordsFor(tool: string, input: any, out: any): ChangeRecord[] {
  const main = recordFor(tool, input, out);
  if (!main) return [];
  const extras = (Array.isArray(out?.extraChanges) ? out.extraChanges : []).filter((c: any) => c?.id).map((c: any): ChangeRecord => ({
    id: "lc_" + c.id, pluginId: Number(c.id), tool, title: String(c.summary ?? tool).slice(0, 200), key: `${c.kind}:${c.object ?? ""}:${c.target ?? ""}`,
    at: c.at ?? new Date().toISOString(), status: c.status, revert: { kind: "plugin" },
  }));
  return [...extras, main];
}

/** Is there a newer, still-active change to the same thing? Then that one must be reverted first. */
export function blockingChange(all: ChangeRecord[], c: ChangeRecord): ChangeRecord | null {
  const idx = all.findIndex((x) => x.id === c.id);
  return all.slice(idx + 1).find((x) => !x.revertedAt && x.key === c.key) ?? null;
}

export interface RevertDeps { bridge: Bridge; ref?: string }

/** Undo one change through the plugin (drops a draft, or drafts the old value of a live change). */
export async function revertChange(c: ChangeRecord, d: RevertDeps): Promise<Record<string, unknown>> {
  if (!c.revert || !c.pluginId) throw new Error(c.note ?? "This change cannot be reverted automatically.");
  const r: any = await d.bridge.revert(c.pluginId, d.ref);
  if (r?.ok === false) throw new Error(String(r.error ?? r.message ?? "The site refused to revert it."));
  return { ok: true, note: r?.note, newChange: r?.change?.id };
}

/** Before/after of a change, for the diff view. */
export async function diffOf(c: ChangeRecord, bridge: Bridge): Promise<{ label: string; language: string; before: string; after: string } | null> {
  const r: any = await bridge.change(c.pluginId);
  const ch = r?.change;
  if (!ch) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));
  if (Array.isArray(ch.diff) && ch.diff.length) {
    return { label: ch.summary, language: "text", before: ch.diff.map((d: any) => `# ${d.path}\n${text(d.before)}`).join("\n\n"), after: ch.diff.map((d: any) => `# ${d.path}\n${text(d.after)}`).join("\n\n") };
  }
  const lang = String(ch.kind).startsWith("css.") ? "css" : String(ch.kind).startsWith("block.") || ch.target === "content" ? "html" : String(ch.kind).startsWith("el.") ? "json" : "text";
  return { label: ch.summary, language: lang, before: text(ch.payload?.before), after: text(ch.payload?.after) };
}
