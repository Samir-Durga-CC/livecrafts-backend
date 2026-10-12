/** The "New blog post" form's request, as the chat message it sends (no React here: the tests use it too). */
export type ImageMode = "ai" | "upload" | "library" | "none";
export interface BlogRequest {
  title: string; tone: string; words: number; image: ImageMode;
  imageIdea?: string; mediaId?: number; mediaAlt?: string; notes?: string;
  /** Existing categories the person picked (empty = the assistant picks the most relevant one). */
  categories?: string[];
  /** The person allows new categories / tags when no existing one fits (otherwise they are asked first). */
  allowNewTerms?: boolean;
}

export const TONES = ["Professional", "Friendly", "Casual", "Formal", "Persuasive"] as const;
export const LENGTHS = [500, 800, 1200, 1500] as const;

/** The chat message the form sends: plain words, so the person can read (and later edit) what was asked. */
export function blogPrompt(r: BlogRequest): string {
  const image = r.image === "ai" ? `generate one with AI${r.imageIdea?.trim() ? ` (${r.imageIdea.trim()})` : ""}`
    : r.image === "upload" ? "use the attached image"
    : r.image === "library" ? `use Media Library image #${r.mediaId}${r.mediaAlt ? ` (“${r.mediaAlt}”)` : ""}`
    : "no featured image";
  return [
    "Write a new blog post and save it as a draft.",
    `Title: ${r.title.trim()}`,
    `Tone: ${r.tone.trim() || "Professional"}`,
    `Length: about ${r.words} words`,
    `Featured image: ${image}`,
    ...(r.notes?.trim() ? [`Notes: ${r.notes.trim()}`] : []),
    r.categories?.length ? `Category: ${r.categories.join(", ")} (chosen by me)` : "Category: pick the most relevant existing one",
    r.allowNewTerms ? "New categories and tags: allowed if no existing one fits - I agree to add them." : "New categories and tags: ask me first; until then use existing ones.",
    "Add an SEO meta description, an excerpt and tags.",
  ].join("\n");
}
