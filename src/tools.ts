import { tool } from "ai";
import { z } from "zod";
import { Bridge, BridgeError, type PostType } from "./bridge.js";
import type { FileStore } from "./files.js";
import type { SiteFiles } from "./sitefiles.js";
import type { HostingerClient } from "./hostinger.js";
import type { Device } from "./browser.js";
import type { Verifier } from "./verify.js";
import { downloadImage } from "./net.js";
import type { Skills } from "./skills.js";
import { makeComponentTools } from "./componentTools.js";
import { generateImage, type ImageShape } from "./images.js";
import { chooseTerms } from "./terms.js";
import { sameHost, summarize, type SpeedDevice, type SpeedRuns } from "./pagespeed.js";
import { pluginJobs } from "./pluginJobs.js";
import type { SiteCache } from "./sessions.js";

/**
 * The assistant's tools. Every write goes to the site as a DRAFT through the Livecrafts plugin (POST /changes):
 * editors see it in the preview, visitors only after a person deploys. The plugin validates each change against its
 * real source (Elementor control, block markup, ACF field type ...), stores it and reads it back; the backend then
 * checks the page in a real browser (verify.ts) and hands the result to the model with the tool result.
 */

/** Expected failures become a normal tool result the model can read and react to (instead of crashing the loop). */
async function safe<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string; status?: number; code?: string; data?: unknown }> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BridgeError) return { ok: false, error: e.message, status: e.status, code: e.code };
    return { ok: false, error: (e as Error).message };
  }
}

/** Words of an article's visible text (block comments and tags removed). */
/** Inline styling in block markup that would override the site's brand (colours, fonts, sizes). */
export function brandOverrides(html: string): string[] {
  const found = new Set<string>();
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) found.add("inline styles");
  const attrs = [...String(html).matchAll(/<!--\s*wp:[a-z0-9/-]+\s+(\{[\s\S]*?\})\s*\/?-->/gi)].map((m) => m[1]).join(" ");
  if (/"(textColor|backgroundColor|gradient|borderColor)"\s*:|"color"\s*:\s*\{/.test(attrs)) found.add("colours");
  if (/"(fontFamily|fontSize)"\s*:|"typography"\s*:\s*\{/.test(attrs)) found.add("fonts / sizes");
  if (/class="[^"]*\bhas-[a-z0-9-]+-(color|background-color|font-size|font-family)\b/i.test(html)) found.add("colour / font classes");
  return [...found];
}

/** Added to a tool's note when the browser check of a new page / post failed. */
function failedNote(r: any): string {
  const v = r?.verification;
  return v && v.passed === false ? ` THE BROWSER CHECK FAILED: ${v.summary} ${v.checks.filter((c: any) => c.ok === false).map((c: any) => c.detail).join(" ")} Tell the person what is wrong instead of reporting success.` : "";
}

export function htmlWords(html: string): number {
  const t = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * The page map can be big; give the model a compact, stable view of it.
 *
 * Exported because the SAME shape is now put in front of the model at the start of a run (see siteContext in
 * jobs.ts). Two renderings of a page map would drift, and the model would be told two different things.
 */
export function compactMap(m: any) {
  const values = [...(m.acf ?? []).filter((e: any) => e.kind === "acf"), ...(m.elementor ?? []), ...(m.divi ?? [])].slice(0, 200).map((e: any) => ({
    target: e.tid, label: e.label, type: e.ftype,
    value: e.ftype === "image" ? `[image id ${e.value}] ${e.url}` : String(e.value).slice(0, 200),
  }));
  const rows = (m.acf ?? []).filter((e: any) => e.kind === "acf-rows").map((e: any) => ({ rows: e.name, label: e.label, type: e.ftype, count: e.rows, min: e.min, max: e.max, layouts: e.layouts }));
  return {
    ok: true, view: m.view, post: m.post, builders: m.builders, drafts: m.drafts, values, acfRows: rows.length ? rows : undefined,
    elementorOutline: m.elementor_outline?.length ? m.elementor_outline.slice(0, 250) : undefined,
    diviOutline: m.divi_outline?.length ? m.divi_outline.slice(0, 250) : undefined,
    howToChange: "acf:<field key>:<post> → make_change kind acf.field target <field key>; acfv:<meta>:<post> → kind acf.value target <meta>; el:<post>:<id>:<setting> → kind el.setting target <id>:<setting>; divi:<post>:<path>:<field> → kind divi.text (or divi.link) target <path>:<field>.",
  };
}

/** A change as the model needs to see it: short, with its id for revert_change. */
const changeView = (c: any) => c && ({ id: c.id, status: c.status, summary: c.summary, kind: c.kind, target: c.target, object: c.object?.label, by: c.user?.name, source: c.source, at: c.at, release: c.release ?? undefined, reverts: c.reverts ?? undefined });

export interface ToolExtras {
  siteFiles?: SiteFiles | null;         // theme files (read; writes only when allowed)
  allowThemeWrites?: boolean;
  hostinger?: HostingerClient | null;   // read-only API questions
  browser?: {
    inspect: (a: { url?: string; text?: string; selector?: string; device?: Device; view?: "draft" | "live" }) => Promise<unknown>;
    screenshot: (a: { url?: string; selector?: string; text?: string; device?: Device; fullPage?: boolean; view?: "draft" | "live" }) => Promise<unknown>;
    design?: (a: { url?: string; device?: Device; view?: "draft" | "live" }) => Promise<unknown>;
    read?: (a: { url?: string; device?: Device; view?: "draft" | "live" }) => Promise<unknown>;
  } | null;
  verifier?: Verifier | null;
  /** The page the person is on (default page for checks). */
  pageUrl?: () => string | undefined;
  /** Reference stored with every change: which chat and request made it. */
  ref?: () => string;
  skills?: Skills | null;
  planTool?: boolean;                   // "once per request" approval mode: offer propose_plan
  /** Offer offer_layouts: the person picks a section's layout from pictures. Off = the assistant decides alone. */
  layoutPicker?: boolean;
  fetchImpl?: typeof fetch;             // tests: fake the internet for image downloads
  allowPrivateImageHosts?: boolean;     // tests/demo only
  generateImage?: typeof generateImage; // tests: fake the image model
  /** PageSpeed reports (Google PageSpeed Insights / local Lighthouse); null = off. */
  speed?: SpeedRuns | null;
  siteId?: string;
  siteUrl?: string;
  /**
   * A voice session's memory of the site (sessions.ts): site_status, read_notes and get_page_map are read once and
   * then answered from here, instead of once per turn. Every write empties it, so a changed page is never read stale.
   */
  cache?: SiteCache | null;
}

const deviceSchema = z.enum(["desktop", "tablet", "mobile"]).optional().describe("Screen size (default desktop)");
const viewSchema = z.enum(["draft", "live"]).optional().describe("draft = with the unpublished changes, as editors see it (default); live = what visitors see now");
const postTypeSchema = z.enum(["pages", "posts"]).describe("pages or posts");
const reasonSchema = z.string().max(300).describe("One short sentence for the person approving: what changes and why");

export const CHANGE_KINDS = [
  "post.field", "post.meta", "acf.field", "acf.value", "acf.rows",
  "el.setting", "el.insert", "el.remove", "el.duplicate", "el.move",
  "block.text", "block.link", "block.image", "block.class", "block.replace", "block.insert", "block.remove", "block.move", "block.duplicate",
  "divi.text", "divi.link",
  "css.rule", "css.block",
] as const;

/** Values that are objects/lists travel as JSON text (works with every model provider). */
function parseValue(v: string): unknown {
  const t = v.trim();
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { /* plain text that starts with a bracket */ } }
  return v;
}

export function makeTools(bridge: Bridge, files: FileStore, extras: ToolExtras = {}) {
  const ref = () => extras.ref?.() ?? "";
  /** Read once per voice session (and once per run otherwise). */
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => (extras.cache ? extras.cache.get(key, read) : read());
  /** The site was written to: the session's status, notes and page maps are stale from here on. */
  const changed = () => extras.cache?.invalidate();
  const postCache = new Map<string, number>();
  const postIdOf = async (url?: string, post?: number) => {
    if (post) return post;
    const u = url || extras.pageUrl?.() || bridge.homeUrl;
    if (!postCache.has(u)) postCache.set(u, Number((await once(`map:${u}:draft`, () => bridge.map({ url: u, view: "draft" })))?.post?.id));
    return postCache.get(u)!;
  };
  /** Run a write; for one that changed a page, check it in a real browser before the model hears back. */
  const checked = async (pageUrl: string | undefined, write: () => Promise<any>, opts: { component?: string; softH1?: boolean } = {}) => {
    const v = extras.verifier;
    const before = v && pageUrl ? await v.before(pageUrl) : null;
    const res = await write();
    // The page is not what the session read any more. Done before the browser check, so nothing can read it stale.
    if (res?.ok !== false && !res?.unchanged) changed();
    if (res?.ok === false || res?.unchanged || !v || !pageUrl || !res?.change) return res;
    return { ...res, verification: await v.after(pageUrl, res.change, before, opts) };
  };
  /** A NEW page / post: open its preview the way the theme / page builder renders it (title, content, image, health). */
  const checkedNew = async (res: any, e: { title: string; content?: string; imageUrl?: string }) => {
    const v = extras.verifier;
    if (res?.ok) changed();
    if (!res?.ok || !res?.preview) return res;
    if (!v) return { ...res, verification: { passed: true, checks: [], summary: "Not checked in a browser (page checks are off). Open the preview link to see it." } };
    return { ...res, verification: await v.newPost(res.preview, e) };
  };

  const reading = {
    site_status: tool({
      description:
        "What is going on on this site right now, like `git status`: the draft changes not deployed yet (per page, with ids), conflicts (someone changed the live site under a draft), " +
        "the last release, and changes made OUTSIDE Livecrafts since then (WP admin, Elementor editor - by whom). " +
        "THIS IS ALREADY IN YOUR SITE CONTEXT below, read fresh for this request: do not call this to start a request. Call it only to see changes made since you started working, or before reverting.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => {
        const s = await once("status", () => bridge.status());
        return {
          ok: true,
          drafts: (s.drafts?.objects ?? []).map((o: any) => ({ object: o.object.label, url: o.object.url, changes: o.changes.map(changeView) })),
          draftCount: s.drafts?.count ?? 0, conflicts: s.conflicts, broken: s.broken, lastRelease: s.last_release,
          outsideChangesSinceRelease: (s.outside_changes_since_release ?? []).map(changeView), legacyOverlay: s.legacy_overlay ?? undefined, note: s.note,
        };
      }),
    }),
    site_history: tool({
      description: "The change history (like `git log`), newest first: who changed what, when, from where (assistant, widget, wp-admin, elementor), draft/live/discarded. Filter by page URL. Use it to answer 'what changed' and to find a change to revert.",
      inputSchema: z.object({ url: z.string().optional().describe("Only changes of this page"), status: z.enum(["draft", "live", "discarded"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
      execute: async ({ url, status, limit }) => safe(async () => {
        const post = url ? await postIdOf(url) : undefined;
        const r = await bridge.changes({ post, status, limit: limit ?? 30 });
        return { ok: true, changes: r.changes.map(changeView) };
      }),
    }),
    change_details: tool({
      description: "One change in full: its before and after values (for changes made outside Livecrafts: what differed). Use it before reverting or to explain exactly what happened.",
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => safe(async () => {
        const r = await bridge.change(id);
        const c = r.change ?? {};
        const cut = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? null); return s.length > 6000 ? s.slice(0, 6000) + "…" : s; };
        return { ok: true, ...changeView(c), before: cut(c.payload?.before), after: cut(c.payload?.after), diff: c.diff?.map((d: any) => ({ path: d.path, before: cut(d.before), after: cut(d.after) })) };
      }),
    }),
    read_notes: tool({
      description: "Your notes about this site and about a page (what you learned last time: where things are stored, brand rules, pitfalls). " +
        "The notes for the site and for the page the person is on are ALREADY IN YOUR SITE CONTEXT: call this only for a DIFFERENT page.",
      inputSchema: z.object({ url: z.string().optional().describe("Page URL (default: the page the person is on)") }),
      execute: async ({ url }) => safe(async () => {
        const post = await postIdOf(url);
        const r = await once(`notes:${post ?? ""}`, () => bridge.notes(post));
        return { ok: true, site: r.site?.text ?? "", page: r.page?.text ?? "", pageUpdated: r.page?.updated ?? null };
      }),
    }),
    write_notes: tool({
      description:
        "Replace your notes (site-wide, or for one page) with an updated version - short, factual, current. Write down what makes the next change faster and safer: where values are stored " +
        "(\"hero title = Elementor heading 3f2a1c\"), the page structure, the design tokens in use, things that did not work and why. Never personal data or passwords. Max ~2000 words.",
      inputSchema: z.object({ scope: z.enum(["site", "page"]), url: z.string().optional().describe("For page notes: the page URL (default: the page the person is on)"), text: z.string().max(20000) }),
      execute: async ({ scope, url, text }) => safe(async () => {
        const r = await bridge.setNotes(scope === "page" ? await postIdOf(url) : undefined, text);
        changed();
        return { ok: true, saved: scope, updated: r.notes?.updated };
      }),
    }),
    list_pages: tool({
      description: "List the pages of this WordPress site (id, title, url, status). Use it when the user names a page but gives no URL.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => ({ ok: true, pages: (await bridge.listPages()).map((p) => ({ id: p.id, title: p.title?.rendered, url: p.link, status: p.status })) })),
    }),
    find_posts: tool({
      description: "Search pages or blog posts (published, drafts, private) by title/text. Returns id, title, status, url, template.",
      inputSchema: z.object({ type: postTypeSchema, search: z.string().optional() }),
      execute: async ({ type, search }) => safe(async () => ({ ok: true, items: (await bridge.listPosts(type as PostType, search)).map((p: any) => ({ id: p.id, title: p.title?.raw ?? p.title?.rendered, status: p.status, url: p.link, template: p.template || "default" })) })),
    }),
    get_page_map: tool({
      description:
        "Everything editable on a page with its CURRENT value: ACF fields (also inside groups and repeater/flexible rows), Elementor content settings, ACF row lists, and the Elementor outline " +
        "(element ids, types, nesting, short text). Choose change targets from here. view draft (default) includes unpublished changes. " +
        "THE PAGE THE PERSON IS ON IS ALREADY MAPPED IN YOUR SITE CONTEXT below: call this only for a DIFFERENT page, for the live view, or to re-read a page AFTER you have changed it.",
      inputSchema: z.object({ url: z.string().optional().describe("Full page URL (default: the page the person is on, else the home page)"), view: viewSchema }),
      execute: async ({ url, view }) => safe(async () => {
        const u = url || extras.pageUrl?.() || bridge.homeUrl;
        const v = view ?? "draft";
        return compactMap(await once(`map:${u}:${v}`, () => bridge.map({ url: u, view: v })));
      }),
    }),
    read_post: tool({
      description: "The title, status, template and RAW content (block markup) of a page/post as editors see it now (draft view), or as visitors do (live). Use it before changing blocks or content.",
      inputSchema: z.object({ id: z.number().int().optional(), url: z.string().optional(), view: viewSchema }),
      execute: async ({ id, url, view }) => safe(async () => {
        const p = await bridge.post(await postIdOf(url, id), view ?? "draft");
        const raw = String(p.content ?? "");
        return { ...p, content: raw.slice(0, 60_000), truncated: raw.length > 60_000, length: raw.length, blocks: /<!-- wp:/.test(raw) ? "Blocks are addressed by path: 0, 1, 2.0 ... (the n-th block, then the n-th block inside it)." : undefined };
      }),
    }),
    read_target: tool({
      description: "One ACF / Elementor value straight from the database: draft value, live value, definition, recent changes.",
      inputSchema: z.object({ target: z.string().describe("A target id from get_page_map (acf:…, acfv:…, el:…)") }),
      execute: async ({ target }) => safe(() => bridge.readTarget(target)),
    }),
    find_text: tool({
      description: "Find where given texts are stored in the database (post content, menu, widget, Elementor JSON, options ...). Use it when a text the user mentions is NOT in get_page_map.",
      inputSchema: z.object({ postId: z.number().int(), texts: z.array(z.string()).min(1).max(10) }),
      execute: async ({ postId, texts }) => safe(() => bridge.locate(postId, texts)),
    }),
    get_menus: tool({
      description: "Navigation menus: theme menu locations, every menu and its items (id, title, url). Menu link text/address can be changed with make_change (post.field title / post.meta _menu_item_url on the item id).",
      inputSchema: z.object({}),
      execute: async () => safe(async () => {
        const [locations, menus] = await Promise.all([bridge.menuLocations(), bridge.menus()]);
        const withItems = await Promise.all(menus.map(async (m: any) => ({
          id: m.id, name: m.name, locations: m.locations,
          items: (await bridge.menuItems(m.id)).map((i: any) => ({ id: i.id, title: i.title?.raw ?? i.title?.rendered, url: i.url, type: i.type, order: i.menu_order, parent: i.parent })),
        })));
        return { ok: true, locations: Object.values(locations ?? {}).map((l: any) => ({ location: l.name, description: l.description, menuId: l.menu || null })), menus: withItems };
      }),
    }),
    list_terms: tool({
      description: "The blog's categories and tags with how many posts use each (most used first). Call it before create_blog_post and reuse existing names; only suggest a new one when nothing fits.",
      inputSchema: z.object({ search: z.string().optional() }),
      execute: async ({ search }) => safe(async () => {
        const [cats, tags] = await Promise.all([bridge.terms("categories", search), bridge.terms("tags", search)]);
        const view = (t: any) => ({ id: t.id, name: t.name, posts: t.count });
        return { ok: true, categories: cats.map(view), tags: tags.slice(0, 60).map(view) };
      }),
    }),
  };

  /** A whole section pasted as HTML into one Elementor text-editor / HTML widget: editors could not edit it and it overlays the page. */
  const handWrittenSection = (kind: string, target: string, value: string): string | null => {
    if (/\[ai_[a-z_]+/.test(value) && /^(el\.|block\.)/.test(kind)) return "Refused: template shortcodes ([ai_...]) are not written by hand. Use place_component source \"template\": it applies the measured fit, checks the section on desktop / tablet / mobile and returns the proof. If place_component returns an error, tell the person the error instead of working around it.";
    const isWidgetHtml = (kind === "el.setting" && /:(editor|html|code|custom_html|content)$/.test(target)) || (kind === "el.insert" && /"(text-editor|html)"/.test(value.slice(0, 400)));
    if (!isWidgetHtml) return null;
    const blocks = (value.match(/<(div|section|article|figure|ul|h[1-6]|style)\b/gi) ?? []).length;
    if (blocks < 4 && !/<style\b/i.test(value)) return null;
    return "Refused: this pastes a whole section as HTML into one Elementor text-editor / HTML widget. Editors could not edit it and it breaks the page layout. " +
      "Use place_component (source \"template\" first - find_components shows it) or build it from containers, heading, text-editor, image and button widgets with el.insert. A text-editor widget holds paragraphs and lists only.";
  };

  const writing = {
    make_change: tool({
      description:
        "Make ONE draft change on the site (editors see it in the preview; visitors after a person deploys). The plugin checks it against the real source and reads it back; " +
        "then the page is checked in a real browser and you get `verification` - if it did not pass, fix or revert before saying it worked.\n" +
        "kind / target / value:\n" +
        "- post.field: title|content|excerpt|status (publish/draft/private) / text. Prefer block.* for parts of block content.\n" +
        "- post.meta: _thumbnail_id (attachment id) | _wp_page_template (template file) | _menu_item_url | _menu_item_target (\"_blank\" or \"\").\n" +
        "- acf.field: field key (field_…) / value. acf.value: meta name (e.g. sections_0_title) / value. acf.rows: repeater meta name / JSON {\"op\":\"add|remove|move|duplicate\",\"index\":n,\"to\":n|\"up\"|\"down\",\"layout\":\"…\"}.\n" +
        "- el.setting: <element id>:<control> (e.g. 3f2a1c:title, 3f2a1c:title_color, 3f2a1c:typography_font_size_mobile, 3f2a1c:_margin, 3f2a1c:_animation, 3f2a1c:hide_mobile) / value: text, #hex colour, \"32px\", \"10px 20px\", yes, " +
        "global:globals/colors?id=primary, or JSON for links/images ({\"id\":123}). Settings are checked against Elementor's own control definition.\n" +
        "- el.insert: <parent id|root>:<index|end> / ONE element as Elementor JSON {elType, widgetType, settings, elements}. el.remove|el.duplicate: <element id>. el.move: <element id> / up|down|{\"parent\":\"id\",\"index\":n}.\n" +
        "- block.text|block.link|block.image|block.class: block path (0, 2.1 …) / inline HTML | url | attachment id | class. block.replace: path / block markup. block.insert: <parent path>:<index|end> (\":end\" = end of page) / block markup. " +
        "block.remove: path / count. block.move: path / up|down|index. block.duplicate: path.\n" +
        "- divi.text|divi.link (a Divi page: its modules are shortcodes in the content): <module path>:<field> (e.g. 2.0.0.0:text, 2.0.0.1:button_text, 2.0.0.1:button_url) / text | url. " +
        "Field \"text\" is the module's own content (a Text module's rich text, so pass its whole HTML); any other field is one of the module's attributes. get_page_map lists every editable Divi field with its exact kind and target - take them from there, never guess a path.\n" +
        "- css.rule (site-wide styles, no target): JSON {\"selector\":\"…\",\"media\":\"\"|\"desktop\"|\"tablet\"|\"mobile\",\"declarations\":{\"color\":\"#0b3d91\"}} - values merge per selector+screen, \"\" removes one. " +
        "Never !important: make the selector more specific than the winning rule (inspect_element shows it). animation-name: lc-fade-in|lc-fade-up|lc-zoom-in|lc-slide-in-left|lc-slide-in-right.\n" +
        "- css.block: block name / raw CSS (for keyframes or several rules that belong together).",
      inputSchema: z.object({
        kind: z.enum(CHANGE_KINDS),
        url: z.string().optional().describe("Page the change is on (default: the page the person is on). Not needed for css.*"),
        post: z.number().int().optional().describe("Post id instead of url (e.g. a menu item id, an Elementor template id)"),
        target: z.string().max(300).default("").describe("See the kinds above (empty for css.rule)"),
        value: z.string().max(200_000).describe("The new value; objects and lists as JSON text"),
        label: z.string().max(80).optional().describe("Short name for a css.rule / css.block (shown in the CSS and the history)"),
        reason: reasonSchema,
      }),
      execute: async ({ kind, url, post, target, value, label }) => safe(async () => {
        const isCss = kind.startsWith("css.");
        const refused = handWrittenSection(kind, target, value);
        if (refused) return { ok: false, error: refused };
        const pageUrl = url || extras.pageUrl?.() || bridge.homeUrl;
        const postId = isCss ? undefined : await postIdOf(url, post);
        return checked(post && !url ? undefined : pageUrl, () => bridge.makeChange({ kind, post: postId, target, value: parseValue(value), label, ref: ref() }))
          .then((r: any) => r?.change ? { ...r, change: changeView(r.change), changeId: r.change.id } : r);
      }),
    }),
    create_page: tool({
      description: "Create a NEW page or blog post. It is created as a WordPress draft (visitors cannot see it) and is published when a person deploys. content = block markup (core blocks, responsive). Returns its id and preview link.",
      inputSchema: z.object({
        title: z.string().min(1).max(200), content: z.string().max(200_000).default(""), type: z.enum(["page", "post"]).default("page"),
        slug: z.string().max(100).optional(), parent: z.number().int().optional(), template: z.string().max(200).optional(), excerpt: z.string().max(1000).optional(), reason: reasonSchema,
      }),
      execute: async (a) => safe(async () => {
        const r = await checkedNew(await bridge.createPage({ title: a.title, content: a.content, type: a.type, slug: a.slug, parent: a.parent, template: a.template, excerpt: a.excerpt, ref: ref() }), { title: a.title, content: a.content });
        return { ...r, change: changeView(r.change), changeId: r.change?.id, note: "Draft page. Preview it with the preview link; it goes live when a person deploys." + failedNote(r) };
      }),
    }),
    create_blog_post: tool({
      description:
        "Create a NEW blog post as a draft in one step: title, the full article (block markup), excerpt, SEO meta description, categories, tags and the featured image. " +
        "Visitors cannot see it until a person deploys. Load the skill \"blog-post\" first. Returns the post id and preview link; refine it afterwards with make_change / block.* like any page.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(200_000).describe("The article as core block markup: intro paragraph, wp:heading h2/h3 sections, lists, conclusion. No h1 (the title is the h1)."),
        excerpt: z.string().max(600).describe("1-2 sentences for blog listings"),
        metaDescription: z.string().max(320).describe("SEO meta description, about 140-155 characters, includes the main keyword"),
        categories: z.array(z.string().max(80)).max(3).default([]).describe("Category names: existing ones from list_terms. A name that does not exist yet is NOT created - it comes back as a suggestion to ask the person about"),
        tags: z.array(z.string().max(60)).max(10).default([]).describe("Tag names: existing ones; new names come back as suggestions"),
        approvedNewTerms: z.array(z.string().max(80)).max(10).default([]).describe("ONLY new category / tag names the PERSON explicitly agreed to add (they said yes, or their request allows new ones). Never fill this on your own"),
        featuredImageId: z.number().int().optional().describe("Media Library attachment id (from generate_image, upload_media_from_chat or find_media)"),
        slug: z.string().max(100).optional(),
        reason: reasonSchema,
      }),
      execute: async (a) => safe(async () => {
        if (/<!--\s*wp:heading[^>]*"level":1\b/.test(a.content) || /<h1[\s>]/i.test(a.content)) return { ok: false, error: "The article must not contain an h1: the post title is the page's h1. Use h2 for sections and h3 below them." };
        const own = brandOverrides(a.content);
        if (own.length) return { ok: false, error: `The article sets its own ${own.join(", ")}. Remove them: the theme / page builder gives the post the brand's fonts, colours and sizes. Use plain core blocks.` };
        const [cats, tags] = await Promise.all([bridge.terms("categories"), bridge.terms("tags")]);
        const t = chooseTerms({ categories: a.categories, tags: a.tags, approvedNew: a.approvedNewTerms, title: a.title, content: a.content }, { categories: cats, tags });
        const created = await bridge.createPage({
          type: "post", title: a.title, content: a.content, excerpt: a.excerpt, slug: a.slug, ref: ref(),
          meta_description: a.metaDescription, categories: t.categories, tags: t.tags, create_terms: t.create, featured_media: a.featuredImageId,
        });
        const r = await checkedNew(created, { title: a.title, content: a.content, imageUrl: created?.featured_media?.url });
        const ask = t.suggestedNew.categories.length + t.suggestedNew.tags.length > 0;
        const named = [...t.suggestedNew.categories.map((n) => "category " + n), ...t.suggestedNew.tags.map((n) => "tag " + n)].join(", ");
        // the WordPress editor for this post (plugin 0.19.1+ sends it; older ones: built from the site address)
        const edit = r?.edit ?? (r?.id ? `${String(extras.siteUrl || bridge.homeUrl).replace(/\/+$/, "")}/wp-admin/post.php?post=${r.id}&action=edit` : undefined);
        return {
          ...r, edit, change: changeView(r.change), changeId: r.change?.id, words: htmlWords(a.content),
          ...(ask ? { suggestedNewTerms: t.suggestedNew } : {}),
          ...(t.fallbackCategory ? { categoryUsed: `${t.fallbackCategory} (the most relevant existing category)` } : {}),
          note: "Draft blog post. Give the person the preview link; it is published when a person deploys." + failedNote(r) + (ask
            ? ` NOT created yet (they do not exist on the site): ${named}. ASK the person in your answer whether to add them. If they say yes, call set_post_terms with them in approvedNewTerms; if no, nothing more to do.`
            : ""),
        };
      }),
    }),
    set_post_terms: tool({
      description: "Change the categories / tags of a NEW blog post that was not deployed yet (e.g. after the person agreed to the suggested new ones). The lists REPLACE the current ones, so include the ones to keep. Needs approval.",
      inputSchema: z.object({
        post: z.number().int().describe("The post id from create_blog_post"),
        categories: z.array(z.string().max(80)).max(3).optional(),
        tags: z.array(z.string().max(60)).max(10).optional(),
        approvedNewTerms: z.array(z.string().max(80)).max(10).default([]).describe("New names the PERSON agreed to add"),
        reason: reasonSchema,
      }),
      execute: async ({ post, categories, tags, approvedNewTerms }) => safe(() => bridge.postTerms({ post, categories, tags, create_terms: approvedNewTerms })),
    }),
    revert_change: tool({
      description: "Revert ONE change by its id (from site_status / site_history). Only when the person asks to undo / revert / restore a specific change - NOT to \"add\" or \"create\" a section (that is place_component with a template). A draft change is dropped from the draft; a live change gets a new draft change that puts the old value back (live after deploy). Needs approval.",
      inputSchema: z.object({ changeId: z.number().int(), reason: reasonSchema }),
      execute: async ({ changeId }) => safe(async () => {
        const c = await bridge.change(changeId).then((r) => r.change, () => null);
        const url = c?.object?.type === "post" ? c.object.url : extras.pageUrl?.();
        return checked(url, () => bridge.revert(changeId, ref())).then((r: any) => r?.change ? { ...r, change: changeView(r.change), changeId: r.change.id } : r);
      }),
    }),
  };

  // ---------------------------------------------------------------- images: see them, import them
  const fetchOpts = { fetchImpl: extras.fetchImpl, skipHostCheck: !!extras.allowPrivateImageHosts };
  const makeImage = extras.generateImage ?? generateImage;
  const media = {
    generate_image: tool({
      description:
        "Generate a NEW image with AI (e.g. a blog post's featured image) and add it to the Media Library with title and alt text. Costs money per image: generate ONE, " +
        "only when the person wants an AI image (not when they attached one or picked one from the Media Library). Returns the attachment id. Needs approval.",
      inputSchema: z.object({
        prompt: z.string().min(10).max(2000).describe("What the picture shows: subject, setting, style (e.g. editorial photo, flat illustration), mood, colours. No text or logos in the image."),
        alt: z.string().min(3).max(200).describe("Alt text describing the image for screen readers"),
        title: z.string().max(120).optional(),
        shape: z.enum(["landscape", "square", "portrait"]).default("landscape").describe("landscape for featured images"),
        reason: reasonSchema,
      }),
      execute: async ({ prompt, alt, title, shape }) => safe(async () => {
        const img = await makeImage(prompt + "\nNo text, letters, watermarks or logos in the image.", shape as ImageShape);
        const name = (title || alt).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "ai-image";
        const saved = files.save(img.buf, name + ".png", img.mime);
        const up = await bridge.uploadMedia(img.buf, name + ".png", img.mime, title ?? alt, alt);
        return { ok: true, ...up, fileId: saved.id, model: img.model, imageForModel: saved.id, imageCaption: "The generated image (now in the Media Library)" };
      }),
    }),
    find_media: tool({
      description: "Search the site's Media Library images (newest first): id, url, alt text, size. Use it when the person wants an image that is already on the site.",
      inputSchema: z.object({ search: z.string().optional() }),
      execute: async ({ search }) => safe(async () => ({
        ok: true,
        images: (await bridge.mediaList(search)).map((m: any) => ({ id: m.id, url: m.source_url, alt: m.alt_text, title: m.title?.rendered, width: m.media_details?.width, height: m.media_details?.height })),
      })),
    }),
    upload_media_from_chat: tool({
      description: "Upload an image the person attached in the chat to the Media Library. Returns the attachment id (use it in make_change: block.image, acf image fields, el.setting image controls, _thumbnail_id). Needs approval.",
      inputSchema: z.object({ fileId: z.string().describe("The id of the attached file (file_...)"), title: z.string().max(120).optional(), alt: z.string().max(200).optional() }),
      execute: async ({ fileId, title, alt }) => safe(async () => {
        const { meta, buf } = files.read(fileId);
        return { ok: true, ...(await bridge.uploadMedia(buf, meta.filename, meta.mime, title, alt)) };
      }),
    }),
    upload_media_from_url: tool({
      description: "Download an image from a public web address and add it to the Media Library (with title + alt text). Only real images up to 10 MB. Needs approval.",
      inputSchema: z.object({ url: z.string().url(), title: z.string().max(120).optional(), alt: z.string().max(200).describe("Alt text describing the image (accessibility)"), reason: reasonSchema }),
      execute: async ({ url, title, alt }) => safe(async () => {
        const img = await downloadImage(url, fetchOpts);
        const saved = files.save(img.buf, img.filename, img.mime);
        return { ok: true, source: img.finalUrl, fileId: saved.id, ...(await bridge.uploadMedia(img.buf, img.filename, img.mime, title, alt)) };
      }),
    }),
    view_image: tool({
      description: "LOOK at an image from a public web address (a design reference, an image on the site) - you see it right after this call. Read-only.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => safe(async () => {
        const img = await downloadImage(url, fetchOpts);
        const saved = files.save(img.buf, img.filename, img.mime);
        return { ok: true, fileId: saved.id, mime: img.mime, bytes: img.buf.length, imageForModel: saved.id, imageCaption: `Image from ${img.finalUrl}` };
      }),
    }),
  };

  const b = extras.browser;
  const browser = b ? {
    read_page: tool({
      description: "Read a page in a real browser like a person: title, headings, visible text, images (with alt and size), links. view draft (default) = with unpublished changes; live = what visitors see now.",
      inputSchema: z.object({ url: z.string().optional().describe("Page URL on this site (default: the page the person is on)"), device: deviceSchema, view: viewSchema }),
      execute: async (a) => safe(() => b.read!(a) as Promise<any>),
    }),
    inspect_element: tool({
      description:
        "Inspect an element in a real browser: its computed look (colour, font, size, spacing) AND every CSS rule that sets those styles, with the stylesheet file and media query. " +
        "Use it BEFORE a style change to find the winning rule (then write a more specific selector) - never guess. Works at desktop/tablet/mobile size, draft or live view.",
      inputSchema: z.object({
        text: z.string().optional().describe("Visible text of the element"), selector: z.string().optional().describe("A CSS selector"),
        url: z.string().optional().describe("Page URL on this site (default: the page the person is on)"), device: deviceSchema, view: viewSchema,
      }),
      execute: async (a) => safe(() => b.inspect(a) as Promise<any>),
    }),
    screenshot_page: tool({
      description: "Screenshot a page (or one element) at desktop, tablet or mobile size; you see the picture right after. Use it to compare with a reference image or check a new section/layout - routine changes are already checked automatically.",
      inputSchema: z.object({ url: z.string().optional(), text: z.string().optional().describe("Only the element with this text"), selector: z.string().optional(), device: deviceSchema, fullPage: z.boolean().optional(), view: viewSchema }),
      execute: async (a) => safe(async () => {
        const r: any = await b.screenshot(a);
        return r?.screenshotId ? { ...r, imageForModel: r.screenshotId, imageCaption: `Screenshot of ${r.target ?? "the page"} on ${r.device ?? "desktop"} (${r.url ?? ""})` } : r;
      }),
    }),
    ...(b.design ? {
      analyze_design: tool({
        description: "Measure the site's design language: fonts and sizes per heading level, colours, button style, container width, section spacing, CSS variables, breakpoints and the builder, plus `layout`: the width, height, padding and content width of the page's own sections (the rhythm a new section must follow), and the page background / text colour. Call it before designing anything new.",
        inputSchema: z.object({ url: z.string().optional(), device: deviceSchema }),
        execute: async (a) => safe(() => b.design!(a) as Promise<any>),
      }),
    } : {}),
  } : {};

  const sp = extras.speed;
  const speedTools = sp && extras.siteId ? {
    pagespeed_report: tool({
      description: "Run a Google PageSpeed report (Lighthouse) for a page of this site: the 4 scores (performance, accessibility, best practices, SEO), Core Web Vitals " +
        "(real visitors when Google has data, plus the lab test) and the top fixes with the affected elements. Takes 15-60 seconds. Use it when the person asks about speed, PageSpeed, " +
        "Core Web Vitals or a slow page, and again after fixing to compare. Sites on localhost are tested in this computer's browser (no real-visitor data).",
      inputSchema: z.object({ url: z.string().optional().describe("Page address (default: the page the person is on)"), device: z.enum(["mobile", "desktop", "both"]).default("mobile") }),
      execute: async ({ url, device }) => safe(async () => {
        const page = url || extras.pageUrl?.() || extras.siteUrl || bridge.homeUrl;
        if (!sameHost(extras.siteUrl || bridge.homeUrl, page)) return { ok: false, error: "Only pages of this site can be tested." };
        const devices: SpeedDevice[] = device === "both" ? ["mobile", "desktop"] : [device ?? "mobile"];
        const started = sp.start(extras.siteId!, page, devices);
        const run = await sp.wait(started.id);
        if (!run || run.status !== "done") return { ok: false, error: run?.error ?? "The report did not finish." };
        return { ok: true, url: page, reportId: run.id, reports: run.reports.map(summarize),
          note: "Shown to the person in the widget too (More, then PageSpeed report). Lead with the scores and the 2-3 fixes that matter most; fixes with assistantCanFix you can make as drafts (ask first), the others need plugin / hosting settings - explain where." };
      }),
    }),
  } : {};

  // ---- plugin updates (Livecrafts plugin 0.19+): backup -> update -> health check -> keep or restore automatically
  const pluginTools = {
    list_plugins: tool({
      description: "List the site's installed plugins: version, active, available update (and whether it is compatible), saved backups for rollback. " +
        "Use it when the person asks about plugin updates or before updating / rolling back. refresh=true asks WordPress.org again for updates.",
      inputSchema: z.object({ refresh: z.boolean().default(false) }),
      execute: async ({ refresh }) => safe(async () => {
        const r = await bridge.plugins(!!refresh);
        return { canModify: r.canModify, blocked: r.blocked || undefined, wp: r.wp, php: r.php,
          plugins: r.plugins.map((p) => ({ plugin: p.plugin, name: p.name, version: p.version, active: p.active, update: p.update, backups: p.backups.map((b) => b.version), self: p.self || undefined, dbHeavy: p.dbHeavy || undefined })),
          note: "Updates go LIVE at once (no draft). Each update keeps a backup, loads the homepage and wp-admin afterwards and restores the old version by itself if they break. Livecrafts itself is updated by uploading its zip. Update one plugin at a time." };
      }),
    }),
    update_plugin: tool({
      description: "LIVE AT ONCE: update ONE plugin (its plugin file, e.g. 'wordpress-seo/wp-seo.php', from list_plugins). Saves a backup first; if the homepage or wp-admin break afterwards the old version is restored automatically. " +
        "For plugins that change the database (Elementor, WooCommerce, Yoast...) say that rollback restores files only and suggest a hosting backup first. Needs approval.",
      inputSchema: z.object({ plugin: z.string().min(3).max(200) }),
      execute: async ({ plugin }) => safe(async () => {
        const jobs = pluginJobs();
        const j = await jobs.wait(jobs.start(extras.siteId ?? "chat", bridge, plugin).id);
        if (!j || j.error) throw new Error(j?.error ?? "The update did not finish.");
        return j.result;
      }),
    }),
    rollback_plugin: tool({
      description: "LIVE AT ONCE: put a plugin back to an older version - by default the newest saved backup that differs from the installed version; or a given version " +
        "(from its backups, or an official WordPress.org version). Use when the person says a plugin update broke something or asks to go back. Needs approval.",
      inputSchema: z.object({ plugin: z.string().min(3).max(200), version: z.string().max(40).optional() }),
      execute: async ({ plugin, version }) => safe(() => bridge.rollbackPlugin(plugin, version ? { version } : {})),
    }),
  };

  const sf = extras.siteFiles;
  const fileTools = sf ? {
    list_files: tool({
      description: "List theme files (paths relative to the WordPress folder), e.g. wp-content/themes/<theme>.",
      inputSchema: z.object({ directory: z.string().default("wp-content/themes") }),
      execute: async ({ directory }) => safe(() => sf.list(directory ?? "wp-content/themes")),
    }),
    read_file: tool({
      description: "Read a theme file exactly (path relative to the WordPress folder). Long files in parts with fromLine/maxLines.",
      inputSchema: z.object({ path: z.string(), fromLine: z.number().int().min(1).optional(), maxLines: z.number().int().min(1).max(3000).optional() }),
      execute: async ({ path, fromLine, maxLines }) => safe(() => sf.read(path, fromLine, maxLines)),
    }),
    ...(extras.allowThemeWrites ? {
      edit_file: tool({
        description:
          "LIVE AT ONCE (theme files cannot be drafts, but the edit is recorded in the site history like every change: revert_change undoes it, Discard all and resets put the file back): edit a theme file by replacing ONE exact, unique snippet copied from read_file. Only when no draft change can do it (e.g. text hard-coded in a template). " +
          "Say clearly that it is live immediately. PHP is syntax-checked, a backup is kept, and a broken page is restored automatically. Needs approval.",
        inputSchema: z.object({ path: z.string(), find: z.string().min(1).max(30_000), replace: z.string().max(60_000), reason: reasonSchema, checkUrl: z.string().optional() }),
        execute: async ({ path, find, replace, checkUrl }) => safe(() => sf.edit(path, find, replace, [bridge.homeUrl, ...(checkUrl ? [checkUrl] : [])])),
      }),
      create_file: tool({
        description: "LIVE AT ONCE: create a new theme file (e.g. a template part). Needs approval.",
        inputSchema: z.object({ path: z.string(), content: z.string().min(1).max(100_000), reason: reasonSchema }),
        execute: async ({ path, content }) => safe(() => sf.create(path, content, [bridge.homeUrl])),
      }),
      restore_file: tool({
        description: "Put a theme file back from its backupId (from edit_file/create_file) - the same as revert_change on its change id. Live at once. Needs approval.",
        inputSchema: z.object({ backupId: z.string(), reason: reasonSchema }),
        execute: async ({ backupId }) => safe(() => sf.restore(backupId, [bridge.homeUrl])),
      }),
    } : {}),
  } : {};

  const hg = extras.hostinger;
  const apiTools = hg ? {
    hostinger_read: tool({
      description: "Ask the Hostinger API a READ-ONLY question (e.g. wordpress_plugins_list-installed, hosting_websites_list). Use hostinger_search first if you do not know the operation name.",
      inputSchema: z.object({ operation: z.string(), params: z.record(z.string(), z.any()).default({}) }),
      execute: async ({ operation, params }) => safe(async () => {
        if (!(await hg.isReadOnly(operation))) return { ok: false, error: `"${operation}" is not a read-only operation (or unknown), so it is not allowed from the chat.` };
        return { ok: true, result: await hg.execute(operation, params ?? {}) };
      }),
    }),
    hostinger_search: tool({
      description: "Search the Hostinger API catalogue for operation names and their parameters.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => safe(async () => ({ ok: true, results: (await hg.search(query, 6)).slice(0, 12_000) })),
    }),
  } : {};

  const sk = extras.skills;
  const skillsLoaded = new Set<string>();
  const filesLoaded = new Set<string>(); // "name/file", so a second read of the SAME skill+file this request is free
  const skillTools = sk && sk.list().length ? {
    load_skill: tool({
      description: "Load an official WordPress skill (expert instructions) before work in its area. Default file is SKILL.md; its references/*.md files can be loaded too. Load only the skills that actually apply to THIS request - most requests need just the 3-4 named in your instructions, never the whole catalogue. Loading the same skill+file twice in one request returns a short notice instead of the text again (you already have it).",
      inputSchema: z.object({
        // Several at once: the instructions name three or four skills for one request, and asking for them one at
        // a time cost three or four model round trips before any work started.
        name: z.union([z.string(), z.array(z.string()).max(6)]).describe("One skill name, or several to load in one go"),
        file: z.string().optional().describe("e.g. references/theme-json.md (only with a single name)"),
      }),
      execute: async (a: { name: string | string[]; file?: string }) => safe(async () => {
        /** One skill, remembered for this request so the same text is never paid for twice. */
        const loadOne = (name: string, file?: string) => {
          const key = name + "/" + (file || "SKILL.md");
          if (filesLoaded.has(key)) return { ok: true, name, file: file || "SKILL.md", alreadyLoaded: true, note: "Already loaded earlier in this request - use what you read then, do not load it again." };
          const r = sk!.load(name, file);
          skillsLoaded.add(name);
          filesLoaded.add(key);
          return r;
        };
        if (Array.isArray(a.name)) return { ok: true, skills: a.name.map((n) => loadOne(n)) };
        return loadOne(a.name, a.file);
      }),
    }),
  } : {};

  const planTools = extras.planTool ? {
    propose_plan: tool({
      description: "Show the person your plan for THIS request before the first change: one-line summary + concrete steps (which page, what changes). They approve it once; then the steps run without more questions.",
      inputSchema: z.object({ summary: z.string().min(3).max(300), steps: z.array(z.string().min(3).max(300)).min(1).max(15) }),
      execute: async ({ steps }) => ({ ok: true, approved: true, steps: steps.length, note: "Plan approved. Carry out every step now, check each one, then report." }),
    }),
  } : {};

  const askTools = {
    ask_person: tool({
      description:
        "Ask the person EVERYTHING you still need, in ONE go. The chat shows it as a small form they fill in and send back - so they answer once instead of being asked question after question.\n" +
        "Only for facts you cannot find or decide: the real words, a phone number, which page, which of two things they meant. NEVER for design (colour, spacing, wording, which template) - decide that yourself from the site. For which LAYOUT a section uses, do not ask in words either: offer_layouts shows them the choice as pictures.\n" +
        "Call it once, then STOP and wait for the answer. Do not call it again in the same step, and never ask the same thing in prose as well.",
      inputSchema: z.object({
        intro: z.string().max(200).optional().describe("One line of context, e.g. 'To build the home page I need a few facts.'"),
        questions: z.array(z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).describe("A short name for the answer, e.g. phone"),
          question: z.string().min(3).max(200),
          options: z.array(z.string().min(1).max(60)).max(5).optional().describe("Give 2-5 choices when the answer is a pick, not free text"),
          placeholder: z.string().max(80).optional(),
          optional: z.boolean().optional(),
        })).min(1).max(6),
      }),
      execute: async ({ intro, questions }) => ({
        ok: true, asked: questions.length, intro,
        note: "The person is being shown these as a form. Stop now and wait for their answer; do not repeat the questions in your reply.",
      }),
    }),
  };

  /**
   * Letting the PERSON pick a layout. Everything else about design the assistant decides from the site, but which
   * layout a section uses changes what the page says about them, and they can judge that from a picture faster than
   * from any description. The chat renders each layout of the template from their own site, with their own brand.
   * Turned off per conversation, in which case the tool is not offered at all and the assistant simply chooses.
   */
  const layoutTools = extras.layoutPicker === false ? {} : {
    offer_layouts: tool({
      description:
        "Show the person the layouts of ONE template as real pictures and let them pick. Use it ONCE, just before you place a section whose layout changes the character of the page - a hero above all, or a section they asked to make 'look better'.\n" +
        "Do NOT use it for small edits, for a section whose layout they already chose, or more than once in a request. Never ask about colour, spacing or wording this way - those you still decide from the site.\n" +
        "Call it, then STOP and wait: their choice comes back as an ordinary message naming the layout.",
      inputSchema: z.object({
        template: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/).describe('The template id, e.g. "hero"'),
        intro: z.string().max(200).optional().describe("One line: what this section is for, e.g. 'Pick how the top of the home page should look.'"),
        variants: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,20}$/)).min(2).max(8).optional()
          .describe("Only these layouts, when some do not fit what they asked for. Leave it out to show them all."),
      }),
      execute: async ({ template, intro, variants }) => ({
        ok: true, template, intro, variants: variants ?? null,
        note: "The person is being shown each layout rendered from their own site. Stop now and wait for their answer; do not describe the layouts in your reply as well.",
      }),
    }),
  };

  const componentTools = makeComponentTools({ bridge, safe, postIdOf, checked, changeView, parseValue, ref, pageUrl: () => extras.pageUrl?.(), skillsLoaded, design: extras.browser?.design ? (url?: string) => extras.browser!.design!({ url, device: "desktop" }) as Promise<any> : undefined,
    screenshot: extras.browser?.screenshot ? (a: { url?: string; selector?: string; device?: Device; view?: "draft" | "live" }) => extras.browser!.screenshot!(a) as Promise<any> : undefined });

  return inOrder({ ...reading, ...writing, ...media, ...browser, ...speedTools, ...pluginTools, ...fileTools, ...apiTools, ...skillTools, ...planTools, ...askTools, ...layoutTools, ...componentTools });
}

/**
 * The calls of one step run at the same time. For reads that is the point; for changes it is a race. A step that
 * reverted the old testimonials and placed the new slider ran both at once, the revert landed last and wiped out the
 * slider; a screenshot sent with a change pictured the page before it. So: changes run one at a time, in the order
 * they were asked for, and every other call waits for the changes asked for before it. Reads with no change between
 * them still run together.
 */
export function inOrder<T extends Record<string, any>>(tools: T): T {
  let changes: Promise<unknown> = Promise.resolve(); // settles when every change asked for so far is done
  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!t || typeof t.execute !== "function") { out[name] = t; continue; }
    const execute = t.execute;
    const writes = WRITE_TOOLS.has(name) || (APPROVAL_REQUIRED as readonly string[]).includes(name);
    out[name] = {
      ...t,
      execute: (...args: any[]) => {
        const run = () => execute.apply(t, args);
        const done = changes.then(run, run);
        if (writes) changes = done.then(() => {}, () => {});
        return done;
      },
    };
  }
  return out as T;
}

/** Tools that must never run without a human saying yes (in "every" mode; one plan approval in "request" mode). */
export const APPROVAL_REQUIRED = [
  "make_change", "create_page", "create_blog_post", "generate_image", "set_post_terms", "revert_change", "place_component", "upload_media_from_chat", "upload_media_from_url", "edit_file", "create_file", "restore_file", "update_plugin", "rollback_plugin",
] as const;

/** Tools that change the site (they create history entries). */
export const WRITE_TOOLS = new Set<string>(["make_change", "create_page", "create_blog_post", "revert_change", "place_component", "edit_file", "create_file", "restore_file"]);

export type PostTypeName = PostType;
