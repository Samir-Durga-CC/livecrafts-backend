/**
 * Commands that never need the language model: a short, unambiguous "undo" (English, Hindi, Hinglish). They are
 * answered straight from the Changes ledger - instant, and no tokens. Anything more specific ("revert the header
 * colour to blue") is NOT a quick command: it goes to the assistant.
 */
const UNDO_WORDS = new Set(["undo", "revert", "rollback", "wapas", "vapas", "vaapas", "वापस", "रिवर्ट", "अनडू", "पूर्ववत", "हटा", "हटाओ", "हटादो"]);
const ALL_WORDS = new Set(["all", "everything", "sab", "sabhi", "सब", "सारे", "सभी", "सबकुछ"]);
const FILLER = new Set([
  "please", "can", "you", "could", "the", "that", "it", "this", "last", "latest", "previous", "my", "change", "changes", "request", "edit", "edits", "now", "go", "back", "to", "as", "was", "before",
  "kar", "karo", "do", "de", "dijiye", "dena", "dein", "ye", "yeh", "wo", "woh", "pichla", "pichhla", "badlav", "chhod", "se", "ko", "ka", "ki", "hai", "na", "bhai",
  "कृपया", "इसे", "ये", "यह", "वो", "पिछला", "पिछले", "आखिरी", "बदलाव", "चेंज", "कर", "करो", "दो", "दीजिए", "दें", "दे", "पहले", "जैसा", "जैसे", "को", "का", "की", "है", "से", "कीजिए", "वाला",
]);

export interface QuickCommand { kind: "undo"; all: boolean }

export function quickCommand(text: string): QuickCommand | null {
  const words = text.toLowerCase().replace(/[.,!?;:"'()।]/g, " ").replace(/\bundo\b|\broll back\b/g, (m) => m.replace(" ", "")).split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return null;
  if (!words.some((w) => UNDO_WORDS.has(w)) && !(words.join(" ").includes("पहले जैसा") || words.join(" ").includes("go back"))) return null;
  const rest = words.filter((w) => !UNDO_WORDS.has(w) && !FILLER.has(w) && !ALL_WORDS.has(w));
  if (rest.length) return null;
  return { kind: "undo", all: words.some((w) => ALL_WORDS.has(w)) };
}

/** The reply in the language the person used (Devanagari = Hindi). */
export function undoReply(text: string, outcome: { reverted: number; requests: number } | { error: string } | "nothing"): string {
  const hi = /[ऀ-ॿ]/.test(text) || /\b(wapas|vapas|vaapas|kar do|karo)\b/i.test(text);
  if (outcome === "nothing") return hi ? "वापस करने के लिए कोई बदलाव नहीं है।" : "There is nothing to undo.";
  if ("error" in outcome) return hi ? `वापस नहीं कर पाया: ${outcome.error}` : `I could not undo it: ${outcome.error}`;
  return hi ? `ठीक है, ${outcome.reverted} बदलाव वापस कर दिए। वे ड्राफ़्ट में थे, लाइव साइट पर कुछ नहीं बदला।` : `Done - ${outcome.reverted} change${outcome.reverted === 1 ? "" : "s"} reverted. They were drafts, so the live site was never touched.`;
}
