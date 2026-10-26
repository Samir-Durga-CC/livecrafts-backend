import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { CATEGORIES, SECTIONS } from "./library.js";

/**
 * The Section Gallery's counter: every section added to a page, append-only, one file per month.
 *
 *   data/section-usage/2026-10.jsonl   {at, site, section, post, place, builder, user?}
 *
 * The report counts adds (a section later removed or undone still counts as one use: it was picked). The first time
 * it runs it imports the adds the backend logged before the counter existed ("section added: <id>" log lines).
 */
export interface SectionUse { at: string; site: string; section: string; post: number; place: string; builder: string; user?: string }

const dir = () => { const d = path.join(config.dataDir, "section-usage"); fs.mkdirSync(d, { recursive: true }); return d; };
const append = (row: SectionUse) => { try { fs.appendFileSync(path.join(dir(), row.at.slice(0, 7) + ".jsonl"), JSON.stringify(row) + "\n"); } catch { /* a counter never breaks an add */ } };

export function recordSectionUse(row: Omit<SectionUse, "at"> & { at?: string }) {
  importOldAdds();
  append({ at: row.at ?? new Date().toISOString(), site: row.site, section: row.section, post: row.post, place: row.place, builder: row.builder, ...(row.user ? { user: row.user } : {}) });
}

/** Once: the adds logged before the counter existed. */
function importOldAdds() {
  const marker = path.join(dir(), ".imported");
  if (fs.existsSync(marker)) return;
  try {
    const logs = path.join(config.dataDir, "logs");
    for (const f of fs.existsSync(logs) ? fs.readdirSync(logs).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort() : []) {
      for (const line of fs.readFileSync(path.join(logs, f), "utf8").split("\n")) {
        if (!line.includes("section added: ")) continue;
        try {
          const r = JSON.parse(line);
          const m = /^section added: ([a-z0-9-]+)$/.exec(String(r.msg ?? ""));
          if (m && r.site) append({ at: String(r.at), site: String(r.site), section: m[1], post: Number(r.post) || 0, place: String(r.place ?? ""), builder: String(r.builder ?? "") });
        } catch { /* a broken line */ }
      }
    }
  } catch { /* nothing to import */ }
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* try again next time */ }
}

export function readSectionUses(): SectionUse[] {
  importOldAdds();
  const out: SectionUse[] = [];
  for (const f of fs.readdirSync(dir()).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    for (const line of fs.readFileSync(path.join(dir(), f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a broken line */ }
    }
  }
  return out;
}

export interface SectionUsageRow {
  id: string; name: string; category: string; count: number; siteCount: number; last: string | null;
  sites: Array<{ id: string; name: string; url: string; count: number; last: string }>;
}
export interface SectionUsageReport {
  totals: { adds: number; websites: number; sectionsUsed: number; sections: number; since: string | null };
  sections: SectionUsageRow[];
  websites: Array<{ id: string; name: string; url: string; count: number; sections: number; last: string }>;
}

/** Per section: how many times it was added, on how many websites, and when last; plus per website. */
export function sectionUsageReport(uses: SectionUse[], sites: Array<{ id: string; name: string; url: string }>): SectionUsageReport {
  const siteOf = (id: string) => sites.find((s) => s.id === id) ?? { id, name: "(site removed)", url: "" };
  const cat = (id: string) => CATEGORIES.find((c) => c.id === id)?.name ?? id;
  const known = new Map(SECTIONS.map((s) => [s.id, s]));
  const ids = [...new Set([...SECTIONS.map((s) => s.id), ...uses.map((u) => u.section)])];
  const later = (a: string | null, b: string) => (!a || b > a ? b : a);
  const rows: SectionUsageRow[] = ids.map((id) => {
    const mine = uses.filter((u) => u.section === id);
    const bySite = new Map<string, { count: number; last: string }>();
    for (const u of mine) { const s = bySite.get(u.site) ?? { count: 0, last: "" }; s.count++; s.last = later(s.last, u.at) ?? u.at; bySite.set(u.site, s); }
    const def = known.get(id);
    return {
      id, name: def?.name ?? id, category: def ? cat(def.category) : "(no longer in the gallery)", count: mine.length, siteCount: bySite.size,
      last: mine.reduce<string | null>((a, u) => later(a, u.at), null),
      sites: [...bySite].map(([sid, v]) => ({ ...siteOf(sid), id: sid, count: v.count, last: v.last })).sort((a, b) => b.count - a.count),
    };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const siteIds = [...new Set(uses.map((u) => u.site))];
  return {
    totals: {
      adds: uses.length, websites: siteIds.length, sectionsUsed: rows.filter((r) => r.count > 0).length, sections: SECTIONS.length,
      since: uses.reduce<string | null>((a, u) => (!a || u.at < a ? u.at : a), null),
    },
    sections: rows,
    websites: siteIds.map((sid) => {
      const mine = uses.filter((u) => u.site === sid);
      return { ...siteOf(sid), id: sid, count: mine.length, sections: new Set(mine.map((u) => u.section)).size, last: mine.reduce((a, u) => (u.at > a ? u.at : a), "") };
    }).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)),
  };
}
