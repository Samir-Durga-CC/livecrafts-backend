/**
 * Blog posts from a title, end to end (scripted model, fake Livecrafts site, fake image model):
 * the form's prompt, the blog-post skill, list_terms, the three image sources (AI / attached / Media Library),
 * create_blog_post with categories, tags, SEO description and featured image, approvals, and the refusals.
 * Run:  node --import tsx test/blog.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.LC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-blog-"));
process.env.LC_VERIFY_CHANGES = "0";
const { JsonStore } = await import("../src/store.js");
const { FileStore } = await import("../src/files.js");
const { buildAgent } = await import("../src/agent.js");
const { JobRunner } = await import("../src/jobs.js");
const { htmlWords } = await import("../src/tools.js");
const { Skills } = await import("../src/skills.js");
const { chooseTerms, rankTerms } = await import("../src/terms.js");
const { blogPrompt } = await import("../web/src/blog.js");
const { call, say, mockModel } = await import("./mockModel.js");
const { startFakeSite, PNG } = await import("./fakeSite.js");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };

const fake = await startFakeSite();
const wp = fake.s;
const sites = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "sites"));
const jobs = new JsonStore<any>(path.join(process.env.LC_DATA_DIR!, "jobs"));
const site = sites.put({ id: "site_blog", name: "Blog", url: fake.url, username: "admin", appPassword: "x y z", createdAt: new Date().toISOString() });
const files = new FileStore();

const ARTICLE = [
  "<!-- wp:paragraph --><p>Slow pages lose visitors. Here is how to <strong>speed up WordPress</strong>.</p><!-- /wp:paragraph -->",
  "<!-- wp:heading --><h2 class=\"wp-block-heading\">Use caching</h2><!-- /wp:heading -->",
  "<!-- wp:paragraph --><p>Caching stores finished pages so the server does less work.</p><!-- /wp:paragraph -->",
].join("\n");

async function runAll(runner: any, jobId: string, approvals: string[] = []) {
  for (;;) {
    const j = await runner.waitUntilSettled(jobId);
    if (j.status !== "waiting_approval") return j;
    for (const p of j.pending) { approvals.push(p.toolName); runner.respond(jobId, p.approvalId, true); }
  }
}
const resultOf = (prompt: any[], name: string) => prompt.filter((m: any) => m.role === "tool").flatMap((m: any) => m.content)
  .filter((p: any) => p.type === "tool-result" && p.toolName === name).at(-1)?.output?.value;

console.log("\n1) the form's message");
{
  const p = blogPrompt({ title: "  Speed up WordPress ", tone: "Friendly", words: 1200, image: "ai", imageIdea: "a fast runner", notes: "for shop owners" });
  assert.match(p, /Title: Speed up WordPress\n/);
  assert.match(p, /Tone: Friendly/);
  assert.match(p, /about 1200 words/);
  assert.match(p, /generate one with AI \(a fast runner\)/);
  assert.match(p, /Notes: for shop owners/);
  const lib = blogPrompt({ title: "x", tone: "", words: 800, image: "library", mediaId: 42, mediaAlt: "Team" });
  assert.match(lib, /Media Library image #42 \(“Team”\)/);
  assert.match(lib, /Tone: Professional/);
  assert.match(blogPrompt({ title: "x", tone: "Formal", words: 500, image: "none" }), /no featured image/);
  assert.match(blogPrompt({ title: "x", tone: "Formal", words: 500, image: "upload" }), /use the attached image/);
  ok("title, tone, length, image choice and notes become a readable chat message");
}

console.log("\n2) the blog-post skill is offered to the assistant");
{
  const sk = new Skills();
  assert.ok(sk.list().some((s) => s.name === "blog-post"));
  assert.match(sk.catalogue(), /blog-post: .*create_blog_post/);
  assert.match(String((sk.load("blog-post") as any).content ?? JSON.stringify(sk.load("blog-post"))), /meta description/i);
  ok("skills/blog-post is listed and loads");
}

console.log("\n3) title only -> AI image -> draft post with terms and SEO description");
{
  const imagePrompts: string[] = [];
  let terms: any, image: any, created: any;
  const model = mockModel(async ({ prompt }: any) => {
    const done = (n: string) => resultOf(prompt, n) !== undefined;
    if (!done("load_skill")) return call("load_skill", { name: "blog-post" });
    if (!done("list_terms")) return call("list_terms", {});
    if (!done("generate_image")) { terms = resultOf(prompt, "list_terms"); return call("generate_image", { prompt: "An editorial photo of a fast laptop on a desk, soft daylight", alt: "A laptop showing a fast website", shape: "landscape", reason: "Featured image" }); }
    if (!done("create_blog_post")) {
      image = resultOf(prompt, "generate_image");
      return call("create_blog_post", { title: "Speed up WordPress", content: ARTICLE, excerpt: "Five easy wins.", metaDescription: "Learn how to speed up WordPress with caching and image tips.", categories: ["performance"], tags: ["speed", "caching"], featuredImageId: image.id, reason: "New blog post" });
    }
    created = resultOf(prompt, "create_blog_post");
    return say("Draft ready.");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null, generateImage: async (p: string) => { imagePrompts.push(p); return { buf: PNG, mime: "image/png", model: "fake-image" }; } }));
  const approvals: string[] = [];
  const job = runner.create(site.id, blogPrompt({ title: "Speed up WordPress", tone: "Professional", words: 800, image: "ai" }), "", [], { approvalMode: "every" });
  const j = await runAll(runner, job.id, approvals);
  assert.equal(j.status, "completed", JSON.stringify(j.error ?? ""));

  assert.deepEqual(terms.categories.map((c: any) => c.name), ["Uncategorized", "Performance"]);
  ok("list_terms reads the blog's categories and tags");

  assert.deepEqual(approvals, ["generate_image", "create_blog_post"]);
  ok("generating the image and creating the post each needed approval");

  assert.equal(imagePrompts.length, 1);
  assert.match(imagePrompts[0], /No text, letters, watermarks or logos/);
  assert.ok(image.ok && image.id && wp.media.includes(image.id));
  ok("one AI image was generated and uploaded to the Media Library");

  const b = wp.created.at(-1);
  assert.equal(b.type, "post");
  assert.equal(b.featured_media, image.id);
  assert.deepEqual(b.categories, ["Performance"], "the site's own spelling");
  assert.deepEqual(b.tags, ["speed"], "a tag that does not exist is not sent");
  assert.deepEqual(b.create_terms, []);
  assert.match(b.meta_description, /speed up WordPress/);
  assert.equal(b.excerpt, "Five easy wins.");
  assert.ok(b.ref.startsWith(job.id), "the change is linked to the chat");
  ok("the plugin got the post with featured image, categories, tags, excerpt and SEO description");

  assert.equal(created.categories[0].name, "Performance");
  assert.deepEqual(created.suggestedNewTerms, { categories: [], tags: ["caching"] });
  assert.match(created.note, /NOT created yet[\s\S]*tag caching[\s\S]*ASK the person/);
  assert.equal(created.words, htmlWords(ARTICLE));
  const ui = j.events.filter((e: any) => e.type === "tool_end" && e.data.tool === "create_blog_post").at(-1).data.ui;
  assert.match(ui.link, /preview=true/);
  assert.deepEqual(ui.tags, ["speed"]);
  assert.equal(j.changes.at(-1).tool, "create_blog_post");
  ok("existing terms are used; a new tag is NOT created but suggested, with the instruction to ask; preview link, word count, change recorded");
}

console.log("\n3b) categories and tags: existing first, new ones only with the person's yes");
{
  const cats = [{ id: 1, name: "Uncategorized", slug: "uncategorized", count: 3 }, { id: 2, name: "Web Design", slug: "web-design", count: 5 }, { id: 3, name: "Marketing", slug: "marketing", count: 9 }];
  const tags = [{ id: 4, name: "SEO", slug: "seo", count: 2 }];
  let t = chooseTerms({ categories: ["web design"], tags: ["seo", "Speed"], approvedNew: [], title: "x", content: "" }, { categories: cats, tags });
  assert.deepEqual([t.categories, t.tags, t.create, t.suggestedNew, t.fallbackCategory], [["Web Design"], ["SEO"], [], { categories: [], tags: ["Speed"] }, undefined]);
  t = chooseTerms({ categories: ["AI Tools"], tags: [], approvedNew: [], title: "How AI tools change web design", content: "<h2>Design faster</h2>" }, { categories: cats, tags });
  assert.deepEqual([t.categories, t.suggestedNew.categories, t.fallbackCategory], [["Web Design"], ["AI Tools"], "Web Design"]);
  t = chooseTerms({ categories: ["AI Tools"], tags: ["Speed"], approvedNew: ["ai tools", "speed"], title: "x", content: "" }, { categories: cats, tags });
  assert.deepEqual([t.categories, t.tags, t.create, t.suggestedNew], [["AI Tools"], ["Speed"], ["AI Tools", "Speed"], { categories: [], tags: [] }]);
  t = chooseTerms({ categories: [], tags: [], approvedNew: [], title: "Quarterly update", content: "" }, { categories: cats, tags });
  assert.equal(t.fallbackCategory, "Marketing", "no match: the most used real category, not Uncategorized");
  t = chooseTerms({ categories: [], tags: [], approvedNew: [], title: "Hello", content: "" }, { categories: [cats[0]], tags: [] });
  assert.equal(t.fallbackCategory, "Uncategorized", "a site with only Uncategorized");
  assert.equal(rankTerms(cats, "web design tips")[0].name, "Web Design");
  ok("existing names are matched ignoring case; a new name is a suggestion and the most relevant existing category is used; approved names are created");

  // the person says yes in the next message -> set_post_terms with the new tag
  let step = 0, termsOut: any;
  const model = mockModel(async ({ prompt }: any) => {
    step++;
    if (step === 1) return call("set_post_terms", { post: 17, categories: ["Performance"], tags: ["speed", "caching"], approvedNewTerms: ["caching"], reason: "Add the new tag the person agreed to" });
    termsOut = resultOf(prompt, "set_post_terms");
    return say("Added the new tag caching.");
  });
  const approvals: string[] = [];
  const runner = new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null }));
  const j = await runAll(runner, runner.create(site.id, "Yes, add the new tag caching", "", [], { approvalMode: "every" }).id, approvals);
  assert.equal(j.status, "completed");
  assert.deepEqual(approvals, ["set_post_terms"]);
  assert.deepEqual(wp.termUpdates.at(-1), { source: "assistant", post: 17, categories: ["Performance"], tags: ["speed", "caching"], create_terms: ["caching"] });
  assert.equal(termsOut.tags.find((x: any) => x.name === "caching").created, true);
  ok("after the person's yes, set_post_terms adds the new tag (with approval)");
}

console.log("\n4) Media Library image: find_media, no image generated");
{
  let generated = 0, found: any;
  const model = mockModel(async ({ prompt }: any) => {
    const done = (n: string) => resultOf(prompt, n) !== undefined;
    if (!done("find_media")) return call("find_media", { search: "team" });
    if (!done("create_blog_post")) { found = resultOf(prompt, "find_media"); return call("create_blog_post", { title: "Meet the team", content: ARTICLE, excerpt: "Who we are.", metaDescription: "Meet the people behind our work.", categories: ["News"], tags: [], featuredImageId: found.images[0].id, reason: "New post" }); }
    return say("Draft ready.");
  });
  const runner = new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null, generateImage: async () => { generated++; return { buf: PNG, mime: "image/png", model: "x" }; } }));
  const job = runner.create(site.id, blogPrompt({ title: "Meet the team", tone: "Friendly", words: 500, image: "library", mediaId: 42 }), "", [], { approvalMode: "auto" });
  const j = await runAll(runner, job.id);
  assert.equal(j.status, "completed");
  assert.deepEqual(found.images[0], { id: 42, url: `${fake.url}/wp-content/uploads/team.jpg`, alt: "The team at work", title: "Team", width: 1600, height: 900 });
  assert.equal(wp.created.at(-1).featured_media, 42);
  assert.equal(generated, 0);
  ok("a Media Library image becomes the featured image; nothing is generated");
}

console.log("\n5) refusals");
{
  let out: any;
  const model = mockModel(async ({ prompt }: any) => {
    if (resultOf(prompt, "create_blog_post") === undefined) return call("create_blog_post", { title: "Bad", content: "<!-- wp:heading {\"level\":1} --><h1 class=\"wp-block-heading\">Bad</h1><!-- /wp:heading -->", excerpt: "x", metaDescription: "x", reason: "x" });
    out = resultOf(prompt, "create_blog_post");
    return say("ok");
  });
  const before = wp.created.length;
  const runner = new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null }));
  const j = await runAll(runner, runner.create(site.id, "Write a post called Bad", "", [], { approvalMode: "auto" }).id);
  assert.equal(j.status, "completed");
  assert.equal(out.ok, false);
  assert.match(out.error, /must not contain an h1/);
  assert.equal(wp.created.length, before);
  ok("an article with its own h1 is refused and nothing is written");

  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  const { generateImage } = await import("../src/images.js");
  const { secrets } = await import("../src/secrets.js");
  if (!secrets.providerKey("openai")) {
    await assert.rejects(generateImage("a cat on a sofa"), /needs an OpenAI API key/);
    ok("without an OpenAI key, image generation says to upload or pick an image instead");
  }
  if (saved) process.env.OPENAI_API_KEY = saved;
}

console.log("\n6) the image API call (fake OpenAI)");
{
  process.env.OPENAI_API_KEY ||= "sk-test";
  const { generateImage } = await import("../src/images.js");
  let sent: any;
  const fakeFetch = (async (url: string, init: any) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 }); }) as any;
  const r = await generateImage("a mountain at dawn", "landscape", fakeFetch);
  assert.equal(sent.url, "https://api.openai.com/v1/images/generations");
  assert.deepEqual({ model: sent.body.model, size: sent.body.size, quality: sent.body.quality, n: sent.body.n }, { model: "gpt-image-1", size: "1536x1024", quality: "medium", n: 1 });
  assert.match(sent.auth, /^Bearer /);
  assert.ok(r.buf.equals(PNG));
  const bad = (async () => new Response(JSON.stringify({ error: { message: "Your request was rejected" } }), { status: 400 })) as any;
  await assert.rejects(generateImage("x".repeat(20), "square", bad), /Image generation failed \(400\): Your request was rejected/);
  ok("one landscape image at medium quality; errors from the image API are explained");
}

console.log("\n7) a server restart in the middle of a run repeats nothing");
{
  const { JobRunner: Runner } = await import("../src/jobs.js");
  const now = new Date().toISOString();
  const call1 = { type: "tool-call", toolCallId: "c1", toolName: "generate_image", input: { prompt: "p", alt: "a", reason: "r" } };
  const res1 = { type: "tool-result", toolCallId: "c1", toolName: "generate_image", output: { type: "json", value: { ok: true, id: 15 } } };
  const call2 = { type: "tool-call", toolCallId: "c2", toolName: "find_media", input: {} };
  // step 1 (image) finished and was saved; step 2 was cut off after its tool ran
  jobs.put({ id: "job_crash", siteId: site.id, prompt: "p", status: "running", messages: [{ role: "user", content: "Write a post" }], pending: [], events: [], changes: [], createdAt: now, updatedAt: now,
    partial: { steps: [{ role: "assistant", content: [call1] }, { role: "tool", content: [res1] }, { role: "assistant", content: [call2] }], tools: [{ toolCallId: "c1", toolName: "generate_image", output: { ok: true, id: 15 } }, { toolCallId: "c2", toolName: "find_media", output: { ok: true, images: [] } }] } } as any);
  new Runner(jobs, sites, buildAgent(files, { model: mockModel(async () => say("x")), hostinger: null, browser: null })).recover();
  const j: any = jobs.get("job_crash");
  assert.equal(j.status, "interrupted");
  assert.equal(j.partial, undefined);
  const flat = JSON.stringify(j.messages);
  assert.ok(flat.includes('"toolCallId":"c1"') && flat.includes('"id":15'), "the finished image step is kept");
  assert.ok(!j.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.toolCallId === "c2")), "the cut-off step is not kept half");
  assert.match(String(j.messages.at(-1).content), /ALREADY RUN[\s\S]*find_media/);
  ok("finished steps are kept, a tool that ran in a cut-off step is named as already done (no second image)");
}

console.log("\n8) a run that ends without words still answers");
{
  let step = 0;
  const model = mockModel(async () => (++step === 1
    ? call("create_blog_post", { title: "Quiet", content: ARTICLE, excerpt: "x", metaDescription: "x", categories: ["Performance"], tags: [], reason: "r" })
    : say("")));
  const runner = new JobRunner(jobs, sites, buildAgent(files, { model, hostinger: null, browser: null }));
  const j = await runAll(runner, runner.create(site.id, "Write a post called Quiet", "", [], { approvalMode: "auto" }).id);
  assert.equal(j.status, "completed");
  assert.match(String(j.result), /Created the blog post as a draft[\s\S]*preview=true[\s\S]*Deploy/);
  assert.ok(j.events.some((e: any) => e.type === "text" && /Created the blog post/.test(String(e.data.text))));
  ok("an empty final answer is replaced by a summary of what was done, with the preview link");
}

fake.close();
console.log(`\n${passed} checks passed.`);
process.exit(0);
