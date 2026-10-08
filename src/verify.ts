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

const norm = (s: unknown) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
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
  constructor(private d: VerifyDeps) { this.audit = d.audit ?? auditPage; this.compare = d.compare ?? compareShots; }

  /** The draft page right before a change (picture + text), to compare with afterwards. null when it cannot be opened. */
  async before(url: string): Promise<PageAudit | null> {
    try { return await this.audit(this.d.siteUrl, { url, shot: true }, { preview: await this.d.previewToken() }); } catch { return null; }
  }

  /** opts.component = CSS selector of a library component that was just placed: it is also measured on desktop, tablet and mobile. */
  async after(url: string, change: any, before: PageAudit | null, opts: { component?: string } = {}): Promise<Verification> {
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
    if (opts.component && main.component) checks.push(...componentChecks(main.component, device));
    const others: Device[] = opts.component ? ["desktop", "tablet", "mobile"] : ["desktop", "mobile"];
    for (const other of others.filter((x) => x !== device)) {
      try {
        const a = await this.audit(this.d.siteUrl, { url, device: other, component: opts.component }, { preview });
        checks.push(...health(a, null, other).filter((c) => c.ok === false));
        if (opts.component && a.component) { const cc = componentChecks(a.component, other); checks.push(...cc.filter((c) => c.ok === false)); if (cc.every((c) => c.ok !== false)) checks.push({ name: `component (${other})`, ok: true, detail: `Fits, nothing overlaps or is covered on ${other}.` }); }
      } catch { /* reported by the main audit */ }
    }

    // 4: still a draft for visitors
    if (exp.text) {
      try {
        const live = norm(await this.d.liveText(url));
        const wasThere = before ? norm(before.lines.join(" ")).includes(exp.text) : false;
        checks.push(live.includes(exp.text) && !wasThere
          ? { name: "live", ok: null, detail: `“${short(exp.text)}” also appears on the live page (perhaps elsewhere already) - visitors may see this text.` }
          : { name: "live", ok: true, detail: "Visitors still see the live page without this change (it is a draft until deployed)." });
      } catch (e) { checks.push({ name: "live", ok: null, detail: "Could not open the live page: " + (e as Error).message }); }
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
    return done(checks);
  }
}

/** Page health, compared with the state before the change when known (only NEW problems fail). */
function health(a: PageAudit, before: PageAudit | null, device: Device): Check[] {
  const out: Check[] = [];
  out.push({ name: `loads (${device})`, ok: a.status === null || a.status < 400, detail: `HTTP ${a.status ?? "?"}` });
  if (a.fatal) out.push({ name: `php (${device})`, ok: false, detail: `The page shows a PHP/WordPress error: “${a.fatal}”.` });
  if (a.overflowX > 1) out.push({ name: `layout (${device})`, ok: before ? before.overflowX > 1 ? null : false : false, detail: `The page is ${a.overflowX}px wider than the screen on ${device} (sideways scrolling)${before && before.overflowX > 1 ? " - it already was before" : ""}.` });
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
