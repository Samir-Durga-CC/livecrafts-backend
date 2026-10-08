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

/** The page map can be big; give the model a compact, stable view of it. */
function compactMap(m: any) {
  const values = [...(m.acf ?? []).filter((e: any) => e.kind === "acf"), ...(m.elementor ?? [])].slice(0, 200).map((e: any) => ({
    target: e.tid, label: e.label, type: e.ftype,
    value: e.ftype === "image" ? `[image id ${e.value}] ${e.url}` : String(e.value).slice(0, 200),
  }));
  const rows = (m.acf ?? []).filter((e: any) => e.kind === "acf-rows").map((e: any) => ({ rows: e.name, label: e.label, type: e.ftype, count: e.rows, min: e.min, max: e.max, layouts: e.layouts }));
  return {
    ok: true, view: m.view, post: m.post, builders: m.builders, drafts: m.drafts, values, acfRows: rows.length ? rows : undefined,
    elementorOutline: m.elementor_outline?.length ? m.elementor_outline.slice(0, 250) : undefined,
    howToChange: "acf:<field key>:<post> → make_change kind acf.field target <field key>; acfv:<meta>:<post> → kind acf.value target <meta>; el:<post>:<id>:<setting> → kind el.setting target <id>:<setting>.",
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
  fetchImpl?: typeof fetch;             // tests: fake the internet for image downloads
  allowPrivateImageHosts?: boolean;     // tests/demo only
}

const deviceSchema = z.enum(["desktop", "tablet", "mobile"]).optional().describe("Screen size (default desktop)");
const viewSchema = z.enum(["draft", "live"]).optional().describe("draft = with the unpublished changes, as editors see it (default); live = what visitors see now");
const postTypeSchema = z.enum(["pages", "posts"]).describe("pages or posts");
const reasonSchema = z.string().max(300).describe("One short sentence for the person approving: what changes and why");

export const CHANGE_KINDS = [
  "post.field", "post.meta", "acf.field", "acf.value", "acf.rows",
  "el.setting", "el.insert", "el.remove", "el.duplicate", "el.move",
  "block.text", "block.link", "block.image", "block.class", "block.replace", "block.insert", "block.remove", "block.move", "block.duplicate",
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
  const postCache = new Map<string, number>();
  const postIdOf = async (url?: string, post?: number) => {
    if (post) return post;
    const u = url || extras.pageUrl?.() || bridge.homeUrl;
    if (!postCache.has(u)) postCache.set(u, Number((await bridge.map({ url: u, view: "draft" }))?.post?.id));
    return postCache.get(u)!;
  };
  /** Run a write; for one that changed a page, check it in a real browser before the model hears back. */
  const checked = async (pageUrl: string | undefined, write: () => Promise<any>, opts: { component?: string } = {}) => {
    const v = extras.verifier;
    const before = v && pageUrl ? await v.before(pageUrl) : null;
    const res = await write();
    if (res?.ok === false || res?.unchanged || !v || !pageUrl || !res?.change) return res;
    if (res.change.kind === "post.create") return { ...res, verification: { passed: true, summary: "New pages are drafts: open the preview link to see them; they are published on deploy.", checks: [] } };
    return { ...res, verification: await v.after(pageUrl, res.change, before, opts) };
  };

  const reading = {
    site_status: tool({
      description:
        "What is going on on this site right now, like `git status`: the draft changes not deployed yet (per page, with ids), conflicts (someone changed the live site under a draft), " +
        "the last release, and changes made OUTSIDE Livecrafts since then (WP admin, Elementor editor - by whom). Call it at the start of a request that touches existing work, and before reverting.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => {
        const s = await bridge.status();
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
      description: "Your notes about this site and about a page (what you learned last time: where things are stored, brand rules, pitfalls). Read them before working on a page you have not read notes for in this chat.",
      inputSchema: z.object({ url: z.string().optional().describe("Page URL (default: the page the person is on)") }),
      execute: async ({ url }) => safe(async () => {
        const r = await bridge.notes(await postIdOf(url));
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
        "(element ids, types, nesting, short text). Choose change targets from here. view draft (default) includes unpublished changes.",
      inputSchema: z.object({ url: z.string().optional().describe("Full page URL (default: the page the person is on, else the home page)"), view: viewSchema }),
      execute: async ({ url, view }) => safe(async () => compactMap(await bridge.map({ url: url || extras.pageUrl?.() || bridge.homeUrl, view: view ?? "draft" }))),
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
        const r = await bridge.createPage({ title: a.title, content: a.content, type: a.type, slug: a.slug, parent: a.parent, template: a.template, excerpt: a.excerpt, ref: ref() });
        return { ...r, change: changeView(r.change), changeId: r.change?.id, note: "Draft page. Preview it with the preview link; it goes live when a person deploys." };
      }),
    }),
    revert_change: tool({
      description: "Revert ONE change by its id (from site_status / site_history). A draft change is dropped from the draft; a live change gets a new draft change that puts the old value back (live after deploy). Needs approval.",
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
  const media = {
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
        description: "Measure the site's design language: fonts and sizes per heading level, colours, button style, container width, section spacing, CSS variables, breakpoints and the builder. Call it before designing anything new.",
        inputSchema: z.object({ url: z.string().optional(), device: deviceSchema }),
        execute: async (a) => safe(() => b.design!(a) as Promise<any>),
      }),
    } : {}),
  } : {};

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
  const skillTools = sk && sk.list().length ? {
    load_skill: tool({
      description: "Load an official WordPress skill (expert instructions) before work in its area. Default file is SKILL.md; its references/*.md files can be loaded too.",
      inputSchema: z.object({ name: z.string(), file: z.string().optional().describe("e.g. references/theme-json.md") }),
      execute: async ({ name, file }) => safe(async () => { const r = sk.load(name, file); skillsLoaded.add(name); return r; }),
    }),
  } : {};

  const planTools = extras.planTool ? {
    propose_plan: tool({
      description: "Show the person your plan for THIS request before the first change: one-line summary + concrete steps (which page, what changes). They approve it once; then the steps run without more questions.",
      inputSchema: z.object({ summary: z.string().min(3).max(300), steps: z.array(z.string().min(3).max(300)).min(1).max(15) }),
      execute: async ({ steps }) => ({ ok: true, approved: true, steps: steps.length, note: "Plan approved. Carry out every step now, check each one, then report." }),
    }),
  } : {};

  const componentTools = makeComponentTools({ bridge, safe, postIdOf, checked, changeView, parseValue, ref, pageUrl: () => extras.pageUrl?.(), skillsLoaded });

  return { ...reading, ...writing, ...media, ...browser, ...fileTools, ...apiTools, ...skillTools, ...planTools, ...componentTools };
}

/** Tools that must never run without a human saying yes (in "every" mode; one plan approval in "request" mode). */
export const APPROVAL_REQUIRED = [
  "make_change", "create_page", "revert_change", "place_component", "upload_media_from_chat", "upload_media_from_url", "edit_file", "create_file", "restore_file",
] as const;

/** Tools that change the site (they create history entries). */
export const WRITE_TOOLS = new Set<string>(["make_change", "create_page", "revert_change", "place_component", "edit_file", "create_file", "restore_file"]);

export type PostTypeName = PostType;
