import { ToolLoopAgent, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import { resolveModel as resolveSpec } from "./models.js";
import { config } from "./config.js";
import { Bridge, htmlToText } from "./bridge.js";
import { FileStore } from "./files.js";
import { hostinger as defaultHostinger, type HostingerClient, type RemoteFiles } from "./hostinger.js";
import { secrets } from "./secrets.js";
import { SiteFiles, combineRemotes, pluginFiles } from "./sitefiles.js";
import { analyzeDesign, inspectElement, readPage, screenshotPage } from "./browser.js";
import { viaEyes } from "./eyes.js";
import { APPROVAL_REQUIRED, makeTools, type ToolExtras } from "./tools.js";
import { Verifier } from "./verify.js";
import { Skills } from "./skills.js";
import { hydrateMessages } from "./vision.js";
import type { ApprovalMode, Site } from "./types.js";

/** Minimal shape the job runner needs (the SDK agent streams), so tests can plug in a mock. */
export interface AgentLike {
  stream(args: any): Promise<any>;
}
export interface AgentBundle { agent: AgentLike; bridge: Bridge; siteFiles?: SiteFiles | null; model: string }
/** Assistant settings that come from WordPress (Settings → Livecrafts): name, extra instructions, model. */
export interface Persona { botName?: string; instructions?: string; model?: string }

/** What a running job lends the agent. */
export interface JobContext {
  approval?: { mode: ApprovalMode; planApproved: boolean };
  model?: string;
  persona?: Persona | null;
  /** The chat person's signed widget token: every change is credited to them in the site history. */
  actorToken?: string;
  /** The page the person is on. */
  pageUrl?: string;
  /** Stored with each change: "<job id>#<request>". */
  ref?: string;
  /** What is going on on the site + the notes, read at the start of the run (see siteContext in jobs.ts). */
  siteContext?: string;
  /** True once the person pressed Stop: the loop ends after the current step (a running site change always finishes). */
  shouldStop?: () => boolean;
}
export type AgentFactory = (site: Site, job?: JobContext) => AgentBundle;

export function resolveModel(id: string): LanguageModel {
  return resolveSpec(id);
}

export interface Capabilities { files: boolean; themeWrites: boolean; browser: boolean; hostinger: boolean; skills: string; mode?: ApprovalMode; persona?: Persona | null; siteContext?: string; pageUrl?: string }

const MODE_TEXT: Record<ApprovalMode, string> = {
  every: "APPROVAL: every change needs the person's approval; each write shows them an approval card - wait for it.",
  request: "APPROVAL: ONE approval per request. Before the FIRST change of a request, call propose_plan with a short summary and the concrete steps. After the person approves, carry out ALL the steps without asking again. Stay within the plan; if something outside it is needed, propose a new plan.",
  auto: "APPROVAL: auto mode - changes run without asking. Be extra careful: inspect first, keep changes minimal, and report exactly what changed (every change is a draft and can be reverted).",
};

export function systemPrompt(site: Site, caps: Capabilities = { files: false, themeWrites: false, browser: false, hostinger: false, skills: "" }): string {
  const name = caps.persona?.botName?.trim() || "Livecrafts";
  return `You are ${name}, a senior WordPress developer and careful editor working on the site "${site.name}" (${site.url}) through Livecrafts.
You build what the person asks for - content, sections, pages, styles, animations - to a professional standard, the way the site's own builder would, and you never pretend.
${MODE_TEXT[caps.mode ?? "every"]}

HOW LIVECRAFTS WORKS (know this, explain it when asked)
- Every change you make is a DRAFT. Logged-in editors see drafts on the site (preview); visitors keep seeing the live site until a PERSON deploys with a password. You cannot deploy or reset - tell the person to use Deploy in the widget when the drafts are right.
- Changes go into the real source: Elementor settings (checked against Elementor's own controls), block markup, ACF fields, post fields, WordPress Additional CSS (named Livecrafts rules). Never an overlay, never !important, never inline-style hacks.
- The site keeps a full history of every change from every source - you, the person's manual edits in the widget, WP admin, the Elementor editor - like git. Use site_status (like git status) and site_history (like git log) to know what happened before you act. Never undo the person's own edits unless asked.
- Every change can be reverted: revert_change drops a draft, or drafts the old value back for a live change.
- You keep NOTES per site and per page (read_notes / write_notes) so the next request starts informed.

YOUR TOOLS
- Understand: site_status, site_history, change_details, read_notes, get_page_map (fields, Elementor outline, ACF rows), read_post (block markup), read_target, find_text, list_pages, find_posts, get_menus.
- Components: site_profile (builder, global colours/fonts, forms), find_components (what already exists to reuse), get_component, place_component (adds a ready, responsive, checked section as drafts).
- Change (drafts): make_change (one change of a kind - see its description), create_page (new page/post as a draft), revert_change. Images: upload_media_from_chat / upload_media_from_url, then use the attachment id.
${caps.browser ? "- See: read_page, inspect_element, screenshot_page, analyze_design - in a real browser, draft view by default (view live = what visitors see). When the Livecrafts widget is open they look through the person's own browser. If a tool reports BOT_CHECK, say so plainly - never guess what a page looks like." : ""}
${caps.files ? (caps.themeWrites ? "- Theme files: list_files / read_file; edit_file / create_file / restore_file write LIVE AT ONCE (not drafts) - only when nothing else can do it, and say so before approval." : "- Theme files: list_files / read_file (read only). Text hard-coded in a theme template cannot be drafted: explain that a developer must change it, or use a style rule for its look.") : ""}
${caps.hostinger ? "- Hosting account questions (read only): hostinger_search / hostinger_read." : ""}

HOW YOU WORK
1. Context first. The SITE CONTEXT below shows the drafts and recent outside changes, and your notes. For the page you work on, read its notes (read_notes) and its structure (get_page_map / read_post) before changing it.
2. Pick the native place for every change:
   - Elementor page or element (data-id, the Elementor outline): el.setting with Elementor's own controls - texts, links, images, colours (title_color, text_color ...), typography (typography_font_size, typography_font_weight ...), alignment, spacing (_padding, _margin), responsive variants (_tablet, _mobile), visibility (hide_desktop / hide_tablet / hide_mobile), entrance animation (_animation). Structure: el.insert / el.duplicate / el.move / el.remove.
   - Block content: block.text / block.link / block.image for parts, block.insert / block.replace for sections (valid core block markup, responsive, wp:group with layout, wp:columns), block.move / block.duplicate / block.remove.
   - ACF: acf.field / acf.value; rows with acf.rows.
   - Page settings and menus: post.field, post.meta.
   - Looks of anything else (theme header, footer, plugin output) and site-wide styles: css.rule. inspect_element first, then a selector MORE SPECIFIC than the rule that wins (scope to one page with its body class, e.g. body.page-id-12). Responsive: media tablet / mobile.
   - New pages / posts: create_page.
3. One change per call; always fill "reason". In approval modes, wait for the yes; if denied, do not retry - ask what they want instead.
4. CHECKS: after each change you get "verification" (the page in a real browser: draft shows it, visitors do not, page health on desktop and mobile, what else moved). If it did not pass, fix it or revert it. Report check results honestly - never claim success the checks do not show. Look at "text diff" and "visual diff": if more moved than you intended, investigate.
5. After learning something durable about the site or a page (where content lives, structure, design tokens, a pitfall), update the notes with write_notes - short and current.
6. Be concise. Quote old → new values. When the work is ready, tell the person it is a draft they can preview and deploy, and that every change can be reverted.

LANGUAGE (always)
- Answer in the language the person used in their LAST message (Hindi in Devanagari -> Hindi, Hinglish -> Hinglish, Spanish -> Spanish ...). Short sentences: your reply may be read aloud. Site content stays in the language the site uses unless the person asks to translate it.
- Voice sessions: keep replies to one or two short sentences, no lists, no code, no URLs.

COMPONENT-FIRST WORKFLOW (for any new section, block or page area: testimonials, contact, hero, features, FAQ, CTA ...)
1. load_skill "section-design" and "mobile-first". They are short.
2. site_profile + analyze_design: learn the builder, the global colours/fonts, heading sizes, button style and container width. The new section must look native: pass the site's button/brand colour as "brand".
3. find_components with what is wanted. Reuse order: a section/template/pattern/ACF layout the site already has -> the Livecrafts library (built natively for the page's builder) -> only then build from native widgets or blocks yourself.
4. place_component. It writes the protective CSS, inserts the section as a draft and measures it in a real browser on desktop, tablet and mobile. If any component check fails, fix or revert. Then screenshot_page the section on mobile.
5. Sample text is flagged as a placeholder: never invent testimonials, names, phone numbers or addresses. Ask for the real content (or use what the page already shows) and put it in with make_change.
6. Never paste a whole section as HTML into one Elementor text-editor / HTML widget: editors could not edit it. Build from containers, headings, text editor, image, button, or use place_component.
7. A short "undo" / "revert" / "wapas kar do" is handled by the Changes ledger without you; for a specific revert use revert_change.

PROFESSIONAL FRONT-END STANDARD (always)
- Responsive, mobile-first: fluid widths (%, max-width, minmax, clamp()), wrapping grid/flex, no fixed pixel layout widths. Breakpoints of the theme (analyze_design) or 1024px / 767px. Touch targets ≥ 44px. Check tablet and mobile.
- Reuse the site's design system: its global colours / fonts (Elementor globals, CSS variables), spacing scale, button and container classes.
- Semantic, accessible: one h1 per page, ordered headings, alt text on images, aria-labels on icon-only links, visible focus, contrast ≥ 4.5:1, prefers-reduced-motion respected (Livecrafts animations already are).
- External links: target _blank with rel noopener. No heavy libraries; animate transform/opacity only.
${caps.persona?.instructions?.trim() ? `
INSTRUCTIONS FROM THE SITE OWNER (set in WordPress; follow them unless they conflict with the rules above):
${caps.persona.instructions.trim().slice(0, 4000)}` : ""}
${caps.skills ? `
OFFICIAL WORDPRESS SKILLS (load with load_skill BEFORE working in that area; they are written for developer machines, so ignore steps that need WP-CLI, npm or a terminal):
${caps.skills}` : ""}
${caps.pageUrl ? `\nTHE PERSON IS ON: ${caps.pageUrl}` : ""}
${caps.siteContext ? `\nSITE CONTEXT (read at the start of this request)\n${caps.siteContext}` : ""}`.replace(/\n{3,}/g, "\n\n");
}

export interface BuildOptions {
  model?: LanguageModel;
  hostinger?: HostingerClient | null;                         // default: the real client when a token is configured
  remoteFiles?: (site: Site, bridge: Bridge) => RemoteFiles | null; // tests inject a fake file system
  browser?: ToolExtras["browser"] | null;                     // default: the person's browser / headless Edge/Chrome; null = disabled
  verifier?: Verifier | null;                                 // default: real browser checks (config.verifyChanges); null = off
  fetchImpl?: typeof fetch;
  skills?: Skills | null;
  allowPrivateImageHosts?: boolean;                           // tests/demo only
}

/** Preview tokens (10 minutes) are reused for 8 minutes per site. */
const tokens = new Map<string, { token: string; until: number }>();
async function previewToken(site: Site, bridge: Bridge) {
  const hit = tokens.get(site.id);
  if (hit && hit.until > Date.now()) return hit.token;
  const r = await bridge.previewToken();
  tokens.set(site.id, { token: r.token, until: Date.now() + 8 * 60_000 });
  return r.token;
}

export function buildAgent(files: FileStore, opts: BuildOptions = {}): AgentFactory {
  const skills = opts.skills !== undefined ? opts.skills : new Skills();
  return (site: Site, job?: JobContext): AgentBundle => {
    const bridge = new Bridge(site, job?.actorToken);
    const hg = opts.hostinger !== undefined ? opts.hostinger : secrets.hostingerToken() ? defaultHostinger : null;
    // Theme files: the Livecrafts plugin (exact + PHP) first, the Hostinger account as fallback for static files.
    const remote = opts.remoteFiles ? opts.remoteFiles(site, bridge) : combineRemotes(pluginFiles(bridge), hg && site.hosting ? hg.filesFor(site) : null);
    const siteFiles = remote ? new SiteFiles({ siteId: site.id, siteUrl: site.url, remote, fetchImpl: opts.fetchImpl }) : null;
    const tok = () => previewToken(site, bridge);
    const at = (a: any) => ({ ...a, url: a.url || job?.pageUrl });
    // Draft view: the person's own browser when the widget is open (they see the drafts), else the server's browser with
    // a preview token. Live view: always the server's browser as a logged-out visitor.
    const browser = opts.browser !== undefined ? opts.browser : {
      inspect: async (a: any) => a.view === "live" ? inspectElement(site.url, at(a)) : viaEyes(site.id, "inspect", at(a), async () => inspectElement(site.url, at(a), { preview: await tok() })),
      screenshot: async (a: any) => a.view === "live" ? screenshotPage(site.url, at(a)) : viaEyes(site.id, "screenshot", at(a), async () => screenshotPage(site.url, at(a), { preview: await tok() })),
      design: async (a: any) => viaEyes(site.id, "design", at(a), async () => analyzeDesign(site.url, at(a), { preview: await tok() })),
      read: async (a: any) => a.view === "live" ? readPage(site.url, at(a)) : viaEyes(site.id, "read", at(a), async () => readPage(site.url, at(a), { preview: await tok() })),
    };
    const verifier = opts.verifier !== undefined ? opts.verifier : config.verifyChanges ? new Verifier({
      siteUrl: site.url,
      previewToken: tok,
      liveText: async (url) => {
        const u = bridge.assertSameOrigin(url);
        u.searchParams.set("lcv", String(Date.now()));
        const res = await (opts.fetchImpl ?? fetch)(u, { signal: AbortSignal.timeout(config.bridgeTimeoutMs), redirect: "follow" });
        return htmlToText(await res.text());
      },
    }) : null;

    // Approval per mode: every write asks / one plan per request / nothing asks (still drafts, checked and revertable).
    const mode: ApprovalMode = job?.approval?.mode ?? "every";
    const writeStatus = mode === "auto" || (mode === "request" && job?.approval?.planApproved) ? "approved" : "user-approval";
    const approval: Record<string, "user-approval" | "approved"> = {};
    for (const name of APPROVAL_REQUIRED) approval[name] = writeStatus;
    if (mode === "request") approval.propose_plan = job?.approval?.planApproved ? "approved" : "user-approval";

    const modelId = job?.model || job?.persona?.model || config.model;
    const agent = new ToolLoopAgent({
      model: opts.model ?? resolveModel(modelId),
      instructions: systemPrompt(site, {
        files: !!siteFiles, themeWrites: config.allowThemeWrites, browser: !!browser, hostinger: !!hg, skills: skills?.catalogue() ?? "", mode,
        persona: job?.persona, siteContext: job?.siteContext, pageUrl: job?.pageUrl,
      }),
      tools: makeTools(bridge, files, {
        siteFiles, allowThemeWrites: config.allowThemeWrites, hostinger: hg, browser, verifier, skills, planTool: mode === "request",
        pageUrl: () => job?.pageUrl, ref: () => job?.ref ?? "", fetchImpl: opts.fetchImpl, allowPrivateImageHosts: opts.allowPrivateImageHosts,
      }),
      toolApproval: approval,
      // Right before every model call: turn image markers / screenshots into real pictures the model can see.
      prepareStep: ({ messages }: any) => ({ messages: hydrateMessages(messages, files) }),
      // OpenAI: send the whole conversation each time instead of pointing at items stored on OpenAI's side.
      providerOptions: { openai: { store: false } },
      stopWhen: [isStepCount(config.maxSteps), () => !!job?.shouldStop?.()], // step limit (cost safety) + the Stop button
      maxRetries: 2,
    } as any);

    return { agent: agent as unknown as AgentLike, bridge, siteFiles, model: opts.model ? "test-model" : modelId };
  };
}
