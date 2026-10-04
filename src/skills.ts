import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agent Skills (SKILL.md folders, the open format used by github.com/WordPress/agent-skills).
 * The model only sees each skill's name + description in its instructions; it loads the full text (and the files in
 * references/) on demand with the load_skill tool. Drop more skill folders into ./skills to add knowledge - no code change.
 * Scripts inside skills are never executed here.
 */
export interface SkillInfo { name: string; description: string; files: string[]; folder: string }

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export class Skills {
  constructor(private dir = process.env.LC_SKILLS_DIR || DEFAULT_DIR) {}

  list(): SkillInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: SkillInfo[] = [];
    for (const d of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(this.dir, d.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const fm = frontmatter(fs.readFileSync(file, "utf8"));
      const refs = path.join(this.dir, d.name, "references");
      const files = fs.existsSync(refs) ? fs.readdirSync(refs).filter((f) => f.endsWith(".md")).map((f) => "references/" + f) : [];
      out.push({ name: fm.name || d.name, description: fm.description || "", files, folder: d.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** SKILL.md (default) or one of its references/*.md files. */
  load(name: string, file?: string): { ok: true; name: string; file: string; content: string; otherFiles: string[] } {
    const skill = this.list().find((s) => s.name === name);
    if (!skill) throw new Error(`Unknown skill "${name}". Available: ${this.list().map((s) => s.name).join(", ") || "none"}.`);
    const rel = file ? file.replace(/\\/g, "/") : "SKILL.md";
    if (rel !== "SKILL.md" && !skill.files.includes(rel)) throw new Error(`"${rel}" is not part of ${name}. Files: SKILL.md, ${skill.files.join(", ")}`);
    const content = fs.readFileSync(path.join(this.dir, skill.folder, rel), "utf8").slice(0, 40_000);
    return { ok: true, name, file: rel, content, otherFiles: skill.files };
  }

  /** One line per skill for the system prompt. */
  catalogue(): string {
    return this.list().map((s) => `- ${s.name}: ${s.description}`).join("\n");
  }
}
