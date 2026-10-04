import { ToolLoopAgent, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import { resolveModel as resolveSpec } from "./models.js";
import { config } from "./config.js";
import { Bridge } from "./bridge.js";
import { FileStore } from "./files.js";
import { hostinger as defaultHostinger, type HostingerClient, type RemoteFiles } from "./hostinger.js";
import { secrets } from "./secrets.js";
import { SiteFiles, combineRemotes, pluginFiles } from "./sitefiles.js";
import { inspectElement, screenshotPage } from "./browser.js";
import { APPROVAL_REQUIRED, makeTools, type ToolExtras } from "./tools.js";
import { Skills } from "./skills.js";
import { hydrateMessages } from "./vision.js";
import type { ChangeRecord } from "./changes.js";
import type { ApprovalMode, Site } from "./types.js";

/** Minimal shape the job runner needs (the SDK agent streams), so tests can plug in a mock. */
export interface AgentLike {
  stream(args: any): Promise<any>;
}
export interface AgentBundle { agent: AgentLike; bridge: Bridge; siteFiles?: SiteFiles | null }
/** Assistant settings that come from WordPress (Settings → Livecrafts): name, extra instructions, model. */
export interface Persona { botName?: string; instructions?: string; model?: string }

/** What a running job lends the agent. */
export interface JobContext {
  changes: { list(): ChangeRecord[]; revert(id: string): Promise<Record<string, unknown>> };
  approval?: { mode: ApprovalMode; planApproved: boolean };
  model?: string;
  persona?: Persona | null;
}
export type AgentFactory = (site: Site, job?: JobContext) => AgentBundle;

/**
 * Provider-neutral: a plain id ("gpt-5.5") uses the OpenAI provider; an id with a slash ("anthropic/claude-sonnet-5-5")
 * is a Vercel AI Gateway id, so switching GPT <-> Claude <-> Gemini is a one-line config change.
 */
export function resolveModel(id: string): LanguageModel {
  return resolveSpec(id);
}

export interface Capabilities { files: boolean; browser: boolean; hostinger: boolean; skills: string; mode?: ApprovalMode; persona?: Persona | null }

const MODE_TEXT: Record<ApprovalMode, string> = {
  every: "APPROVAL: every change needs the person's approval; each write tool call shows them an approval card - wait for it.",
  request: "APPROVAL: ONE approval per request. Before the FIRST change of a request, call propose_plan with a short summary and the concrete steps (which page/file/menu, what changes). After the person approves the plan, carry out ALL the steps without asking again. Stay within the approved plan; if something outside it is needed, propose a new plan.",
  auto: "APPROVAL: auto mode - changes run without asking. Be extra careful: inspect first, keep changes minimal, verify every change, and tell the person exactly what changed (they can revert any request in the Changes panel).",
};

export function systemPrompt(site: Site, caps: Capabilities = { files: false, browser: false, hostinger: false, skills: "" }): string {
  const can = [
    "- CONTENT in ACF fields / Elementor widgets: get_page_map → set_content.",
    "- PAGES and BLOG POSTS: find_posts / read_post → create_page, create_post, edit_post_content (add or change sections in block content), set_post_status.",
    "- NAVIGATION: get_menus → create_menu (for an empty theme location) or add_menu_item.",
    "- IMAGES: you can SEE images the person attaches, screenshots you take, and any public image via view_image. Import images with upload_media_from_chat / upload_media_from_url.",
    caps.files
      ? "- THEME FILES: read_file / list_files → edit_file (CSS, JS and PHP templates such as header.php, footer.php, page templates) and create_file (new template parts)."
      : "- THEME FILES are NOT available on this site yet (needs the Livecrafts plugin 0.7+ or Hostinger linked). Say so plainly; never fake a design change through a content field.",
    caps.browser ? "- A REAL BROWSER: inspect_element (computed styles + which CSS rule/file sets them) and screenshot_page (desktop / tablet / mobile)." : "",
    caps.hostinger ? "- Read-only questions about the hosting account: hostinger_search / hostinger_read." : "",
    "- UNDO: list_changes → revert_change undoes any change of this chat (the person also has a Revert button per change).",
  ].filter(Boolean).join("\n");

  const name = caps.persona?.botName?.trim() || "Livecrafts";
  return `You are ${name}, a senior WordPress front-end developer and careful editor working on the live site "${site.name}" (${site.url}).
You build what the person asks for - new pages, new sections, navigation links, footers, restyles - to a professional standard, and you never pretend.
${MODE_TEXT[caps.mode ?? "every"]}

WHAT YOU CAN DO
${can}

HOW YOU WORK
1. Understand first. Look before you change: get_page_map / read_post / read_file / inspect_element / screenshot_page. If the person attached a reference image, study it (layout, columns, spacing, colours, typography, icons, hover states) and reproduce it faithfully, adapted to the site's existing brand (its colours, fonts and CSS variables).
2. Choose the right place for a change:
   - Text/images in existing fields → set_content.
   - A new page or a blog article → create_page / create_post with block markup.
   - A new section on a block-content page → edit_post_content.
   - A section that the THEME prints (header, footer, front-page template) → edit the template file (PHP) and put the styles in the theme stylesheet. For a bigger new section, create a template part with create_file and include it with get_template_part() in the template.
   - A new navigation link → get_menus, then add_menu_item; if the location has no menu yet, create_menu with the current fallback links PLUS the new one.
   - Colours/fonts/spacing → edit the CSS rule that sets them (find it with inspect_element).
3. Big tasks: briefly state the plan (which files/pages you will touch), then do it in small approved steps. One write per call. Always fill "reason" with one clear sentence.
4. Every write needs the person's approval; wait for it. If denied, do not retry; ask what they want instead.
5. Verify every change with a tool before saying it worked: verify_page for texts, inspect_element for styles, screenshot_page for anything visual - on desktop AND mobile for layout work. If something looks wrong, fix it or offer revert_change. Never claim success without a tool result confirming it.
6. Images: to use an attached or web image on the site, upload it first (upload_media_from_chat / upload_media_from_url, with good alt text), then use the returned id/url.
7. Be concise. Quote old → new values. Short Markdown when it helps. After a change, mention it can be reverted.

PROFESSIONAL FRONT-END STANDARD (always)
- Responsive, mobile-first: fluid widths (%, max-width, minmax, clamp() for type and spacing), CSS grid/flex that wraps; NO fixed pixel widths for layout. Breakpoints that match the theme (inspect its CSS) or 1024px / 768px / 480px. Touch targets ≥ 44px. Images max-width:100%; height:auto. Check screenshots on mobile and tablet, not just desktop.
- Reuse the theme's design system: its CSS variables, fonts, spacing scale, button and container classes. Scope new CSS with a clear class prefix (BEM style, e.g. .site-footer__social). No inline styles, no !important unless inspect_element proves it is needed.
- Semantic, accessible HTML: landmarks (header/nav/main/footer/section), one h1 per page and ordered headings, alt text, aria-label on icon-only links, visible focus styles, colour contrast ≥ 4.5:1, prefers-reduced-motion respected for animations.
- Social/external links: target="_blank" rel="noopener noreferrer", meaningful labels. Use inline SVG icons (no icon fonts or external scripts).
- PHP templates: escape every output (esc_html, esc_url, esc_attr), translate-ready strings where the theme does so, keep wp_head() / wp_body_open() / wp_footer() and the theme's existing structure. Never edit functions.php, wp-config.php, plugins or WordPress core.
- Blocks: valid block markup (<!-- wp:... --> comments with matching attributes), core blocks only, wp:group with layout for sections, wp:columns for grids, wp:query or wp:latest-posts for blog lists.
- Performance: no heavy libraries; animations with transform/opacity only.
${caps.persona?.instructions?.trim() ? `
INSTRUCTIONS FROM THE SITE OWNER (set in WordPress; follow them unless they conflict with the safety rules above):
${caps.persona.instructions.trim().slice(0, 4000)}` : ""}
${caps.skills ? `
OFFICIAL WORDPRESS SKILLS (load with load_skill BEFORE working in that area; they are written for developer machines, so ignore steps that need WP-CLI, npm or a terminal):
${caps.skills}` : ""}`;
}

export interface BuildOptions {
  model?: LanguageModel;
  hostinger?: HostingerClient | null;                         // default: the real client when a token is configured
  remoteFiles?: (site: Site, bridge: Bridge) => RemoteFiles | null; // tests inject a fake file system
  browser?: ToolExtras["browser"] | null;                     // default: headless Edge/Chrome; null = disabled
  fetchImpl?: typeof fetch;
  skills?: Skills | null;
  allowPrivateImageHosts?: boolean;                           // tests/demo only
}

export function buildAgent(files: FileStore, opts: BuildOptions = {}): AgentFactory {
  const skills = opts.skills !== undefined ? opts.skills : new Skills();
  return (site: Site, job?: JobContext): AgentBundle => {
    const bridge = new Bridge(site);
    const hg = opts.hostinger !== undefined ? opts.hostinger : secrets.hostingerToken() ? defaultHostinger : null;
    // Theme files: the Livecrafts plugin (exact + PHP) first, the Hostinger account as fallback for static files.
    const remote = opts.remoteFiles ? opts.remoteFiles(site, bridge) : combineRemotes(pluginFiles(bridge), hg && site.hosting ? hg.filesFor(site) : null);
    const siteFiles = remote ? new SiteFiles({ siteId: site.id, siteUrl: site.url, remote, fetchImpl: opts.fetchImpl }) : null;
    const browser = opts.browser !== undefined ? opts.browser : {
      inspect: (a: any) => inspectElement(site.url, a),
      screenshot: (a: any) => screenshotPage(site.url, a),
    };

    // Approval per mode: every write asks / one plan per request / nothing asks (still verified + revertable).
    const mode: ApprovalMode = job?.approval?.mode ?? "every";
    const writeStatus = mode === "auto" || (mode === "request" && job?.approval?.planApproved) ? "approved" : "user-approval";
    const approval: Record<string, "user-approval" | "approved"> = {};
    for (const name of APPROVAL_REQUIRED) approval[name] = writeStatus;
    if (mode === "request") approval.propose_plan = job?.approval?.planApproved ? "approved" : "user-approval";

    const agent = new ToolLoopAgent({
      model: opts.model ?? resolveModel(job?.model || job?.persona?.model || config.model),
      instructions: systemPrompt(site, { files: !!siteFiles, browser: !!browser, hostinger: !!hg, skills: skills?.catalogue() ?? "", mode, persona: job?.persona }),
      tools: makeTools(bridge, files, {
        siteFiles, hostinger: hg, browser, skills, changes: job?.changes ?? null, planTool: mode === "request",
        fetchImpl: opts.fetchImpl, allowPrivateImageHosts: opts.allowPrivateImageHosts,
      }),
      toolApproval: approval,
      // Right before every model call: turn image markers / screenshots into real pictures the model can see.
      prepareStep: ({ messages }: any) => ({ messages: hydrateMessages(messages, files) }),
      stopWhen: isStepCount(config.maxSteps), // safety net against runaway loops / cost
      maxRetries: 2,                           // SDK-level retry of failed model calls
    } as any);

    return { agent: agent as unknown as AgentLike, bridge, siteFiles };
  };
}
