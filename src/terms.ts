/**
 * Categories and tags for a new blog post. The rule: use the site's EXISTING categories / tags. A new one is only
 * created when the person agreed to it; until then it is a suggestion, and the post gets the most relevant existing
 * category instead (so it is never left without one).
 */
export interface Term { id: number; name: string; slug?: string; count?: number }
export interface TermChoice {
  categories: string[];                                   // names to send (existing, or new ones the person approved)
  tags: string[];
  create: string[];                                       // approved new names (the plugin's create_terms)
  suggestedNew: { categories: string[]; tags: string[] }; // new names waiting for the person's yes
  fallbackCategory?: string;                              // set when the most relevant existing category was used instead
}

const STOP = new Set("a an and are as at be by for from how in into is it its of on or that the this to with your you our we what why when which will can do does vs".split(" "));
const words = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").split(/[^a-z0-9À-￿]+/).filter((w) => w.length > 2 && !STOP.has(w));
const stem = (w: string) => w.replace(/(ing|ies|es|s)$/, "");
const norm = (s: string) => s.trim().toLowerCase();
const slug = (s: string) => norm(s).replace(/[^a-z0-9À-￿]+/g, "-").replace(/^-|-$/g, "");

function find(list: Term[], name: string): Term | undefined {
  const n = norm(name), sl = slug(name);
  return list.find((t) => norm(t.name) === n || (t.slug ?? slug(t.name)) === sl);
}

/** Existing terms ranked by how well their names match the text (title, headings, suggested names). */
export function rankTerms(list: Term[], text: string): (Term & { score: number })[] {
  const have = new Set(words(text).map(stem));
  return list
    .map((t) => ({ ...t, score: words(t.name).map(stem).filter((w) => have.has(w)).length }))
    .sort((a, b) => b.score - a.score || (b.count ?? 0) - (a.count ?? 0));
}

export function chooseTerms(a: { categories: string[]; tags: string[]; approvedNew: string[]; title: string; content: string },
  existing: { categories: Term[]; tags: Term[] }): TermChoice {
  const ok = new Set(a.approvedNew.map(norm));
  const out: TermChoice = { categories: [], tags: [], create: [], suggestedNew: { categories: [], tags: [] } };
  for (const [key, list] of [["categories", existing.categories], ["tags", existing.tags]] as const) {
    for (const name of a[key]) {
      if (!name.trim()) continue;
      const hit = find(list, name);
      if (hit) { if (!out[key].includes(hit.name)) out[key].push(hit.name); continue; }
      if (ok.has(norm(name))) { out[key].push(name.trim()); out.create.push(name.trim()); continue; }
      out.suggestedNew[key].push(name.trim());
    }
  }
  if (!out.categories.length) {
    const headings = (a.content.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi) ?? []).join(" ");
    const real = existing.categories.filter((c) => norm(c.name) !== "uncategorized" && (c.slug ?? "") !== "uncategorized");
    const best = rankTerms(real, [a.title, a.title, headings, ...out.suggestedNew.categories].join(" "))[0];
    const pick = best && (best.score > 0 || (best.count ?? 0) > 0) ? best : existing.categories.find((c) => (c.slug ?? slug(c.name)) === "uncategorized") ?? best;
    if (pick) { out.categories.push(pick.name); out.fallbackCategory = pick.name; }
  }
  return out;
}
