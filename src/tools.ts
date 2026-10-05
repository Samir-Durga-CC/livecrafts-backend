import { tool } from "ai";
import { z } from "zod";
import { Bridge, BridgeError, type PostType } from "./bridge.js";
import type { FileStore } from "./files.js";
import type { SiteFiles } from "./sitefiles.js";
import type { HostingerClient } from "./hostinger.js";
import type { Device } from "./browser.js";
import { downloadImage } from "./net.js";
import { postBackups, type ChangeRecord } from "./changes.js";
import type { Skills } from "./skills.js";
import { newId } from "./store.js";
import { applyStylePatch } from "./manual.js";

/** Expected failures become a normal tool result the model can read and react to (instead of crashing the loop). */
async function safe<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string; status?: number; code?: string }> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BridgeError) return { ok: false, error: e.message, status: e.status, code: e.code };
    return { ok: false, error: (e as Error).message };
  }
}

/** The page map can be big; give the model a compact, stable view of it. */
function compactMap(m: any) {
  const entries = [...(m.acf ?? []), ...(m.elementor ?? [])].slice(0, 200).map((e: any) => ({
    target: e.tid,
    source: e.kind === "el" ? "elementor" : "acf",
    label: e.label,
    setting: e.name,
    type: e.ftype,
    value: e.ftype === "image" ? `[image id ${e.value}] ${e.url}` : String(e.value).slice(0, 200),
  }));
  return { ok: true, post: m.post, builders: m.builders, targets: entries, note: m.note };
}

/** Optional capabilities, present only when they are configured for this site / job. */
export interface ToolExtras {
  siteFiles?: SiteFiles | null;         // Livecrafts plugin 0.7+ and/or Hostinger (linked site)
  hostinger?: HostingerClient | null;   // read-only API questions
  browser?: {
    inspect: (a: { url?: string; text?: string; selector?: string; device?: Device }) => Promise<unknown>;
    screenshot: (a: { url?: string; selector?: string; text?: string; device?: Device; fullPage?: boolean }) => Promise<unknown>;
    design?: (a: { url?: string; device?: Device }) => Promise<unknown>;
  } | null;
  skills?: Skills | null;
  changes?: { list(): ChangeRecord[]; revert(id: string): Promise<Record<string, unknown>> } | null;
  planTool?: boolean;                   // "once per request" approval mode: offer propose_plan
  fetchImpl?: typeof fetch;             // tests: fake the internet for image downloads
  allowPrivateImageHosts?: boolean;     // tests/demo only
}

const deviceSchema = z.enum(["desktop", "tablet", "mobile"]).optional().describe("Screen size to use (default desktop)");
const postTypeSchema = z.enum(["pages", "posts"]).describe("pages or posts");
const reasonSchema = z.string().max(300).describe("One short sentence for the person approving: what changes and why");
const statusSchema = z.enum(["publish", "draft"]).default("publish");

export function makeTools(bridge: Bridge, files: FileStore, extras: ToolExtras = {}) {
  const healthUrls = (extra?: string) => [bridge.homeUrl, ...(extra && extra !== bridge.homeUrl ? [extra] : [])];

  const content = {
    list_pages: tool({
      description: "List the pages of this WordPress site (id, title, url). Use it when the user names a page but gives no URL.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => ({ ok: true, pages: (await bridge.listPages()).map((p) => ({ id: p.id, title: p.title?.rendered, url: p.link, status: p.status })) })),
    }),

    get_page_map: tool({
      description:
        "Get every editable CONTENT field on a page (ACF fields / Elementor widgets): each entry has a stable `target` id, a label, its type and its CURRENT value. " +
        "Call this before changing any text/link/image in those fields, and choose targets only from this list.",
      inputSchema: z.object({ url: z.string().optional().describe("Full public URL of the page. Omit for the site home page.") }),
      execute: async ({ url }) => safe(async () => compactMap(await bridge.map({ url: url ?? bridge.homeUrl }))),
    }),

    read_target: tool({
      description: "Read one content target straight from the database: stored value, field/widget definition, and recent changes.",
      inputSchema: z.object({ target: z.string().describe("A target id from get_page_map") }),
      execute: async ({ target }) => safe(() => bridge.readTarget(target)),
    }),

    find_text: tool({
      description: "Find where given texts are stored in the database (post content, menu, widget, Elementor JSON ...). Use it when a text the user mentions is NOT in get_page_map.",
      inputSchema: z.object({ postId: z.number().int(), texts: z.array(z.string()).min(1).max(10) }),
      execute: async ({ postId, texts }) => safe(() => bridge.locate(postId, texts)),
    }),

    set_content: tool({
      description:
        "Change ONE content value (text, link URL or image) of a target from get_page_map. For an image field pass the Media Library attachment id. " +
        "The person must approve every call. The server validates, writes, reads it back and rolls back if it did not stick.",
      inputSchema: z.object({
        target: z.string().regex(/^(acf|el):/).describe("Exact target id from get_page_map"),
        value: z.string().max(5000).describe("The new value"),
        reason: reasonSchema,
      }),
      execute: async ({ target, value }) => safe(async () => {
        // Remember the old value so this exact change can be reverted later.
        const raw = await bridge.readTarget(target).then((d: any) => d?.stored_raw, () => undefined);
        const previous = raw === null || raw === undefined ? "" : typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
        const res: any = await bridge.setTarget(target, value);
        return { ...res, previous };
      }),
    }),

    verify_page: tool({
      description: "Open the PUBLIC page like a visitor (not logged in, cache-busted) and check that TEXTS are present / gone. For colours, fonts or layout use inspect_element / screenshot_page instead.",
      inputSchema: z.object({
        url: z.string(),
        expectPresent: z.array(z.string()).max(10).default([]),
        expectAbsent: z.array(z.string()).max(10).default([]),
      }),
      execute: async ({ url, expectPresent, expectAbsent }) => safe(() => bridge.verifyPage(url, expectPresent ?? [], expectAbsent ?? [])),
    }),

    undo_last_change: tool({
      description: "Undo the most recent ACF/Elementor change made with set_content on a page. Prefer revert_change, which can undo ANY change of this chat. Needs approval.",
      inputSchema: z.object({ postId: z.number().int().describe("Post id of the page the change was made on") }),
      execute: async ({ postId }) => safe(() => bridge.undo("p" + postId)),
    }),
  };

  // ---------------------------------------------------------------- pages, posts and menus (standard WordPress REST API)
  const pages = {
    find_posts: tool({
      description: "Search pages or blog posts (published, drafts, private) by title/text. Returns id, title, status, url, template.",
      inputSchema: z.object({ type: postTypeSchema, search: z.string().optional() }),
      execute: async ({ type, search }) => safe(async () => ({ ok: true, items: (await bridge.listPosts(type, search)).map((p: any) => ({ id: p.id, title: p.title?.raw ?? p.title?.rendered, status: p.status, url: p.link, template: p.template || "default" })) })),
    }),
    read_post: tool({
      description: "Read the RAW editable content (block markup) of a page or post, plus title, status, url and template. Use before edit_post_content.",
      inputSchema: z.object({ type: postTypeSchema, id: z.number().int() }),
      execute: async ({ type, id }) => safe(async () => {
        const p: any = await bridge.getPost(type, id);
        const raw = String(p?.content?.raw ?? "");
        return { ok: true, id: p.id, title: p.title?.raw, status: p.status, url: p.link, template: p.template || "default", length: raw.length, content: raw.slice(0, 60_000), truncated: raw.length > 60_000 };
      }),
    }),
    create_page: tool({
      description:
        "Create a NEW WordPress page. `content` must be WordPress block markup (core blocks: wp:group, wp:columns, wp:heading, wp:paragraph, wp:image, wp:buttons, " +
        "wp:latest-posts or wp:query for a blog list ...), responsive by design (no fixed pixel widths). Needs approval. Returns the id and URL.",
      inputSchema: z.object({
        title: z.string().min(1).max(200), content: z.string().max(200_000), status: statusSchema,
        slug: z.string().max(100).optional(), parent: z.number().int().optional(), excerpt: z.string().max(1000).optional(), reason: reasonSchema,
      }),
      execute: async ({ title, content: body, status, slug, parent, excerpt }) => safe(async () => {
        const p: any = await bridge.createPost("pages", { title, content: body, status, ...(slug ? { slug } : {}), ...(parent ? { parent } : {}), ...(excerpt ? { excerpt } : {}) });
        return { ok: true, id: p.id, link: p.link, status: p.status, title: p.title?.raw ?? title, note: status === "draft" ? "Drafts are only visible when logged in." : "The page is live." };
      }),
    }),
    create_post: tool({
      description: "Create a NEW blog post (block markup content, optional excerpt and featured image = Media Library id). Needs approval.",
      inputSchema: z.object({
        title: z.string().min(1).max(200), content: z.string().max(200_000), status: statusSchema,
        excerpt: z.string().max(1000).optional(), featuredMediaId: z.number().int().optional(), reason: reasonSchema,
      }),
      execute: async ({ title, content: body, status, excerpt, featuredMediaId }) => safe(async () => {
        const p: any = await bridge.createPost("posts", { title, content: body, status, ...(excerpt ? { excerpt } : {}), ...(featuredMediaId ? { featured_media: featuredMediaId } : {}) });
        return { ok: true, id: p.id, link: p.link, status: p.status, title: p.title?.raw ?? title };
      }),
    }),
    edit_post_content: tool({
      description:
        "Change part of a page's/post's block content by replacing ONE exact, unique snippet (copy `find` from read_post). " +
        "To add a section, replace an existing block with itself + the new block markup. Needs approval; a backup is kept and the result is read back.",
      inputSchema: z.object({ type: postTypeSchema, id: z.number().int(), find: z.string().min(1).max(100_000), replace: z.string().max(200_000), reason: reasonSchema }),
      execute: async ({ type, id, find, replace }) => safe(async () => {
        const p: any = await bridge.getPost(type, id);
        const before = String(p?.content?.raw ?? "");
        const count = before.split(find).length - 1;
        if (count === 0) return { ok: false, error: "The text to replace was not found. Call read_post again and copy the exact snippet." };
        if (count > 1) return { ok: false, error: `The text to replace appears ${count} times. Include more surrounding text so it is unique.` };
        const at = before.indexOf(find);
        const after = before.slice(0, at) + replace + before.slice(at + find.length);
        const backup = postBackups().put({ id: newId("pbk"), siteId: bridge.site.id, type, postId: id, before, after, createdAt: new Date().toISOString() });
        await bridge.updatePost(type, id, { content: after });
        const check: any = await bridge.getPost(type, id);
        const stuck = String(check?.content?.raw ?? "") === after;
        if (!stuck) {
          await bridge.updatePost(type, id, { content: before }).catch(() => {});
          return { ok: false, error: "WordPress changed or rejected the new content (often a security filter removing HTML). The original was put back." };
        }
        return { ok: true, id, link: check.link, backupId: backup.id, verified: true };
      }),
    }),
    set_post_status: tool({
      description: "Publish a draft, or switch a page/post back to draft. Needs approval.",
      inputSchema: z.object({ type: postTypeSchema, id: z.number().int(), status: z.enum(["publish", "draft", "private"]), reason: reasonSchema }),
      execute: async ({ type, id, status }) => safe(async () => {
        const cur: any = await bridge.getPost(type, id);
        const p: any = await bridge.updatePost(type, id, { status });
        return { ok: p?.status === status, id, link: p.link, status: p.status, previousStatus: cur.status };
      }),
    }),
    get_menus: tool({
      description: "Navigation menus: the theme's menu locations (and which menu is assigned), every menu and its items (id, title, url, order). Call before changing the navigation.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => {
        const [locations, menus] = await Promise.all([bridge.menuLocations(), bridge.menus()]);
        const withItems = await Promise.all(menus.map(async (m: any) => ({
          id: m.id, name: m.name, locations: m.locations,
          items: (await bridge.menuItems(m.id)).map((i: any) => ({ id: i.id, title: i.title?.raw ?? i.title?.rendered, url: i.url, order: i.menu_order, parent: i.parent })),
        })));
        return {
          ok: true,
          locations: Object.values(locations ?? {}).map((l: any) => ({ location: l.name, description: l.description, menuId: l.menu || null })),
          menus: withItems,
          note: "If a location has no menu, the theme shows its own fallback links. Creating a menu for that location REPLACES the fallback, so include those links too.",
        };
      }),
    }),
    create_menu: tool({
      description: "Create a navigation menu, assign it to a theme location and fill it with links (in order). Needs approval.",
      inputSchema: z.object({
        name: z.string().min(1).max(80), location: z.string().describe("Theme location, e.g. primary"),
        items: z.array(z.object({ title: z.string().min(1).max(80), url: z.string().optional(), pageId: z.number().int().optional() })).min(1).max(30),
        reason: reasonSchema,
      }),
      execute: async ({ name, location, items }) => safe(async () => {
        const menu: any = await bridge.createMenu(name, [location]);
        const created: number[] = [];
        try {
          for (const [n, it] of items.entries()) {
            const item: any = await bridge.createMenuItem({ menus: menu.id, title: it.title, menu_order: n + 1, ...(it.pageId ? { type: "post_type", object: "page", object_id: it.pageId } : { type: "custom", url: it.url ?? "#" }) });
            created.push(item.id);
          }
        } catch (e) { await bridge.deleteMenu(menu.id).catch(() => {}); throw e; }
        return { ok: true, menuId: menu.id, location, items: created.length };
      }),
    }),
    add_menu_item: tool({
      description: "Add ONE link to an existing menu (to a page by pageId, or any url). position = 1-based place in the menu (default: last). Needs approval.",
      inputSchema: z.object({ menuId: z.number().int(), title: z.string().min(1).max(80), url: z.string().optional(), pageId: z.number().int().optional(), position: z.number().int().min(1).optional(), reason: reasonSchema }),
      execute: async ({ menuId, title, url, pageId, position }) => safe(async () => {
        if (!url && !pageId) return { ok: false, error: "Give a url or a pageId." };
        const existing = await bridge.menuItems(menuId);
        const order = position ?? existing.length + 1;
        const item: any = await bridge.createMenuItem({ menus: menuId, title, menu_order: order, ...(pageId ? { type: "post_type", object: "page", object_id: pageId } : { type: "custom", url }) });
        return { ok: true, itemId: item.id, menuId, position: order };
      }),
    }),
  };

  // ---------------------------------------------------------------- images: see them, import them
  const fetchOpts = { fetchImpl: extras.fetchImpl, skipHostCheck: !!extras.allowPrivateImageHosts };
  const media = {
    upload_media_from_chat: tool({
      description: "Upload an image the person attached in the chat to this site's Media Library. Returns the attachment id and URL (use the id with set_content or as featured image). Needs approval.",
      inputSchema: z.object({ fileId: z.string().describe("The id of the attached file (file_...)"), title: z.string().max(120).optional(), alt: z.string().max(200).optional() }),
      execute: async ({ fileId, title, alt }) => safe(async () => {
        const { meta, buf } = files.read(fileId);
        return { ok: true, ...(await bridge.uploadMedia(buf, meta.filename, meta.mime, title, alt)) };
      }),
    }),
    upload_media_from_url: tool({
      description: "Download an image from a public web address and add it to this site's Media Library (with title + alt text). Only real images up to 10 MB. Needs approval.",
      inputSchema: z.object({ url: z.string().url(), title: z.string().max(120).optional(), alt: z.string().max(200).describe("Alt text describing the image (accessibility)"), reason: reasonSchema }),
      execute: async ({ url, title, alt }) => safe(async () => {
        const img = await downloadImage(url, fetchOpts);
        const saved = files.save(img.buf, img.filename, img.mime);
        return { ok: true, source: img.finalUrl, fileId: saved.id, ...(await bridge.uploadMedia(img.buf, img.filename, img.mime, title, alt)) };
      }),
    }),
    view_image: tool({
      description: "LOOK at an image from a public web address (e.g. a design reference or an image on the site) - you will see it right after this call. Read-only.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => safe(async () => {
        const img = await downloadImage(url, fetchOpts);
        const saved = files.save(img.buf, img.filename, img.mime);
        return { ok: true, fileId: saved.id, mime: img.mime, bytes: img.buf.length, imageForModel: saved.id, imageCaption: `Image from ${img.finalUrl}` };
      }),
    }),
  };

  const browser = extras.browser ? {
    inspect_element: tool({
      description:
        "Open the live page in a real browser and inspect an element: what it looks like (computed colour, font, size, spacing) AND every CSS rule that sets those styles, " +
        "with the stylesheet `file` path. Use it BEFORE a style change (to find the exact rule and file) and AFTER (to verify the new computed value). Works at desktop/tablet/mobile size.",
      inputSchema: z.object({
        text: z.string().optional().describe("Visible text of the element, e.g. the heading text"),
        selector: z.string().optional().describe("A CSS selector, if you know it"),
        url: z.string().optional().describe("Page URL on this site (default: home page)"),
        device: deviceSchema,
      }),
      execute: async (a) => safe(() => extras.browser!.inspect(a) as Promise<any>),
    }),
    screenshot_page: tool({
      description: "Screenshot the live page (or one element) at desktop, tablet or mobile size; you see the picture right after the call. Use it ONLY when you really need to look: comparing with a reference image, checking a new section/layout, or when the person asks to see it. Do NOT screenshot routine text/colour changes - the person's page reloads to show them; verify those with inspect_element or verify_page.",
      inputSchema: z.object({
        url: z.string().optional(), text: z.string().optional().describe("Screenshot just the element with this text"),
        selector: z.string().optional(), device: deviceSchema, fullPage: z.boolean().optional(),
      }),
      execute: async (a) => safe(async () => {
        const r: any = await extras.browser!.screenshot(a);
        return r?.screenshotId ? { ...r, imageForModel: r.screenshotId, imageCaption: `Screenshot of ${r.target ?? "the page"} on ${r.device ?? "desktop"} (${r.url ?? ""})` } : r;
      }),
    }),
  } : {};

  const design = extras.browser?.design ? {
    analyze_design: tool({
      description: "Measure the site's design language on the live page: fonts + sizes per heading level, colour palette, button style, container width, section spacing, CSS variables, breakpoints and the builder (Elementor / blocks / classic). Call it before designing anything new so it matches the site.",
      inputSchema: z.object({ url: z.string().optional(), device: deviceSchema }),
      execute: async (a) => safe(() => extras.browser!.design!(a) as Promise<any>),
    }),
  } : {};

  const overlay = {
    style_patch: tool({
      description:
        "Change how an element looks with the Livecrafts STYLE OVERLAY: CSS stored by the plugin and printed on the page - no theme file or builder data is touched, " +
        "it beats Elementor's own styles, survives theme updates and reverts exactly. Per screen size: device all | tablet (≤1024px) | mobile (≤767px). " +
        "scope page = only this page, site = every page. Use one specific selector (from inspect_element). Empty value removes a property. Needs approval.",
      inputSchema: z.object({
        selector: z.string().min(1).max(300), styles: z.record(z.string(), z.string()).describe('e.g. {"color":"#1d4ed8","font-size":"44px"}'),
        device: z.enum(["all", "tablet", "mobile"]).default("all"), scope: z.enum(["page", "site"]).default("page"),
        pageUrl: z.string().describe("The page the element is on (needed for scope page)"), reason: reasonSchema,
      }),
      execute: async ({ selector, styles, device, scope, pageUrl }) => safe(async () => {
        bridge.assertSameOrigin(pageUrl);
        return await applyStylePatch(bridge, { selector, styles, device: device ?? "all", scope: scope ?? "page", pageUrl });
      }),
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
      description: "Read a theme file exactly (path relative to the WordPress folder, e.g. wp-content/themes/my-theme/footer.php). Long files can be read in parts with fromLine/maxLines.",
      inputSchema: z.object({ path: z.string(), fromLine: z.number().int().min(1).optional(), maxLines: z.number().int().min(1).max(3000).optional() }),
      execute: async ({ path, fromLine, maxLines }) => safe(() => sf.read(path, fromLine, maxLines)),
    }),
    edit_file: tool({
      description:
        "Edit a theme file (css/js/json/txt/svg, and php/html templates with the Livecrafts plugin 0.7+) by replacing ONE exact, unique snippet. " +
        "Copy `find` exactly from read_file. CSS: change the rule that sets the property instead of adding overrides; no !important unless required. " +
        "PHP: keep the theme's structure, escape output (esc_html, esc_url, esc_attr), never remove wp_head()/wp_footer()/wp_body_open(). " +
        "Needs approval. A backup is kept, PHP is syntax-checked before saving, and if the page breaks the original is restored automatically.",
      inputSchema: z.object({
        path: z.string(), find: z.string().min(1).max(30_000), replace: z.string().max(60_000), reason: reasonSchema,
        checkUrl: z.string().optional().describe("Also check this page loads after the edit (e.g. the page that uses this template)"),
      }),
      execute: async ({ path, find, replace, checkUrl }) => safe(() => sf.edit(path, find, replace, healthUrls(checkUrl))),
    }),
    create_file: tool({
      description:
        "Create a NEW theme file, e.g. a template part for a new section (wp-content/themes/<theme>/template-parts/blog-section.php) - then include it with edit_file " +
        "(get_template_part). Needs the Livecrafts plugin 0.7+ and approval. PHP is syntax-checked; reverting deletes the file.",
      inputSchema: z.object({ path: z.string(), content: z.string().min(1).max(100_000), reason: reasonSchema }),
      execute: async ({ path, content: body }) => safe(() => sf.create(path, body, healthUrls())),
    }),
    restore_file: tool({
      description: "Put a file back exactly as it was before an edit_file/create_file change, using its backupId. Prefer revert_change. Needs approval.",
      inputSchema: z.object({ backupId: z.string(), reason: reasonSchema }),
      execute: async ({ backupId }) => safe(() => sf.restore(backupId, healthUrls())),
    }),
  } : {};

  const hg = extras.hostinger;
  const apiTools = hg ? {
    hostinger_read: tool({
      description:
        "Ask the Hostinger API a READ-ONLY question (e.g. wordpress_plugins_list-installed, wordpress_themes_list-installed, hosting_websites_list). " +
        "Operations that change anything are refused here. Use hostinger_search first if you do not know the operation name.",
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
  const skillTools = sk && sk.list().length ? {
    load_skill: tool({
      description: "Load an official WordPress skill (expert instructions) before work in its area. Default file is SKILL.md; its references/*.md files can be loaded too.",
      inputSchema: z.object({ name: z.string(), file: z.string().optional().describe("e.g. references/theme-json.md") }),
      execute: async ({ name, file }) => safe(async () => sk.load(name, file)),
    }),
  } : {};

  const ch = extras.changes;
  const changeTools = ch ? {
    list_changes: tool({
      description: "Every change made in THIS chat (newest last): id, what, when, and whether it was already reverted. Use before revert_change.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => ({ ok: true, changes: ch.list().map((c) => ({ id: c.id, what: c.title, tool: c.tool, at: c.at, reverted: !!c.revertedAt, canRevert: !!c.revert && !c.revertedAt, note: c.note })) })),
    }),
    revert_change: tool({
      description: "Undo ONE change of this chat by its id (from list_changes): writes the old value back, restores the file backup, moves a created page to the Trash, or removes a created menu/link. Needs approval.",
      inputSchema: z.object({ changeId: z.string(), reason: reasonSchema }),
      execute: async ({ changeId }) => safe(() => ch.revert(changeId)),
    }),
  } : {};

  const planTools = extras.planTool ? {
    propose_plan: tool({
      description:
        "Show the person your plan for THIS request before the first change: one-line summary + the concrete steps (what page/file/menu, what changes). " +
        "They approve it once; after that the steps run without more questions.",
      inputSchema: z.object({ summary: z.string().min(3).max(300), steps: z.array(z.string().min(3).max(300)).min(1).max(15) }),
      execute: async ({ steps }) => ({ ok: true, approved: true, steps: steps.length, note: "Plan approved. Carry out every step now, verify each one, then report." }),
    }),
  } : {};

  return { ...content, ...pages, ...media, ...browser, ...design, ...overlay, ...fileTools, ...apiTools, ...skillTools, ...changeTools, ...planTools };
}

/** Tools that must never run without a human saying yes. */
export const APPROVAL_REQUIRED = [
  "set_content", "upload_media_from_chat", "upload_media_from_url", "undo_last_change", "edit_file", "create_file", "restore_file",
  "create_page", "create_post", "edit_post_content", "set_post_status", "create_menu", "add_menu_item", "revert_change", "style_patch",
] as const;

export type PostTypeName = PostType;
