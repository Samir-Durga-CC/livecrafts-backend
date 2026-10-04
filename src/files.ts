import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { newId } from "./store.js";

export interface FileMeta { id: string; filename: string; mime: string; bytes: number; createdAt: string }

/** Files the user attaches in the chat (images from the local gallery). Kept on disk until the agent uploads them to WordPress. */
export class FileStore {
  private dir = path.join(config.dataDir, "uploads");
  constructor() { fs.mkdirSync(this.dir, { recursive: true }); }

  save(buf: Buffer, filename: string, mime: string): FileMeta {
    if (!/^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/.test(mime)) throw new Error("Only image files can be attached (png, jpg, gif, webp, avif, svg).");
    const id = newId("file");
    const meta: FileMeta = { id, filename: path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_") || "image", mime, bytes: buf.length, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, id + ".bin"), buf);
    fs.writeFileSync(path.join(this.dir, id + ".json"), JSON.stringify(meta));
    return meta;
  }

  read(id: string): { meta: FileMeta; buf: Buffer } {
    if (!/^file_[a-f0-9]+$/.test(id)) throw new Error("Unknown file id.");
    try {
      return { meta: JSON.parse(fs.readFileSync(path.join(this.dir, id + ".json"), "utf8")), buf: fs.readFileSync(path.join(this.dir, id + ".bin")) };
    } catch { throw new Error("Unknown file id (it may have expired)."); }
  }
}
