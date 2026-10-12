import { tool } from "ai";
import { z } from "zod";
import type { Bridge } from "./bridge.js";
import { BridgeError } from "./bridge.js";
import { COMPONENTS, ContentError, LintError, getComponent, imageIds, renderComponent, searchLibrary, type Builder } from "./library/index.js";
import { acfExport } from "./library/acf.js";
import { TEMPLATE_WRAP_CSS, TemplateError, buildShortcode, cleanFit, fitFromDesign, placeShortcode, type Fit, type TemplateEntry } from "./library/templates.js";

/**
 * Tools for finding and placing ready-made components, so the assistant builds like a developer who reuses what exists:
 *   1. the site's own sections / templates / patterns / ACF layouts / widgets  (site_profile, find_components)
 *   2. the Livecrafts library (testimonials, contact ...), built natively for the page's builder
 * and never pastes a hand-written block of HTML into one widget.
 */
export interface ComponentHelpers {
  bridge: Bridge;
  safe: <T>(fn: () => Promise<T>) => Promise<any>;
  postIdOf: (url?: string, post?: number) => Promise<number>;
  /** Run a write; the page is checked in a real browser afterwards (opts.component = selector to measure). */
  checked: (pageUrl: string | undefined, write: () => Promise<any>, opts?: { component?: string; softH1?: boolean }) => Promise<any>;
  changeView: (c: any) => any;
  parseValue: (v: string) => unknown;
  ref: () => string;
  pageUrl: () => string | undefined;
  skillsLoaded: Set<string>;
  /** Measure the site's design on a page (analyze_design), when a browser is available. */
  design?: (url?: string) => Promise<any>;
}

const NEEDED_SKILLS = ["section-design", "mobile-first", "templates", "page-builders"];
const missingSkills = (loaded: Set<string>) => NEEDED_SKILLS.filter((s) => !loaded.has(s));

/** Words to look for on the site for a request: its own words plus what the library knows about the component. */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const extra = searchLibrary(query).flatMap((m) => [m.component.id, ...m.component.keywords.filter((k) => !k.includes(" "))]);
  return [...new Set([...words, ...extra.map((w) => w.toLowerCase()), ...extra.map((w) => w.toLowerCase().replace(/s$/, ""))])].slice(0, 30);
}
const STOP = new Set(["the", "and", "for", "add", "new", "section", "page", "with", "that", "this", "please", "make", "create", "build", "show", "our", "your", "from", "into", "have", "need", "want", "like", "block"]);

/** Which builder a page is made with. */
async function pageBuilder(bridge: Bridge, postId: number, url: string): Promise<{ builder: Builder; acfDriven: boolean; why: string }> {
  const map: any = await bridge.map({ post: postId, view: "draft" }).catch(() => null);
  if (map?.builders?.elementor) return { builder: "elementor", acfDriven: false, why: "the page is built with Elementor" };
  const acf = Number(map?.builders?.acf_fields ?? 0) > 0;
  const post: any = await bridge.post(postId, "draft").catch(() => null);
  const raw = String(post?.content ?? "");
  if (/<!-- wp:/.test(raw)) return { builder: "blocks", acfDriven: acf, why: "the page content is block markup" };
  const ping: any = await bridge.ping().catch(() => null);
  if (ping?.capabilities?.block_theme) return { builder: "blocks", acfDriven: acf, why: "a block theme" };
  void url;
  return { builder: "html", acfDriven: acf, why: "classic content: the component goes in as a Custom HTML block" };
}

/** Text replacements applied to every string of an Elementor node / to block markup. */
function applyReplacements<T>(value: T, reps: Array<{ find: string; replace: string }>): T {
  const sub = (s: string) => reps.reduce((t, r) => t.split(r.find).join(r.replace), s);
  const walk = (v: any): any => (typeof v === "string" ? sub(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

/** The site's templates, or why there are none. */
async function loadTemplates(bridge: Bridge): Promise<{ list: TemplateEntry[]; version?: string; note?: string; contactAction?: string }> {
  try {
    const r = await bridge.templates();
    if (!r?.active) return { list: [], note: "The template library is not active on this site." };
    return { list: (r.components ?? []) as TemplateEntry[], version: r.version, contactAction: r.contactAction };
  } catch (e) {
    if (e instanceof BridgeError && e.status === 404) return { list: [], note: "The site's Livecrafts plugin is older than 0.14: it has no template library. Update the plugin." };
    throw e;
  }
}

/** Library components that a template of the template library replaces (the template is preferred: measured fit, one shortcode, same on every builder). */
const LIBRARY_COVERED_BY: Record<string, string> = { testimonials: "testimonials", contact: "contact_form" };

/** Words that point at a template: its id, title and shortcode words. */
function templateScore(t: TemplateEntry, query: string): number {
  const q = " " + query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const id = t.id.replace(/_/g, " ");
  let s = 0;
  if (q.includes(" " + id + " ")) s += 10;
  for (const w of new Set((id + " " + t.title.toLowerCase()).split(/[^a-z0-9]+/).filter((x) => x.length > 2))) if (q.includes(" " + w + " ") || q.includes(" " + w + "s ")) s += 3;
  for (const [syn, ids] of Object.entries(TEMPLATE_WORDS)) if (q.includes(" " + syn + " ") && ids.includes(t.id)) s += 6;
  return s;
}
const TEMPLATE_WORDS: Record<string, string[]> = {
  banner: ["hero", "hero_centered", "announcement"], intro: ["hero", "hero_centered"], "call to action": ["cta"], questions: ["faq"], accordion: ["faq"],
  features: ["feature_grid"], services: ["feature_grid"], benefits: ["feature_grid"], plans: ["pricing"], price: ["pricing"], reviews: ["testimonials"], testimonial: ["testimonials"],
  customers: ["logo_cloud", "testimonials"], partners: ["logo_cloud"], clients: ["logo_cloud"], numbers: ["stats"], counters: ["stats"], process: ["steps"], timeline: ["steps"],
  people: ["team"], staff: ["team"], blog: ["blog_grid", "card"], posts: ["blog_grid"], subscribe: ["newsletter"], email: ["newsletter", "contact_form"], contact: ["contact_form"],
  menu: ["header"], nav: ["header", "breadcrumbs"], navbar: ["header"], navigation: ["header"], notice: ["alert", "announcement"], warning: ["alert"],
};

export function makeComponentTools(h: ComponentHelpers) {
  const { bridge, safe } = h;
  return {
    site_profile: tool({
      description:
        "What this site is built with, in one call: theme (block theme?), Elementor (version, flexbox containers, free/Pro widgets, global colours and fonts), ACF (flexible-content layouts = the theme's modules), block patterns, and the forms of Contact Form 7 / WPForms with their shortcodes. " +
        "Call it before designing a new section: it tells you the builder to use, the brand colours to reuse and which form a contact section can show.",
      inputSchema: z.object({}),
      execute: async () => safe(async () => {
        try {
          const p = await bridge.siteProfile();
          const el = p.builders?.elementor ?? {};
          return {
            ok: true, theme: p.theme, wp: p.wp,
            elementor: el.active ? { version: el.version, pro: el.pro, flexboxContainers: el.containers, widgetCount: el.widgets?.length, freeWidgetsUsedByLibrary: ["heading", "text-editor", "image", "button", "shortcode"].filter((w) => el.widgets?.includes(w)), testimonialWidget: el.widgets?.includes("testimonial") ?? false, globalColors: el.colors, globalFonts: el.fonts } : { active: false },
            acf: p.builders?.acf?.active ? { pro: p.builders.acf.pro, flexibleLayouts: (p.builders.acf.flexible ?? []).map((l: any) => ({ field: l.field, layout: l.layout, label: l.label, subFields: l.sub_fields?.map((s: any) => s.name) })) } : { active: false },
            blocks: p.builders?.blocks, forms: p.forms ?? [],
            howToUse: "Brand colour: use a global colour or the button colour from analyze_design as `brand` in place_component. Contact form: pass one of `forms[].shortcode` as formShortcode (never invent one).",
          };
        } catch (e) {
          if (!(e instanceof BridgeError) || e.status !== 404) throw e;
          const ping: any = await bridge.ping();
          return { ok: true, limited: true, note: "The Livecrafts plugin on this site is older than 0.12: only the basics are known. Update the plugin for the full site profile.", theme: ping.capabilities?.theme, blockTheme: ping.capabilities?.block_theme, elementor: { active: !!ping.capabilities?.elementor }, acf: { active: !!ping.capabilities?.acf } };
        }
      }),
    }),

    find_components: tool({
      description:
        "ALWAYS call this before building a section (testimonials, contact, ...): look for something that already exists to reuse, like a developer searching the codebase before writing new code. " +
        "Searches (1) the site: Elementor templates and sections on other pages, Elementor widgets (free and installed add-ons), block patterns, synced patterns, ACF flexible-content layouts; and (2) the Livecrafts library (ready, responsive, checked components). " +
        "Results are ranked: reuse what the site has first, then the library built natively for this page's builder. Returns how to use each (place_component).",
      inputSchema: z.object({ query: z.string().min(2).max(200).describe("What is wanted, e.g. 'testimonials' or 'contact form with address'"), url: z.string().optional().describe("The page it is for (default: the page the person is on)") }),
      execute: async ({ query, url }) => safe(async () => {
        const pageUrl = url || h.pageUrl() || bridge.homeUrl;
        const postId = await h.postIdOf(pageUrl);
        const page = await pageBuilder(bridge, postId, pageUrl);
        let site: any[] = [], siteNote: string | undefined;
        try { site = (await bridge.components(searchTerms(query))).items ?? []; }
        catch (e) { siteNote = e instanceof BridgeError && e.status === 404 ? "The site's plugin is older than 0.12, so the site itself could not be searched." : `The site could not be searched: ${(e as Error).message}`; }
        const lib = searchLibrary(query);
        const tpl = await loadTemplates(bridge).catch(() => ({ list: [] as TemplateEntry[], note: undefined as string | undefined }));
        const sameBuilder = (b: string) => b === page.builder || (b === "acf" && page.acfDriven);
        const results: any[] = [];
        for (const s of site.filter((x) => sameBuilder(x.builder) && x.kind !== "elementor-widget")) results.push({ source: "site", id: s.id, kind: s.kind, builder: s.builder, name: s.name, where: s.where, matched: s.matched, use: `place_component source "site" id "${s.id}"` });
        for (const t of tpl.list.map((x) => ({ t: x, s: templateScore(x, query) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4)) {
          results.push({ source: "template", id: t.t.id, kind: "template", builder: "any (a shortcode: works in Elementor, blocks, Divi, WPBakery, ACF)", name: t.t.title || t.t.id, where: "Livecrafts template library", about: t.t.params, use: `place_component source "template" id "${t.t.id}" attrs {...} items [...] (get_component shows the fields)` });
        }
        for (const m of lib.filter((x) => !tpl.list.some((t) => t.id === LIBRARY_COVERED_BY[x.component.id]))) results.push({ source: "library", id: m.component.id, kind: "library", builder: page.builder, name: m.component.name, where: "Livecrafts library", about: m.component.description, use: `place_component source "library" id "${m.component.id}" content {...} (get_component shows the fields)` });
        for (const s of site.filter((x) => x.kind === "elementor-widget")) results.push({ source: "site", id: s.id, kind: s.kind, builder: s.builder, name: s.name, where: s.where, matched: s.matched, use: "a single widget: place_component source \"site\" id, then fill it with make_change el.setting", note: "Only a widget, not a finished section." });
        for (const s of site.filter((x) => !sameBuilder(x.builder) && x.kind !== "elementor-widget")) results.push({ source: "site", id: s.id, kind: s.kind, builder: s.builder, name: s.name, where: s.where, matched: s.matched, note: `Built with ${s.builder}; this page uses ${page.builder}. Look at it for reference (read_page / screenshot), do not copy it.` });
        const skills = missingSkills(h.skillsLoaded);
        return {
          ok: true, pageBuilder: page.builder, because: page.why,
          acfWarning: page.acfDriven && page.builder !== "elementor" ? "This page also has ACF fields: if its template prints them, new content in the page body may not show. Prefer an ACF layout from the results, or get_component with builder \"acf\" for the developer hand-off." : undefined,
          results: results.slice(0, 12), siteNote, templatesNote: tpl.note,
          templateRule: results.some((r) => r.source === "template") ? "A template matches: prefer it over everything except a section the site already has that fits. Templates are ready, responsive and follow the site's theme; place_component adapts them to the page (fit: auto)." : undefined,
          nothingFound: results.length === 0 ? "Nothing on the site or in the library matches. Say so, then either build it from native widgets / blocks following the section-design skill, or suggest a plugin or Elementor template to the person (they decide; you cannot install plugins)." : undefined,
          beforeYouBuild: skills.length ? `Load these skills first: ${skills.map((s) => `load_skill("${s}")`).join(", ")}.` : undefined,
        };
      }),
    }),

    get_component: tool({
      description:
        "Details of one component before placing it. Library: the fields it takes (with limits), the sample content, and with builder \"acf\" the developer hand-off (ACF field group + layout, PHP partial, CSS) for themes driven by ACF flexible content. " +
        "Site component: its source as it would be inserted (Elementor JSON / block markup / ACF layout) and what had to be dropped.",
      inputSchema: z.object({ source: z.enum(["template", "library", "site"]), id: z.string(), builder: z.enum(["elementor", "blocks", "html", "acf"]).optional().describe("Library only: preview the markup for this builder (acf = hand-off files)") }),
      execute: async ({ source, id, builder }) => safe(async () => {
        if (source === "template") {
          const t = await loadTemplates(bridge);
          const e = t.list.find((x) => x.id === id);
          if (!e) return { ok: false, error: t.note ?? `Unknown template "${id}". Available: ${t.list.map((x) => x.id).join(", ")}.` };
          return {
            ok: true, source: "template", id: e.id, name: e.title || e.id, attributes: e.attributes, defaults: e.defaults, takesListRows: e.list, rowFields: e.item_fields || undefined,
            docs: e.params, exampleShortcode: e.example, fit: "brand, surface, surface_alt, ink, muted, line (colours); max, py, py_sm, radius (lengths); font. place_component fit \"auto\" measures them from the site.",
            usedOn: (e.usedOn ?? []).map((u) => ({ page: u.title, url: u.url, status: u.status, times: u.count })),
            rules: "Texts are plain (no HTML). Never invent customer quotes, prices, names or contact details: use what the person gave or what the page already says. Images are full URLs (Media Library) or ids as the template documents. Links are real addresses on the site.",
          };
        }
        if (source === "site") { const r = await bridge.componentSource(id); const json = JSON.stringify(r.node ?? r.markup ?? r.layout ?? null); return { ...r, node: undefined, markup: undefined, source: json.length > 20_000 ? json.slice(0, 20_000) + "…" : json, bytes: json.length }; }
        const c = getComponent(id);
        if (!c) return { ok: false, error: `Unknown library component "${id}". Available: ${COMPONENTS.map((x) => x.id).join(", ")}.` };
        if (builder === "acf") return { ok: true, ...acfExport(c), note: "Hand this to a developer or add it with create_file when theme file writes are allowed. Nothing is applied to the site by this call." };
        const base = { ok: true, id: c.id, name: c.name, description: c.description, fields: c.slots, sample: c.sample(), rules: "Never invent customer quotes or contact details: use what the person gave, or leave the sample (it is flagged as a placeholder and must be replaced before deploy). Images are Media Library ids (upload first)." };
        if (!builder) return base;
        const r = renderComponent(id, { builder });
        return { ...base, preview: { kind: r.kind, value: r.value.length > 6000 ? r.value.slice(0, 6000) + "…" : r.value, warnings: r.warnings } };
      }),
    }),

    template_usage: tool({
      description:
        "Which parts of the site come from the template library, like `git grep` for templates: every template with the pages/posts it is used on (live or draft) and the URLs where theme code rendered it. " +
        "Use it to answer \"is this page using the templates?\" and before adding a template that may already exist. With url: only that page, plus a link that outlines its template sections for editors (?lc_templates=1). Read-only.",
      inputSchema: z.object({ url: z.string().optional().describe("Limit to one page") }),
      execute: async ({ url }) => safe(async () => {
        const t = await loadTemplates(bridge);
        if (!t.list.length) return { ok: true, active: false, note: t.note };
        const postId = url ? await h.postIdOf(url).catch(() => 0) : 0;
        const rows = t.list.map((e) => ({
          template: e.id,
          usedOn: (e.usedOn ?? []).filter((u) => !postId || u.post === postId).map((u) => ({ page: u.title, url: u.url, status: u.status, times: u.count, in: u.in })),
          renderedByThemeCode: postId ? undefined : (e.renderedAt ?? []).map((r) => r.path),
        }));
        const used = rows.filter((r) => r.usedOn.length || r.renderedByThemeCode?.length);
        return {
          ok: true, active: true, version: t.version, scope: url ?? "whole site", used, unusedTemplates: rows.length - used.length,
          seeIt: url ? `${url}${url.includes("?") ? "&" : "?"}lc_templates=1` : "Add ?lc_templates=1 to any page URL (as a logged-in editor) to see its template sections outlined and labelled.",
          note: used.length ? undefined : "No template is used here: this part of the site was built without the template library.",
        };
      }),
    }),

    place_component: tool({
      description:
        "Add a component to a page as DRAFT changes, built the right way for the page: Elementor containers and free widgets, core blocks, or a Custom HTML block for classic content. Needs approval.\n" +
        "source \"template\" (preferred when find_components lists one): id = a template of the site's template library (hero, pricing, faq, header, footer ...); attrs + items = ONLY the content; fit \"auto\" (default) first measures the page's own sections (content width, vertical padding, corner radius, button colour, background) and applies them, so the template matches the site. It is placed as one shortcode, so it works in Elementor, blocks, Divi, WPBakery and ACF pages, and the result's usedTemplate proves it is on the page (open seeIt to see it outlined).\n" +
        "source \"library\": id = testimonials | contact; content = the fields (see get_component). It also writes the library's protective CSS (Additional CSS blocks lc-core, lc-c-<id>, lc-tokens) so the section cannot overflow, overlap or be broken by the theme, then inserts it, then the page is measured in a real browser on desktop, tablet and mobile.\n" +
        "source \"site\": id from find_components: copies that section / pattern. replacements = text swaps [{find, replace}] to adapt it.\n" +
        "position: Elementor \"<parent id|root>:<index|end>\" (default root:end); blocks \"<parent path>:<index|end>\" (default \":end\" = end of the page).\n" +
        "Never invent customer quotes or contact details. If the checks fail, fix or revert (revert_change) before saying it worked.",
      inputSchema: z.object({
        source: z.enum(["template", "library", "site"]),
        id: z.string().min(2).max(200),
        builder: z.enum(["auto", "elementor", "blocks", "html"]).default("auto").describe("Library only. auto = what the page is built with"),
        url: z.string().optional().describe("The page (default: the page the person is on)"),
        position: z.string().max(60).optional(),
        content: z.record(z.string(), z.any()).optional().describe("Library: the component's fields"),
        brand: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional().describe("The site's brand colour for buttons, e.g. #1d4ed8 (from a global colour or analyze_design). Without it the section is neutral and legible on any background."),
        replacements: z.array(z.object({ find: z.string().min(1).max(500), replace: z.string().max(2000) })).max(30).optional().describe("Site components: text swaps"),
        attrs: z.record(z.string(), z.any()).optional().describe("Template: the template's attributes (heading, text, primary_label, primary_url, image ...), plain text"),
        items: z.array(z.record(z.string(), z.any())).max(24).optional().describe("Template: rows of a list template (faq: title+text, pricing: ..., see get_component rowFields)"),
        fit: z.union([z.literal("auto"), z.literal("none"), z.record(z.string(), z.any())]).default("auto").describe("Template: how it adapts to the site. auto = measure the page's own sections (content width, padding, radius, button colour, background) and apply them; none = neutral defaults; or an object {max, py, py_sm, radius, brand, surface, ink ...}. Explicit values win over auto."),
        reason: z.string().max(300).describe("One short sentence for the person approving"),
      }),
      execute: async (a) => safe(async () => {
        const pageUrl = a.url || h.pageUrl() || bridge.homeUrl;
        const postId = await h.postIdOf(pageUrl);
        const detected = await pageBuilder(bridge, postId, pageUrl);
        const extra: any[] = [];
        const write = async (kind: string, target: string, value: unknown, label?: string, post?: number) => {
          const r: any = await bridge.makeChange({ kind, post, target, value, label, ref: h.ref() });
          return r;
        };

        let kind: "el.insert" | "block.insert", value: unknown, builder: Builder, warnings: string[] = [], placeholders = false, selector: string | undefined, css: Array<{ id: string; label: string; css: string }> = [], dropped: string[] = [];
        let templateUsed: Record<string, unknown> | undefined, softH1 = false;

        if (a.source === "template") {
          const t = await loadTemplates(bridge);
          const entry = t.list.find((x) => x.id === a.id);
          if (!entry) return { ok: false, error: t.note ?? `Unknown template "${a.id}". Available: ${t.list.map((x) => x.id).join(", ")}.` };
          builder = a.builder === "auto" ? detected.builder : a.builder;
          // A template is its own section on the page: never inside another section's container (it would sit in the middle of it).
          const pos = a.position ?? "";
          if (builder === "elementor" && pos && !/^root:(\d+|end)$/.test(pos)) return { ok: false, error: `A template is a section of its own: position must be "root:<index>" (or "root:end"), not "${pos}", which is inside another section. get_page_map shows the order of the page's sections; testimonials usually go after the products / services section, a contact form last, above the footer.` };
          // Real content only: sample text must never reach the page.
          const SAMPLE = /\b(placeholder|lorem ipsum|client name|your name here|sample (text|quote)|replace this)\b/i;
          const texts = [...Object.values(a.attrs ?? {}), ...(a.items ?? []).flatMap((i) => Object.values(i))].map((v) => String(v));
          if (texts.some((x) => SAMPLE.test(x))) return { ok: false, error: "The content contains sample text (placeholder / client name / replace this ...). Ask the person for the real content (or use what the page already says) and place the template with that. Never publish sample quotes, names or numbers." };
          if (entry.id === "contact_form") {
            const action = String((a.attrs ?? {}).action ?? "").trim();
            if (!action) {
              if (!t.contactAction) return { ok: false, error: "The contact form needs an action (a form handler). Update the Livecrafts plugin to 0.14.2 (it includes one), or pass attrs.action with the address of the person's own form endpoint." };
              a.attrs = { ...(a.attrs ?? {}), action: t.contactAction };
              warnings.push("The form posts to the plugin's built-in handler: messages are e-mailed to the address in Settings > General (option livecrafts_contact_to overrides it).");
            }
          }
          // 1) fit: what the site's own sections look like (width, padding, radius, button colour, background)
          let fit: Fit = {}, basis: string[] = [];
          if (a.fit === "auto") {
            let design: any = null;
            if (h.design) design = await h.design(pageUrl).catch(() => null);
            ({ fit, basis } = fitFromDesign(design));
            if (!h.design) basis = ["no browser is available to measure the site: templates use their neutral defaults"];
          } else if (a.fit === "none") basis = ["fit switched off: neutral defaults"];
          const explicit = cleanFit(a.fit !== "auto" && a.fit !== "none" ? a.fit : undefined);
          const brandGiven = cleanFit(a.brand ? { brand: a.brand } : undefined);
          fit = { ...fit, ...explicit.fit, ...brandGiven.fit };
          if (explicit.dropped.length) warnings.push(`Fit values ignored: ${explicit.dropped.join("; ")}.`);
          // 2) the one shortcode
          let built;
          try { built = buildShortcode(entry, { attrs: a.attrs, items: a.items, fit }); }
          catch (e) { if (e instanceof TemplateError) return { ok: false, error: e.message }; throw e; }
          warnings.push(...built.warnings);
          const placed = placeShortcode(built.code, builder, entry.id);
          kind = placed.kind; value = placed.value;
          if (builder === "elementor") css = [TEMPLATE_WRAP_CSS];
          selector = `.ai-t[data-lc-template="${entry.id}"]`;
          softH1 = /^hero/.test(entry.id);
          const empty = Object.keys(a.attrs ?? {}).length === 0 && !(a.items ?? []).length;
          if (empty) { placeholders = true; warnings.push("No content was given: the template shows empty areas. Give it real content."); }
          templateUsed = { id: entry.id, shortcode: built.code, fit, fitBasis: basis, seeIt: `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}lc_templates=1` };
        } else if (a.source === "library") {
          builder = a.builder === "auto" ? detected.builder : a.builder;
          if (a.builder === "auto" && detected.acfDriven && builder !== "elementor") return { ok: false, error: "This page prints ACF fields from its template, so a section inserted into the page body may not appear. Use an ACF layout (find_components) or the hand-off: get_component builder \"acf\". Pass builder \"blocks\" or \"html\" only if the person confirms the page body is shown." };
          const covering = LIBRARY_COVERED_BY[a.id];
          if (covering) {
            const tl = await loadTemplates(bridge).catch(() => ({ list: [] as TemplateEntry[] }));
            if (tl.list.some((t) => t.id === covering)) return { ok: false, error: `The template library has "${covering}", which replaces the library component "${a.id}". Use place_component source "template" id "${covering}" (get_component source "template" shows its fields). Do not build this section any other way.` };
          }
          const comp = getComponent(a.id);
          if (!comp) return { ok: false, error: `Unknown library component "${a.id}". Available: ${COMPONENTS.map((x) => x.id).join(", ")}.` };
          const media: Record<string, { url: string; alt: string }> = {};
          try {
            for (const id of imageIds(comp, { ...comp.sample(), ...(a.content ?? {}) })) { const m = await bridge.mediaInfo(id); media[String(id)] = { url: m.source_url, alt: m.alt_text ?? "" }; }
          } catch (e) { return { ok: false, error: "An image id was not found in the Media Library: " + (e as Error).message }; }
          let r;
          try { r = renderComponent(a.id, { builder, content: a.content, brand: a.brand, ctx: { media } }); }
          catch (e) { if (e instanceof ContentError || e instanceof LintError) return { ok: false, error: e.message }; throw e; }
          kind = r.kind; value = h.parseValue(r.value); warnings = r.warnings; placeholders = r.placeholders; css = r.css;
          selector = `.lc-c.lc-${comp.id}`;
        } else {
          const src: any = await bridge.componentSource(a.id);
          if (src.builder === "acf") return { ok: false, error: "That is an ACF layout: add a row with make_change kind acf.rows, then fill its fields (see get_component).", layout: src.layout };
          builder = src.builder;
          if (a.builder !== "auto" && a.builder !== builder) return { ok: false, error: `That component is built with ${builder}.` };
          if (builder !== detected.builder && !(builder === "blocks" && detected.builder === "html")) return { ok: false, error: `That component is ${builder}-based but this page is ${detected.builder}-based (${detected.why}). Build the library version instead.` };
          kind = src.kind;
          value = builder === "elementor" ? applyReplacements(src.node, a.replacements ?? []) : applyReplacements(String(src.markup), a.replacements ?? []);
          dropped = src.dropped ?? [];
          if (dropped.length) warnings.push(`Not copied (Livecrafts cannot validate them): ${dropped.slice(0, 6).join("; ")}${dropped.length > 6 ? "…" : ""}. Check the look in the preview.`);
        }

        // 1) the protective CSS, once per site (a block with the same name is replaced, so this is safe to repeat)
        for (const b of css) {
          const r: any = await write("css.block", b.id, b.css, b.label);
          if (r?.ok === false) return { ok: false, error: `Could not save the component CSS "${b.id}": ${r.error ?? r.message}`, hint: "Nothing was inserted." };
          if (r?.change) extra.push(r.change);
        }
        // 2) the section itself, then the real-browser check
        const target = a.position || (kind === "el.insert" ? "root:end" : ":end");
        const out = await h.checked(pageUrl, () => write(kind, target, value, templateUsed ? `Template: ${a.id}` : undefined, postId), { component: selector, softH1 });
        if (out?.ok === false) return { ...out, note: extra.length ? "The CSS blocks are saved as drafts (harmless); nothing was inserted." : undefined };
        const skills = missingSkills(h.skillsLoaded);
        return {
          ...out, change: h.changeView(out.change), changeId: out.change?.id, extraChanges: extra, component: a.id, builder, placeholders, warnings,
          usedTemplate: templateUsed ? { ...templateUsed, proof: out.verification?.checks?.some((c: any) => /component/.test(c.name) && c.ok === false && /not on the draft page/.test(c.detail ?? "")) ? "NOT FOUND on the draft page: the template did not render. Fix or revert." : `The marker <div class="ai-t" data-lc-template="${a.id}"> is on the page; open seeIt to see it outlined.` } : undefined,
          nextSteps: [
            ...(placeholders ? ["Sample text is in the section: ask the person for the real content and replace it (make_change el.setting / block.text). Never invent testimonials or contact details."] : []),
            "Check `verification`: all component checks must pass on desktop, tablet and mobile; otherwise fix or revert. Take one screenshot_page of the section (mobile) to see it.",
            ...(skills.length ? [`You did not load ${skills.join(" and ")}: load them and compare the result with their checklists.`] : []),
          ],
        };
      }),
    }),
  };
}
