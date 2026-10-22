/**
 * PageSpeed reports: Google PageSpeed Insights (fake Google with a REAL Lighthouse result recorded from a WordPress
 * site), the local-Lighthouse route for localhost sites, the run manager and history, the backend routes (also from
 * the widget), the Google key setting, the assistant's pagespeed_report tool, and the app's report helpers.
 * The real-visitor numbers (loadingExperience) in these tests are made up for the test.
 * Run:  node --import tsx test/pagespeed.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-speed-"));
delete process.env.LC_PAGESPEED_API_KEY;
process.env.LC_VERIFY_CHANGES = "0";
const ps = await import("../src/pagespeed.js");
const { needsLocalRun, normalize, runGoogle, SpeedRuns, sameHost, pageKey, plain, fixAllPrompt, PSI_ENDPOINT } = ps;
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { createApp } = await import("../src/server.js");
const { secrets } = await import("../src/secrets.js");
const { savingsLabel, delta, scoreTone, whenLabel, reportHtml } = await import("../web/src/speed.js");
const { call, say, mockModel } = await import("./mockModel.js");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };
const LHR = JSON.parse(fs.readFileSync(new URL("./fixtures/lighthouse-mobile.json", import.meta.url), "utf8"));
const FIELD = { // made-up real-visitor data in Google's format (CLS percentile is x100)
  metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3800, category: "SLOW" }, INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 21, category: "SLOW" }, FIRST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: "AVERAGE" },
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\n1) where a report runs");
{
  for (const u of ["http://localhost/livecrafts-test/", "http://127.0.0.1:8080/", "http://192.168.1.20/", "http://10.0.0.5/x", "http://172.20.1.1/", "http://mysite.local/", "http://shop.test/", "http://[::1]/", "http://intranet/"]) assert.equal(needsLocalRun(u), true, u);
  for (const u of ["https://example.com/", "https://project-in-progress.com/experiment1/", "http://172.32.0.1/", "https://8.8.8.8/"]) assert.equal(needsLocalRun(u), false, u);
  ok("localhost, *.local / *.test and private addresses run locally; public sites go to Google");
  assert.equal(sameHost("https://example.com", "https://www.example.com/blog/"), true);
  assert.equal(sameHost("https://example.com", "https://evil.com/?u=example.com"), false);
  assert.equal(sameHost("http://localhost/site", "javascript:alert(1)"), false);
  assert.equal(pageKey("https://Example.com/a/?utm_source=x#top"), pageKey("https://example.com/a"));
  ok("only pages of the connected site; one page = same address without slash, hash or tracking parameters");
}

console.log("\n2) a real Lighthouse result becomes a small report");
{
  const r = normalize(LHR, { device: "mobile", url: "https://example.test/hello-world/", source: "google" });
  for (const k of ["performance", "accessibility", "bestPractices", "seo"] as const) assert.ok(typeof r.scores[k] === "number" && r.scores[k]! >= 0 && r.scores[k]! <= 100, k);
  assert.deepEqual(r.lab.map((m) => m.id), ["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "first-contentful-paint", "speed-index"]);
  assert.ok(r.lab.every((m) => m.display && m.display !== "-" && m.rating));
  assert.equal(r.field.scope, null);
  ok("four scores 0-100 and the five lab metrics with values and ratings");
  assert.ok(r.fixes.length >= 3 && r.fixes.length <= 12);
  const perf = r.fixes.filter((f) => f.category === "performance");
  assert.ok(perf.length && r.fixes.indexOf(perf[0]) === 0, "speed fixes first");
  for (let i = 1; i < perf.length; i++) assert.ok(perf[i - 1].savingsMs + perf[i - 1].savingsCls * 4000 >= perf[i].savingsMs + perf[i].savingsCls * 4000, "sorted by saving");
  assert.ok(r.fixes.every((f) => !/\]\(http|`/.test(f.title + f.detail)), "no markdown left");
  assert.ok(r.fixes.every((f) => f.prompt.includes(f.id) && f.prompt.includes("https://example.test/hello-world/") && f.prompt.includes("(mobile)")));
  const lcp = r.fixes.find((f) => f.id === "largest-contentful-paint-element");
  assert.ok(lcp?.items[0]?.selector, "the LCP element is named (nested table)");
  ok("fixes: speed first, sorted by time saved, plain text, affected elements, a chat message each");
  const comp = r.fixes.find((f) => f.id === "uses-text-compression");
  if (comp) { assert.equal(comp.assistant, false); assert.match(comp.prompt, /plugin, theme or hosting setting[\s\S]*Do not change anything without asking/); }
  if (lcp) { assert.equal(lcp.assistant, true); assert.match(lcp.prompt, /draft changes/); }
  ok("server / cache fixes are explained, not changed; content fixes become draft changes");
  assert.equal(plain("Serve images. [Learn more](https://x.dev/a). Use `loading=lazy`."), "Serve images. . Use loading=lazy.".replace(" . ", " "));
  const all = fixAllPrompt(r);
  assert.match(all, /Propose a short plan first/);
  assert.ok(r.fixes.filter((f) => f.assistant).slice(0, 6).every((f) => all.includes(f.id)));
  ok("“Fix all” lists only what the assistant can change and asks for a plan first");
}

console.log("\n3) Google PageSpeed Insights (fake Google, real Lighthouse result)");
{
  const asked: URL[] = [];
  const fake = (status: number, body: unknown): typeof fetch => (async (u: any) => { asked.push(new URL(String(u))); return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }) as any;
  const r = await runGoogle("https://example.com/a/", "mobile", "AIzaTEST", fake(200, { lighthouseResult: LHR, loadingExperience: FIELD }));
  const q = asked.at(-1)!;
  assert.equal(q.origin + q.pathname, PSI_ENDPOINT);
  assert.equal(q.searchParams.get("url"), "https://example.com/a/");
  assert.equal(q.searchParams.get("strategy"), "mobile");
  assert.deepEqual(q.searchParams.getAll("category"), ["performance", "accessibility", "best-practices", "seo"]);
  assert.equal(q.searchParams.get("key"), "AIzaTEST");
  ok("the request: page, device, all four categories, the API key");
  assert.equal(r.source, "google");
  assert.equal(r.field.scope, "page");
  const f = Object.fromEntries(r.field.metrics.map((m) => [m.id, m]));
  assert.equal(f.LARGEST_CONTENTFUL_PAINT_MS.display, "3.8 s"); assert.equal(f.LARGEST_CONTENTFUL_PAINT_MS.rating, "poor");
  assert.equal(f.INTERACTION_TO_NEXT_PAINT.display, "180 ms"); assert.equal(f.INTERACTION_TO_NEXT_PAINT.rating, "good");
  assert.equal(f.CUMULATIVE_LAYOUT_SHIFT_SCORE.display, "0.21");
  assert.equal(f.FIRST_CONTENTFUL_PAINT_MS.rating, "needs-improvement");
  ok("real-visitor Core Web Vitals: LCP 3.8 s, INP 180 ms, CLS 0.21 (Google sends it x100), ratings");
  const site = await runGoogle("https://example.com/a/", "desktop", "", fake(200, { lighthouseResult: LHR, loadingExperience: { ...FIELD, origin_fallback: true }, originLoadingExperience: FIELD }));
  assert.equal(site.field.scope, "site");
  assert.equal(asked.at(-1)!.searchParams.has("key"), false);
  ok("too little traffic on the page: the whole site's numbers, marked as such; no key = no key parameter");
  const err = async (status: number, body: unknown, key = "") => runGoogle("https://example.com/", "mobile", key, fake(status, body)).then(() => "", (e: Error) => e.message);
  assert.match(await err(429, { error: { message: "Quota exceeded for quota metric 'Queries'" } }), /without an API key[\s\S]*Integrations → PageSpeed/);
  assert.match(await err(429, { error: { message: "Quota exceeded" } }, "AIzaX"), /daily PageSpeed limit/);
  assert.match(await err(400, { error: { message: "API key not valid. Please pass a valid API key." } }, "AIzaX"), /key is not valid/);
  assert.match(await err(500, { error: { message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page" } }), /could not load the page/);
  assert.match(await runGoogle("https://example.com/", "mobile", "", (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as any).then(() => "", (e) => e.message), /did not answer within two minutes/);
  ok("errors in plain words: no key / daily limit / bad key / page not loadable / timeout");
}

console.log("\n4) runs and history");
{
  const calls: string[] = [];
  const google = async (url: string, device: any) => { calls.push(`google ${device} ${url}`); await sleep(30); return normalize(LHR, { device, url, source: "google", loading: FIELD }); };
  const local = async (url: string, device: any) => { calls.push(`local ${device} ${url}`); await sleep(10); const r = normalize(LHR, { device, url, source: "local" }); r.warnings.unshift("Local test"); return r; };
  const runs = new SpeedRuns({ apiKey: () => "", google: google as any, local: local as any }, path.join(process.env.LC_DATA_DIR!, "ps1"));
  const a = runs.start("site_a", "https://example.com/p/", ["mobile", "desktop"]);
  assert.equal(a.status, "running");
  assert.equal(runs.history("site_a")[0].status, "running");
  const done = (await runs.wait(a.id))!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.reports.map((r) => r.device), ["mobile", "desktop"]);
  assert.equal(done.source, "google");
  ok("Google: both devices in parallel; the run is saved while running and when done");
  const b = runs.start("site_a", "http://localhost/site/", ["mobile", "desktop"]);
  assert.equal(b.source, "local");
  await runs.wait(b.id);
  assert.deepEqual(calls.slice(-2), ["local mobile http://localhost/site/", "local desktop http://localhost/site/"]);
  ok("localhost: Lighthouse on this machine, one device after the other");
  const failing = new SpeedRuns({ apiKey: () => "", google: (async () => { throw new Error("Google could not load the page"); }) as any }, path.join(process.env.LC_DATA_DIR!, "ps2"));
  const c = await failing.wait(failing.start("site_a", "https://example.com/x", ["mobile"]).id);
  assert.equal(c!.status, "failed"); assert.match(c!.error!, /could not load/);
  ok("a failed run keeps the reason");
  assert.deepEqual(runs.history("site_a", "https://example.com/p").map((r) => r.id), [a.id]);
  assert.equal(runs.history("site_b").length, 0);
  ok("history per site and per page, newest first");
  const store = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "ps3"));
  store.put({ id: "speed_aaaaaaaaaaaa", siteId: "s", url: "https://e.com/", devices: ["mobile"], status: "running", source: "google", startedAt: new Date().toISOString(), reports: [] });
  const after = new SpeedRuns({ apiKey: () => "" }, path.join(process.env.LC_DATA_DIR!, "ps3"));
  assert.equal(after.history("s")[0].status, "failed");
  assert.match(after.history("s")[0].error!, /backend restarted/);
  ok("a run cut off by a backend restart shows as failed, not running forever");
  const many = new SpeedRuns({ apiKey: () => "", google: google as any }, path.join(process.env.LC_DATA_DIR!, "ps4"));
  for (let i = 0; i < 33; i++) await many.wait(many.start("s", "https://example.com/" + i, ["mobile"]).id);
  assert.equal(many.history("s", undefined, 100).length, 30);
  ok("keeps the 30 newest reports per site");
}

console.log("\n5) the backend routes (app and widget) and the Google key");
{
  const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
  const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
  sites.put({ id: "site_x", name: "X", url: "https://example.com", username: "a", appPassword: "b", createdAt: new Date().toISOString() });
  sites.put({ id: "site_y", name: "Y", url: "https://other.com", username: "a", appPassword: "b", createdAt: new Date().toISOString() });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const speed = new SpeedRuns({ apiKey: () => secrets.pagespeedKey(), google: (async (url: string, device: any, key: string) => { await gate; const r = normalize(LHR, { device, url, source: "google" }); r.warnings.push("key=" + key); return r; }) as any }, path.join(process.env.LC_DATA_DIR!, "ps5"));
  const files = new FileStore();
  const app = createApp(new JobRunner(jobs, sites, buildAgent(files, { model: mockModel(async () => say("x")), hostinger: null, browser: null, speed })), sites, files, { speed });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const j = async (method: string, p: string, body?: unknown, widget = false) => {
    const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(widget ? { "X-Livecrafts-Widget": "open" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  let r = await j("POST", "/sites/site_x/pagespeed", { url: "https://evil.com/", device: "mobile" });
  assert.equal(r.status, 400); assert.match(r.body.error, /Only pages of this site/);
  r = await j("POST", "/sites/site_x/pagespeed", { url: "https://example.com/about/", device: "both" }, true);
  assert.equal(r.status, 202); assert.equal(r.body.status, "running"); assert.deepEqual(r.body.devices, ["mobile", "desktop"]);
  const id = r.body.id;
  const again = await j("POST", "/sites/site_x/pagespeed", { url: "https://example.com/about", device: "mobile" }, true);
  assert.equal(again.status, 409);
  ok("start from the widget (202, both devices); other sites' pages refused; one run per page at a time");
  release();
  await speed.wait(id);
  const run = await j("GET", `/sites/site_x/pagespeed/${id}`, undefined, true);
  assert.equal(run.status, 200); assert.equal(run.body.status, "done"); assert.equal(run.body.reports.length, 2);
  assert.equal(typeof run.body.reports[0].fixAllPrompt, "string");
  assert.equal((await j("GET", `/sites/site_y/pagespeed/${id}`, undefined, true)).status, 404);
  const hist = await j("GET", "/sites/site_x/pagespeed?url=" + encodeURIComponent("https://example.com/about/"), undefined, true);
  assert.equal(hist.body.runs[0].id, id); assert.equal(hist.body.runs[0].scores.length, 2); assert.equal(hist.body.local, false);
  assert.equal(hist.body.google.keySource, "none");
  ok("poll the run, the history with scores per device; a run of another site is not found");
  assert.equal((await j("PUT", "/integrations/pagespeed", { apiKey: "AIzaSyA-real-looking-key_123456" }, true)).status, 403, "the widget cannot change the key");
  assert.equal((await j("PUT", "/integrations/pagespeed", { apiKey: "hello" })).status, 400);
  const saved = await j("PUT", "/integrations/pagespeed", { apiKey: "AIzaSyA-real-looking-key_123456" });
  assert.equal(saved.body.pagespeed.keySource, "saved");
  assert.equal((await j("GET", "/integrations")).body.pagespeed.keySource, "saved");
  assert.ok(!JSON.stringify((await j("GET", "/integrations")).body).includes("real-looking"), "the key is never sent back");
  const keyed = await j("POST", "/sites/site_x/pagespeed", { url: "https://example.com/", device: "mobile" });
  const kr = (await speed.wait(keyed.body.id))!;
  assert.ok(kr.reports[0].warnings.includes("key=AIzaSyA-real-looking-key_123456"), "the saved key is used");
  process.env.LC_PAGESPEED_API_KEY = "AIzaFromEnv_0000000000000";
  assert.equal((await j("PUT", "/integrations/pagespeed", { apiKey: "AIzaSyA-another-key_1234567" })).status, 409);
  delete process.env.LC_PAGESPEED_API_KEY;
  assert.equal((await j("DELETE", "/integrations/pagespeed")).body.pagespeed.keySource, "none");
  ok("Google key: saved on the backend, used for reports, never sent back, .env wins, the widget cannot change it");
  app.close();
}

console.log("\n6) the assistant's pagespeed_report tool");
{
  const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites2"));
  const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs2"));
  const site = sites.put({ id: "site_t", name: "T", url: "https://example.com", username: "a", appPassword: "b", createdAt: new Date().toISOString() });
  const seen: string[] = [];
  const speed = new SpeedRuns({ apiKey: () => "", google: (async (url: string, device: any) => { seen.push(`${device} ${url}`); return normalize(LHR, { device, url, source: "google", loading: FIELD }); }) as any }, path.join(process.env.LC_DATA_DIR!, "ps6"));
  const results: any[] = [];
  const model = mockModel(async ({ prompt }) => {
    const res = prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content).filter((p: any) => p.type === "tool-result" && p.toolName === "pagespeed_report").map((p: any) => p.output.value);
    if (res.length === 0) return call("pagespeed_report", { device: "both" });
    if (res.length === 1) { results.push(res[0]); return call("pagespeed_report", { url: "https://evil.com/" }); }
    results.push(res[1]);
    return say("Performance is low on mobile.");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(new FileStore(), { model, hostinger: null, browser: null, speed }));
  const job = runner.create(site.id, "How fast is this page?", "", [], { approvalMode: "auto", pageUrl: "https://example.com/services/" });
  const j = await runner.waitUntilSettled(job.id);
  assert.equal(j.status, "completed");
  assert.deepEqual(seen, ["mobile https://example.com/services/", "desktop https://example.com/services/"]);
  const out = results[0];
  assert.equal(out.ok, true); assert.equal(out.reports.length, 2);
  assert.ok(out.reports[0].scores.performance !== undefined && out.reports[0].fixes.length);
  assert.match(String(out.reports[0].field.metrics[0]), /Largest Contentful Paint \(LCP\): 3\.8 s \(poor\)/);
  assert.ok(out.reports[0].fixes.some((f: any) => f.assistantCanFix === true));
  assert.equal(results[1].ok, false);
  assert.equal(speed.history(site.id).length, 1, "the chat's report is in the Speed tab history too");
  ok("in chat: tests the page the person is on (both devices), returns scores, vitals and fixes; other sites refused");
}

console.log("\n7) the app's report helpers");
{
  assert.equal(scoreTone(95), "good"); assert.equal(scoreTone(62), "ok"); assert.equal(scoreTone(41), "bad"); assert.equal(scoreTone(null), "none");
  assert.equal(savingsLabel({ savingsMs: 1240, savingsCls: 0, savingsBytes: 0 }), "−1.2 s");
  assert.equal(savingsLabel({ savingsMs: 450, savingsCls: 0, savingsBytes: 0 }), "−450 ms");
  assert.equal(savingsLabel({ savingsMs: 0, savingsCls: 0.2, savingsBytes: 0 }), "less jumping");
  assert.equal(savingsLabel({ savingsMs: 0, savingsCls: 0, savingsBytes: 300_000 }), "−293 KB");
  assert.equal(savingsLabel({ savingsMs: 20, savingsCls: 0, savingsBytes: 100 }), "");
  assert.equal(delta(70, 62), "+8"); assert.equal(delta(50, 62), "−12"); assert.equal(delta(62, 62), ""); assert.equal(delta(70, undefined), "");
  const now = new Date("2026-10-16T12:00:00");
  assert.match(whenLabel("2026-10-16T09:05:00", now), /^Today /); assert.match(whenLabel("2026-10-15T17:05:00", now), /^Yesterday /);
  ok("score colours (Google's bands), savings badges, before/after change, dates");
  const rep = normalize(LHR, { device: "mobile", url: "https://example.com/<b>x</b>", source: "google", loading: FIELD });
  const html = reportHtml({ url: "https://example.com/<b>x</b>", startedAt: "2026-10-16T09:05:00Z", source: "google", reports: [rep] }, "Shop & Co");
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes("Shop &amp; Co") && !html.includes("<b>x</b>"), "escaped");
  assert.match(html, /Core Web Vitals[\s\S]*real visitors, last 28 days[\s\S]*Lab test[\s\S]*What to fix/);
  assert.match(html, /class="band"/); assert.match(html, /Livecrafts assistant can fix|Hosting \/ plugin setting/); assert.match(html, /class="verdict"/);
  assert.match(html, /@media print/);
  ok("the printable report (Print / PDF): escaped, real visitors, lab test, fixes, print styles");
}

console.log(`\n${passed} checks passed.`);
process.exit(0);
