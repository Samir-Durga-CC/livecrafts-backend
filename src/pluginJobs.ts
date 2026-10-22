/**
 * Plugin updates as a background job with progress (plugin 0.19.1+):
 *   prepare (checks + backup) -> install (download, swap, check, restore if broken) -> done.
 * If the install request is cut off (host time limit, lost connection), the job calls the plugin's recover.php, which
 * starts WordPress without plugins and finishes or undoes the update. The widget polls the job; the chat tool awaits it.
 * An older plugin (0.19.0) ignores "step" and answers "prepare" with the finished result - that is used as is.
 */
import { Bridge, BridgeError, type PluginActionResult } from "./bridge.js";
import { newId } from "./store.js";

export type PluginJobPhase = "preparing" | "installing" | "recovering" | "done";
export interface PluginJob {
  id: string; siteId: string; plugin: string; name?: string; from?: string; to?: string;
  phase: PluginJobPhase; startedAt: string; finishedAt?: string; result?: PluginActionResult; error?: string;
}

export class PluginJobs {
  private jobs = new Map<string, PluginJob>();
  private running = new Map<string, Promise<PluginJob>>();

  start(siteId: string, bridge: Bridge, plugin: string): PluginJob {
    this.prune();
    const busy = [...this.jobs.values()].find((j) => j.siteId === siteId && j.phase !== "done");
    if (busy) throw Object.assign(new Error(`An update of ${busy.name ?? busy.plugin} is still running on this site.`), { status: 409 });
    const job: PluginJob = { id: newId("plj"), siteId, plugin, phase: "preparing", startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.running.set(job.id, this.run(job, bridge).finally(() => this.running.delete(job.id)));
    return job;
  }
  get(id: string) { return this.jobs.get(id); }
  wait(id: string): Promise<PluginJob | undefined> { return this.running.get(id) ?? Promise.resolve(this.jobs.get(id)); }

  private async run(job: PluginJob, b: Bridge): Promise<PluginJob> {
    const finish = (r: Partial<Pick<PluginJob, "result" | "error">>) => { Object.assign(job, r, { phase: "done", finishedAt: new Date().toISOString() }); return job; };
    let prep: any;
    try { prep = await b.updatePluginStep(job.plugin, "prepare"); }
    catch (e) { return finish({ error: (e as Error).message }); }
    if (!prep?.job) return finish({ result: prep as PluginActionResult });           // older plugin: already done in one go
    Object.assign(job, { name: prep.name, from: prep.from, to: prep.to, phase: "installing" });
    try {
      return finish({ result: await b.updatePluginStep(job.plugin, "install", prep.job) });
    } catch (e) {
      // the plugin answered with a clear refusal: nothing was changed
      if (e instanceof BridgeError && e.status >= 400 && e.status < 500 && e.code !== "not_json") return finish({ error: e.message });
      // cut off / no answer: let recover.php look at the site and finish or undo the update
      job.phase = "recovering";
      for (let i = 0; i < 3; i++) {
        try { return finish({ result: await b.recoverPlugin(prep.recoverUrl, prep.job, prep.key) }); }
        catch (r) {
          if (r instanceof BridgeError && r.code === "gone") return finish({ error: "The update finished on the site, but its result was not received. Open the plugin list again to see the version." });
          if (i < 2) await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
          else return finish({ error: `The site did not answer while updating ${job.name ?? job.plugin} (${(e as Error).message}) and the repair could not run (${(r as Error).message}). A backup of ${job.from} is saved: open More → Plugins and use Roll back, or restore it from your hosting backup.` });
        }
      }
      return finish({ error: "unreachable" });
    }
  }

  private prune() {
    const cut = Date.now() - 60 * 60 * 1000;
    for (const [id, j] of this.jobs) if (j.phase === "done" && Date.parse(j.finishedAt ?? j.startedAt) < cut) this.jobs.delete(id);
  }
}

let shared: PluginJobs | null = null;
export const pluginJobs = () => (shared ??= new PluginJobs());
