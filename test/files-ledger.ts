/**
 * Theme-file edits live in the SITE's change ledger (the plugin), not in a store of this server:
 * the write passes who/what it belongs to, a broken page rolls the change out of the history, restore_file goes through the
 * ledger, the edits show up as changes of the chat (revertable like any other), and a revert made elsewhere shows here.
 */
import assert from "node:assert/strict";
import { SiteFiles, sha1, type Backup } from "../src/sitefiles.js";
import { JsonStore } from "../src/store.js";
import { recordsFor, reconcile } from "../src/changes.js";
import { WRITE_TOOLS } from "../src/tools.js";
import type { FileOpts, RemoteFiles } from "../src/hostinger.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let n = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);

/** A fake plugin: a file system + a ledger, answering like the real theme-file routes. */
function fakePlugin() {
  const files = new Map<string, string>();
  const ledger: any[] = [];
  const calls: { op: string; rel: string; o?: FileOpts }[] = [];
  const record = (rel: string, before: string | null, after: string | null, o?: FileOpts) => {
    const c = { id: ++n, status: "live", kind: "file.write", target: rel, summary: `${before === null ? "Create" : after === null ? "Delete" : "Edit"} ${rel}`, object: { type: "file", id: 0, label: "Theme file " + rel }, at: new Date().toISOString(), ref: o?.ref ?? "", reverts: null as number | null, payload: { before, after } };
    ledger.push(c); return c;
  };
  const remote: RemoteFiles = {
    list: async () => [], readViaApi: async (rel) => files.get(rel) ?? "", upload: async () => { throw new Error("no hosting fallback"); },
    readExact: async (rel) => (files.has(rel) ? { content: files.get(rel)!, sha1: sha1(files.get(rel)!) } : null),
    write: async (rel, content, expected, o) => {
      calls.push({ op: "write", rel, o });
      const before = files.get(rel) ?? null;
      assert.equal(expected, before === null ? "new" : sha1(before));
      files.set(rel, content);
      if (o?.rollbackOf) { const c = ledger.find((x) => x.id === o.rollbackOf)!; c.status = "discarded"; return { change: null }; }
      return { change: record(rel, before, content, o) };
    },
    remove: async (rel, s, o) => {
      calls.push({ op: "remove", rel, o });
      const before = files.get(rel)!; assert.equal(s, sha1(before)); files.delete(rel);
      if (o?.rollbackOf) { ledger.find((x) => x.id === o.rollbackOf)!.status = "discarded"; return { change: null }; }
      return { change: record(rel, before, null, o) };
    },
    revert: async (id) => {
      calls.push({ op: "revert", rel: String(id) });
      const c = ledger.find((x) => x.id === id)!; const p = c.payload;
      if (p.before === null) files.delete(c.target); else files.set(c.target, p.before);
      const r = record(c.target, p.after, p.before); r.reverts = id; return { ok: true, change: r };
    },
  };
  return { files, ledger, calls, remote };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-ledger-"));
const rel = "wp-content/themes/t/style.css", part = "wp-content/themes/t/part.php";
const make = (p: ReturnType<typeof fakePlugin>, page: () => Response) =>
  new SiteFiles({ siteId: "s", siteUrl: "https://x.test", remote: p.remote, backups: new JsonStore<Backup>(dir), fetchImpl: (async () => page()) as any, ref: () => "job_1#2" });
const goodPage = () => new Response("<html><body>fine</body></html>", { status: 200 });

(async () => {
  console.log("an edit is recorded in the site's ledger");
  const p = fakePlugin();
  p.files.set(rel, "a{color:red}\n");
  const sf = make(p, goodPage);
  const r: any = await sf.edit(rel, "red", "blue", "https://x.test/");
  assert.ok(r.ok && r.change?.id && r.change.summary === `Edit ${rel}`); ok("edit_file returns the ledger change");
  assert.equal(p.calls[0].o?.ref, "job_1#2"); ok("…with the chat/request it belongs to");
  assert.equal(sf.getBackup(r.backupId)?.changeId, r.change.id); ok("the local backup only points at the ledger entry");

  console.log("the chat gets a revertable record");
  assert.ok(WRITE_TOOLS.has("edit_file") && WRITE_TOOLS.has("create_file") && WRITE_TOOLS.has("restore_file"));
  const recs = recordsFor("edit_file", {}, r);
  assert.equal(recs.length, 1); assert.equal(recs[0].pluginId, r.change.id); assert.deepEqual(recs[0].revert, { kind: "plugin" }); ok("edit_file becomes a change of the chat that reverts through the plugin");

  console.log("restore_file goes through the ledger");
  const back: any = await sf.restore(r.backupId, "https://x.test/");
  assert.ok(back.ok && p.files.get(rel) === "a{color:red}\n" && p.calls.at(-1)!.op === "revert"); ok("the plugin undid it (no second copy of the truth)");

  console.log("a broken page rolls the change out of the history");
  const broken = fakePlugin();
  broken.files.set(rel, "a{color:red}\n");
  let hits = 0;
  const flaky = make(broken, () => (++hits > 1 ? new Response("boom", { status: 500 }) : goodPage())); // healthy before, broken after
  const bad: any = await flaky.edit(rel, "red", "blue", "https://x.test/");
  assert.equal(bad.ok, false); assert.equal(bad.rolledBack, true);
  assert.equal(broken.files.get(rel), "a{color:red}\n"); assert.equal(broken.ledger.length, 1); assert.equal(broken.ledger[0].status, "discarded");
  assert.equal(broken.calls.at(-1)!.o?.rollbackOf, broken.ledger[0].id); ok("file restored, the ledger entry is dropped - nothing pending");
  assert.equal(recordsFor("edit_file", {}, bad).length, 0); ok("and the chat records no change");

  console.log("created file: break -> removed through the ledger");
  const mk = fakePlugin(); let h2 = 0;
  const flaky2 = make(mk, () => (++h2 > 1 ? new Response("boom", { status: 500 }) : goodPage()));
  const created: any = await flaky2.create(part, "<?php echo 1;", "https://x.test/");
  assert.equal(created.ok, false); assert.equal(mk.files.has(part), false); assert.equal(mk.ledger[0].status, "discarded"); ok("the new file is gone and its entry dropped");

  console.log("a revert made elsewhere shows in the chat");
  const mine = recordsFor("edit_file", {}, r).concat();
  const ledger = [{ ...r.change, status: "live" }, { id: 999, status: "live", reverts: r.change.id, at: "2026-10-08T10:00:00Z" }];
  assert.equal(reconcile(mine, ledger), true); assert.ok(mine[0].revertedAt); ok("reverted in the widget/wp-admin -> marked reverted here");
  const drafted = recordsFor("edit_file", {}, r); drafted[0].status = "draft";
  assert.equal(reconcile(drafted, [{ id: r.change.id, status: "live" }]), true); assert.equal(drafted[0].status, "live"); ok("deployed elsewhere -> status follows");
  const dropped = recordsFor("edit_file", {}, r);
  assert.equal(reconcile(dropped, [{ id: r.change.id, status: "discarded", updated: "2026-10-08T11:00:00Z" }]), true); assert.ok(dropped[0].revertedAt); ok("dropped by Discard all -> marked reverted here");
  assert.equal(reconcile(recordsFor("edit_file", {}, r), [{ id: r.change.id, status: "live" }]), false); ok("nothing to update -> no write");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nall passed");
})().catch((e) => { console.error(e); process.exit(1); });
