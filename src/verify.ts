import { auditPage, compareShots, type Device, type PageAudit } from "./browser.js";
import { componentChecks } from "./library/check.js";

/**
 * The automatic checks after every change the assistant makes - the same checks a careful developer does, run by the
 * backend itself (never left to the model's memory). The result goes back to the model with the tool result; when a
 * check fails it must fix or revert the change before it may say it is done.
 *
 *   1. stored    the plugin read the draft value back (it refuses the change otherwise)
 *   2. draft     the page as editors will see it: the change is there (text / element / computed styles)
 *   3. health    the draft page loads, no PHP error, no sideways scrolling on desktop and mobile, no new broken images
 *                or script errors
 *   4. live      visitors do not see the change yet (it is a draft)
 *   5. diff      what else moved on the page: text lines added/removed and the screenshot areas that changed
 */
export interface Check { name: string; ok: boolean | null; detail: string }
export interface Verification { passed: boolean; checks: Check[]; summary: string }

export interface VerifyDeps {
  siteUrl: string;
  /** A fresh preview token (?lc_preview=...) - the draft view without anyone's login. */
  previewToken: () => Promise<string>;
  /** The public page as a logged-out visitor sees it (text only). */
  liveText: (url: string) => Promise<string>;
  audit?: typeof auditPage;
  compare?: typeof compareShots;
}

const norm = (s: unknown) => typo(String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;/g, "'")).replace(/\s+/g, " ").trim().toLowerCase();
/** WordPress prints ' " -- ... as typographic characters (wptexturize): compare both sides in plain form. */
const typo = (s: string) => s.replace(/&(lsquo|rsquo|sbquo|#8216|#8217|#8218);|[‘’‚′ʼ]/g, "'").replace(/&(ldquo|rdquo|bdquo|#8220|#8221|#8222);|[“”„″]/g, '"')
  .replace(/&(ndash|mdash|#8211|#8212);|[–—]|-{2,3}/g, "-").replace(/&(hellip|#8230);|…/g, "...").replace(/&(times|#215);|×/g, "x");
const short = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const DEVICE_OF_MEDIA: Record<string, Device> = { "": "desktop", desktop: "desktop", tablet: "tablet", mobile: "mobile" };

/** What a change should look like on the page, worked out from the change itself. */
export function expectationOf(change: any): { text?: string; selector?: string; declarations?: Record<string, string>; device?: Device; hidden?: boolean } {
  const kind: string = change?.kind ?? "";
  const p = change?.payload ?? {};
  const after = p.after;
  const textual = (v: unknown) => (typeof v === "string" && norm(v).length >= 3 ? norm(v).slice(0, 80) : undefined);
  switch (kind) {
    case "post.field": return change.target === "title" ? { text: textual(after) } : {};
    case "acf.field": case "acf.value": return p.type === "image" ? {} : { text: textual(after) };
    case "block.text": return { text: textual(after), selector: `[data-lc-block="${change.object?.id}:${change.target}"]` };
    case "block.link": case "block.image": case "block.class": return { selector: `[data-lc-block="${change.object?.id}:${change.target}"]` };
    case "el.setting": {
      const [id, name] = String(change.target).split(":");
      const selector = `.elementor-element-${id}`;
      if (/^hide_(desktop|tablet|mobile)$/.test(name)) return { selector, device: name.slice(5) as Device, hidden: !!after };
      if (["text", "textarea", "wysiwyg"].includes(p.control)) return { selector, text: textual(after) };
      return { selector, device: /_mobile$/.test(name) ? "mobile" : /_tablet$/.test(name) ? "tablet" : "desktop" };
    }
    case "css.rule": {
      const decl = Object.fromEntries(Object.entries((after ?? {}) as Record<string, string>).filter(([k]) => !/^(animation|transition)/.test(k)));
      const hidden = decl.display === "none";
      if (hidden) delete decl.display;
      return { selector: p.selector, declarations: Object.keys(decl).length ? decl : undefined, device: DEVICE_OF_MEDIA[p.media ?? ""] ?? "desktop", hidden };
    }
    default: return {};
  }
}

export class Verifier {
  private audit: typeof auditPage;
  private compare: typeof compareShots;
  /**
   * The last full desktop audit of each page, kept for the NEXT change to the same page.
   *
   * A request usually makes several changes to one page, and the "after" of one change is the "before" of the
   * next: the agent is the only thing writing, and it writes one change at a time. Re-opening the page and taking
   * a second full-page screenshot to learn what we measured a moment ago is a page load per change for nothing.
   * Only desktop audits that have a screenshot are kept, because that is what `before` is for - the text and the
   * picture that the diff compares against.
   */
  private lastDesktopAudit = new Map<string, PageAudit>();
  constructor(private d: VerifyDeps) { this.audit = d.audit ?? auditPage; this.compare = d.compare ?? compareShots; }

  /** The draft page right before a change (picture + text), to compare with afterwards. null when it cannot be opened. */
  async before(url: string): Promise<PageAudit | null> {
    const known = this.lastDesktopAudit.get(url);
    if (known) return known;
    try { return await this.audit(this.d.siteUrl, { url, shot: true }, { preview: await this.d.previewToken() }); } catch { return null; }
  }

  /** A NEW page / post: see NewPostCheck. */
  newPost(previewUrl: string, e: NewPostExpect): Promise<Verification> { return new NewPostCheck(this.d, this.audit).run(previewUrl, e); }

  /** opts.component = CSS selector of a library component that was just placed: it is also measured on desktop, tablet and mobile. */
  async after(url: string, change: any, before: PageAudit | null, opts: { component?: string; softH1?: boolean } = {}): Promise<Verification> {
    const checks: Check[] = [{ name: "stored", ok: true, detail: "The site stored the draft and read it back." }];
    const exp = expectationOf(change);
    let preview: string;
    try { preview = await this.d.previewToken(); }
    catch (e) { return done([...checks, { name: "draft", ok: null, detail: "Could not open the draft view: " + (e as Error).message }]); }

    // 2 + 3: the draft page, on the screen size the change is for, then the others for health
    const device = exp.device ?? "desktop";
    let main: PageAudit | null = null;
    try {
      main = await this.audit(this.d.siteUrl, { url, device, selector: exp.selector, declarations: exp.declarations, shot: device === "desktop", component: opts.component }, { preview });
    } catch (e) {
      const msg = (e as Error).message;
      return done([...checks, { name: "draft", ok: /^BOT_CHECK/.test(msg) ? null : false, detail: "The draft page could not be opened: " + short(msg, 200) }]);
    }
    const text = norm(main.lines.join(" "));
    if (exp.text) checks.push({ name: "draft text", ok: text.includes(exp.text), detail: text.includes(exp.text) ? `The draft page shows “${short(exp.text)}”.` : `The draft page does NOT show “${short(exp.text)}”.` });
    if (main.element) {
      const el = main.element;
      if (!el.found) checks.push({ name: "element", ok: false, detail: `No element matches ${el.selector} on the draft page (${device}).` });
      else if (exp.hidden !== undefined) checks.push({ name: "visibility", ok: exp.hidden ? !el.visible : !!el.visible, detail: `On ${device} the element is ${el.visible ? "visible" : "hidden"} (wanted: ${exp.hidden ? "hidden" : "visible"}).` });
      else checks.push({ name: "element", ok: !!el.visible, detail: el.visible ? `${el.selector} is on the draft page and visible (${device}).` : `${el.selector} is on the page but not visible on ${device}.` });
      for (const s of el.styles ?? []) {
        checks.push({ name: `style ${s.prop}`, ok: s.ok, detail: s.ok === null ? `${s.prop}: ${s.actual} (${s.note})` : s.ok ? `${s.prop} is ${s.actual} as intended (${device}).`
          : `${s.prop} is ${s.actual}, not ${s.expected} (${device}): another rule wins. Inspect the element and use a more specific selector (no !important).` });
      }
    }
    checks.push(...health(main, before, device));
    if (opts.component && main.component) checks.push(...componentChecks(main.component, device, opts));
    // The other screen sizes and the live page have nothing to do with each other, and each is a page load of a
    // second or more. They used to run one after another, so a change paid for all of them in sequence; now they
    // run together and the slowest one sets the cost. Each still has its own screen size, so its own context.
    const others: Device[] = (opts.component ? ["desktop", "tablet", "mobile"] : ["desktop", "mobile"]).filter((x) => x !== device) as Device[];
    const livePromise = exp.text ? this.d.liveText(url).then((t) => norm(t), (e) => ({ error: (e as Error).message })) : null;
    const otherAudits = await Promise.all(others.map((other) =>
      this.audit(this.d.siteUrl, { url, device: other, component: opts.component }, { preview })
        .then((a) => ({ other, a }), () => null))); // a failure here is already reported by the main audit

    for (const r of otherAudits) {
      if (!r) continue;
      const { other, a } = r;
      checks.push(...health(a, null, other).filter((c) => c.ok === false));
      if (opts.component && a.component) { const cc = componentChecks(a.component, other, opts); checks.push(...cc.filter((c) => c.ok === false)); if (cc.every((c) => c.ok !== false)) checks.push({ name: `component (${other})`, ok: true, detail: `Fits, nothing overlaps or is covered on ${other}.` }); }
    }

    // 4: still a draft for visitors
    if (exp.text && livePromise) {
      const live = await livePromise;
      if (typeof live !== "string") checks.push({ name: "live", ok: null, detail: "Could not open the live page: " + live.error });
      else {
        const wasThere = before ? norm(before.lines.join(" ")).includes(exp.text) : false;
        checks.push(live.includes(exp.text) && !wasThere
          ? { name: "live", ok: null, detail: `“${short(exp.text)}” also appears on the live page (perhaps elsewhere already) - visitors may see this text.` }
          : { name: "live", ok: true, detail: "Visitors still see the live page without this change (it is a draft until deployed)." });
      }
    }

    // 5: what else changed
    if (before) {
      const was = new Set(before.lines), now = new Set(main.lines);
      const added = main.lines.filter((l) => !was.has(l)), removed = before.lines.filter((l) => !now.has(l));
      if (added.length || removed.length) checks.push({ name: "text diff", ok: null, detail: `Text lines added: ${added.length}${added.length ? ` (${added.slice(0, 3).map((l) => `“${short(l, 50)}”`).join(", ")})` : ""}; removed: ${removed.length}${removed.length ? ` (${removed.slice(0, 3).map((l) => `“${short(l, 50)}”`).join(", ")})` : ""}.` });
      if (before.shot && main.shot) {
        try {
          const d = await this.compare(before.shot, main.shot);
          checks.push({ name: "visual diff", ok: null, detail: d.bands.length ? `${d.changed}% of the page looks different, at ${d.bands.map((b) => `${b.from}–${b.to}%`).join(", ")} of the page height (top = 0%). Check that only the intended area moved.` : "The page looks the same at screenshot resolution." });
        } catch { /* not essential */ }
      }
    }
    // What this change left behind is what the next change to this page starts from. Anything else (another
    // device, no screenshot) is not a usable "before", so the page's entry is dropped rather than kept stale.
    if (device === "desktop" && main.shot) this.lastDesktopAudit.set(url, main);
    else this.lastDesktopAudit.delete(url);
    return done(checks);
  }
}

/** What a NEW page / post should show: its title, a sentence of its content and (optionally) its featured image. */
export interface NewPostExpect { title: string; content?: string; imageUrl?: string }

/** The first real sentence of block markup / HTML (plain text, lower case), to look for on the rendered page. */
export function firstText(html: string, max = 60): string | undefined {
  // inline tags (strong, a, em ...) join the words around them without a space, as the browser shows them
  const plain = (x: string) => norm(x.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""));
  const cut = (t: string) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, "")).trim();
  for (const m of String(html ?? "").matchAll(/<(p|li|h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = plain(m[2]);
    if (t.length >= 12) return cut(t);
  }
  const t = norm(html);
  return t.length >= 12 ? cut(t) : undefined;
}

export class NewPostCheck {
  constructor(private d: VerifyDeps, private audit: typeof auditPage = d.audit ?? auditPage) {}

  /**
   * Open the NEW draft (through its preview link and a preview token) the way the theme / page builder renders it, on
   * desktop and mobile: it loads, shows the title and the article, has no PHP error / sideways scrolling / broken image,
   * shows the featured image (information only: some themes do not), and visitors still cannot open it.
   */
  async run(previewUrl: string, e: NewPostExpect): Promise<Verification> {
    const checks: Check[] = [{ name: "stored", ok: true, detail: "WordPress saved the new draft." }];
    let preview: string;
    try { preview = await this.d.previewToken(); }
    catch (x) { return done([...checks, { name: "draft", ok: null, detail: "Could not open the draft view: " + (x as Error).message }]); }
    const title = norm(e.title).slice(0, 80);
    const body = e.content ? firstText(e.content) : undefined;
    const img = e.imageUrl ? imageKey(e.imageUrl) : undefined;
    for (const device of ["desktop", "mobile"] as Device[]) {
      let a: PageAudit;
      try { a = await this.audit(this.d.siteUrl, { url: previewUrl, device, selector: device === "desktop" && img ? `img[src*="${img}"], img[srcset*="${img}"]` : undefined }, { preview }); }
      catch (x) {
        const msg = (x as Error).message;
        checks.push({ name: `draft (${device})`, ok: /^BOT_CHECK/.test(msg) ? null : false, detail: "The new draft could not be opened: " + short(msg, 200) });
        continue;
      }
      if (a.status === 404) { checks.push({ name: `draft (${device})`, ok: false, detail: "The new draft answers 404 to the preview link. Is the Livecrafts plugin 0.15.1 or newer active?" }); continue; }
      const text = norm(a.lines.join(" "));
      if (device === "desktop") {
        checks.push({ name: "title", ok: text.includes(title), detail: text.includes(title) ? `The page shows the title “${short(title)}”.` : `The page does NOT show the title “${short(title)}”.` });
        if (body) checks.push({ name: "content", ok: text.includes(body), detail: text.includes(body)
          ? "The theme / page builder shows the article content."
          : `The article content does not appear on the page (looked for “${short(body)}”). The post template of this theme or page builder may not output the post content.` });
        if (img) checks.push({ name: "featured image", ok: a.element?.found ? !!a.element.visible : null, detail: a.element?.found
          ? a.element.visible ? "The featured image shows on the post page." : "The featured image is on the page but hidden."
          : "This theme does not show the featured image on the post page itself; it is still set for blog listings and social previews." });
      }
      checks.push(...health(a, null, device));
    }
    try {
      const live = norm(await this.d.liveText(previewUrl));
      const leak = !!body && live.includes(body);
      checks.push({ name: "live", ok: !leak, detail: leak ? "Visitors can read the new draft: it must stay hidden until deploy." : "Visitors cannot open the new draft (it is published on deploy)." });
    } catch (x) { checks.push({ name: "live", ok: null, detail: "Could not open the page as a visitor: " + (x as Error).message }); }
    return done(checks);
  }
}

/** The part of an image address that every resized copy shares: "photo" for .../photo-1024x576.webp. */
function imageKey(url: string): string | undefined {
  const file = String(url).split(/[?#]/)[0].split("/").pop() ?? "";
  const stem = file.replace(/\.[a-z0-9]+$/i, "").replace(/-\d+x\d+$/, "").replace(/-scaled$/, "");
  return stem.length >= 3 ? stem.replace(/["\\]/g, "") : undefined;
}

/** Page health, compared with the state before the change when known (only NEW problems fail). */
function health(a: PageAudit, before: PageAudit | null, device: Device): Check[] {
  const out: Check[] = [];
  out.push({ name: `loads (${device})`, ok: a.status === null || a.status < 400, detail: `HTTP ${a.status ?? "?"}` });
  if (a.fatal) out.push({ name: `php (${device})`, ok: false, detail: `The page shows a PHP/WordPress error: “${a.fatal}”.` });
  if (a.overflowX > 1) out.push({ name: `layout (${device})`, ok: before ? before.overflowX > 1 ? null : false : false, detail: `The page is ${a.overflowX}px wider than the screen on ${device} (sideways scrolling)${before && before.overflowX > 1 ? " - it already was before" : ""}.` });
  const newOff = (a.offscreen ?? []).filter((o) => !(before?.offscreen ?? []).includes(o));
  if (newOff.length) out.push({ name: `off screen (${device})`, ok: false, detail: `Elements stick out past the screen edge on ${device}: ${newOff.slice(0, 3).join("; ")}. Fix the width / padding of that section (no overflow:hidden hack).` });
  const newBroken = a.brokenImages.filter((u) => !before?.brokenImages.includes(u));
  if (newBroken.length) out.push({ name: `images (${device})`, ok: false, detail: `Images that do not load: ${newBroken.slice(0, 3).join(", ")}.` });
  const newErrors = a.consoleErrors.filter((m) => !before?.consoleErrors.includes(m));
  if (newErrors.length) out.push({ name: `scripts (${device})`, ok: before ? false : null, detail: `Script errors: ${newErrors.slice(0, 3).map((m) => short(m, 120)).join(" | ")}.` });
  return out;
}

function done(checks: Check[]): Verification {
  const failed = checks.filter((c) => c.ok === false);
  return {
    passed: !failed.length,
    checks,
    summary: failed.length ? `${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${failed.map((c) => c.name).join(", ")}. Fix the change or revert it before reporting success.`
      : "All checks passed.",
  };
}
