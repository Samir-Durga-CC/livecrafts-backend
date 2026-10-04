import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Tiny JSON-file store (one file per record, written atomically). Good enough for development and a single server.
 * The interface is deliberately small so it can be swapped for Postgres without touching the rest of the code.
 */
export class JsonStore<T extends { id: string }> {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private file(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid id");
    return path.join(this.dir, id + ".json");
  }
  get(id: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as T; } catch { return undefined; }
  }
  list(): T[] {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as T);
  }
  put(rec: T): T {
    const tmp = this.file(rec.id) + "." + randomUUID().slice(0, 8) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, this.file(rec.id));
    return rec;
  }
  delete(id: string) { try { fs.unlinkSync(this.file(id)); } catch { /* already gone */ } }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
