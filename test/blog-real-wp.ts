/**
 * Blog posts against a REAL WordPress with the Livecrafts plugin and a real browser (optional, not part of npm test):
 * create a draft post the way create_blog_post does (block markup with links / bold / quotes, featured image,
 * category, SEO description) and run the new-post browser check on it.
 *
 *   LC_TEST_WP_URL=http://localhost/mysite LC_TEST_WP_USER=admin LC_TEST_WP_APP_PASSWORD="xxxx xxxx ..." \
 *     node --import tsx test/blog-real-wp.ts
 *
 * Optional: LC_TEST_EXPECT_CONTENT=0 when the active theme is known NOT to print the post content (the check must
 * then fail with "content"), LC_BROWSER_PATH for the browser. It creates draft posts (Trash them afterwards).
 */
import assert from "node:assert/strict";
import zlib from "node:zlib";

const url = process.env.LC_TEST_WP_URL, user = process.env.LC_TEST_WP_USER, pass = process.env.LC_TEST_WP_APP_PASSWORD;
if (!url || !user || !pass) { console.log("Skipped: set LC_TEST_WP_URL, LC_TEST_WP_USER and LC_TEST_WP_APP_PASSWORD."); process.exit(0); }
const expectContent = process.env.LC_TEST_EXPECT_CONTENT !== "0";

const { Bridge } = await import("../src/bridge.js");
const { Verifier } = await import("../src/verify.js");
const { closeBrowser } = await import("../src/browser.js");
const { htmlToText } = await import("../src/bridge.js");

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ✓ " + name); };
const bridge = new Bridge({ id: "site_real", name: "real", url, username: user, appPassword: pass, createdAt: new Date().toISOString() } as any);
const verifier = new Verifier({
  siteUrl: url,
  previewToken: async () => (await bridge.previewToken()).token,
  liveText: async (u) => htmlToText(await (await fetch(u)).text()),
});

/** A 1200x630 PNG in two brand-like colours (a real image, so the theme shows it). */
function png(w = 1200, h = 630): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const a = x / w; raw[o] = 11 + a * 220; raw[o + 1] = 61 + a * 50; raw[o + 2] = 145 - a * 80; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ARTICLE = [
  "<!-- wp:paragraph -->\n<p>Here's how a <strong>faster site</strong> -- and a calmer team -- start with <a href=\"/\">small fixes</a>.</p>\n<!-- /wp:paragraph -->",
  "<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">Start with caching</h2>\n<!-- /wp:heading -->",
  "<!-- wp:paragraph -->\n<p>Caching stores finished pages, so the server does less work for every visitor.</p>\n<!-- /wp:paragraph -->",
  "<!-- wp:list -->\n<ul class=\"wp-block-list\"><!-- wp:list-item -->\n<li>Compress images</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->",
].join("\n\n");

console.log(`\nReal WordPress: ${url}`);
const ping: any = await bridge.ping();
assert.equal(ping.ok, true);
ok(`the backend logs in (plugin ${ping.version}, WordPress ${ping.site?.wp})`);

const profile: any = await bridge.siteProfile();
assert.ok(profile.brand && Array.isArray(profile.brand.colors), "site-profile has brand (plugin 0.15.1+)");
assert.ok(Array.isArray(profile.builders?.others), "site-profile lists other builders");
ok(`site profile: theme ${profile.theme?.name}, ${profile.brand.colors.length} brand colours, builders: ${["elementor", ...(profile.builders.others ?? []).map((b: any) => b.id)].filter((b) => b !== "elementor" || profile.builders.elementor?.active).join(", ") || "blocks only"}`);

const media: any = await bridge.uploadMedia(png(), "lc-real-test.png", "image/png", "Real test image", "A blue to orange gradient");
const cats: any[] = await bridge.terms("categories");
const stamp = Date.now().toString(36);
const created: any = await bridge.createPage({ type: "post", title: `Faster sites, calmer teams ${stamp}`, content: ARTICLE, excerpt: "Small fixes that add up.", meta_description: "How small fixes make a faster site and a calmer team.", categories: [cats[0]?.name ?? "Uncategorized"], tags: [], featured_media: media.id } as any);
assert.ok(created.ok && created.id && created.preview);
ok(`draft post #${created.id} created with category “${created.categories?.[0]?.name}” and featured image #${media.id}`);

const v = await verifier.newPost(created.preview, { title: `Faster sites, calmer teams ${stamp}`, content: ARTICLE, imageUrl: created.featured_media?.url });
for (const c of v.checks) console.log(`      ${c.ok === true ? "pass" : c.ok === false ? "FAIL" : "info"}  ${c.name}: ${c.detail}`);
const by = (n: string) => v.checks.find((c) => c.name === n);
assert.equal(by("title")?.ok, true, "title shows");
assert.equal(by("live")?.ok, true, "visitors cannot open the draft");
assert.ok(!v.checks.some((c) => /^php/.test(c.name) && c.ok === false), "no PHP error");
if (expectContent) {
  assert.equal(by("content")?.ok, true, "the article content shows (curly quotes, dashes, bold and links do not break the match)");
  assert.equal(v.passed, true, v.summary);
  ok("the browser check passes: title, article, image, health on desktop + mobile, hidden from visitors");
} else {
  assert.equal(by("content")?.ok, false, "a theme that does not print the content is caught");
  assert.equal(v.passed, false);
  ok("a theme / builder template that does not print the post content is caught (check fails on “content”)");
}

const anon = await fetch(created.preview);
assert.equal(anon.status, 404);
ok("a visitor opening the preview link gets 404");
await closeBrowser();
console.log(`\n${passed} checks passed.`);
process.exit(0);
