/**
 * A fake WordPress site with the Livecrafts plugin 0.10 API, in memory - for the tests and the demo.
 * It keeps the important behaviour of the real plugin: every change is a DRAFT (visitors see the live value, a preview
 * with a valid preview token sees the draft), the history records who made each change (X-Livecrafts-Actor), revert
 * drops a draft or drafts the old value, deploy is NOT reachable with the backend's account.
 */
import http from "node:http";
import crypto from "node:crypto";

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d10000000049454e44ae426082", "hex");

export interface FakeChange { id: number; status: "draft" | "live" | "discarded"; source: string; user: { id: number; login: string; name: string }; object: { type: string; id: number; label: string; url: string };
  kind: string; target: string; summary: string; release: null | number; reverts: number | null; ref: string; at: string; payload: { before: unknown; after: unknown } }

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startFakeSite() {
  const secret = crypto.randomBytes(32).toString("hex");
  const s = {
    secret,
    live: { field_hero_title: "Old Title", "abc123:title": "Elementor Heading" } as Record<string, string>,
    changes: [] as FakeChange[],
    notes: { site: "", page: "" },
    media: [] as number[],
    previewTokens: new Set<string>(),
    seenActors: [] as string[],
    deployAttempts: 0,
    tplExtra: false,
    created: [] as any[],
    termUpdates: [] as any[],
    terms: { categories: [{ id: 1, name: "Uncategorized", slug: "uncategorized", count: 0 }, { id: 2, name: "Performance", slug: "performance", count: 4 }], tags: [{ id: 3, name: "speed", slug: "speed", count: 2 }] } as Record<string, any[]>,
    nextId: 100,
    url: "",
  };
  /** A widget token for a WordPress user, signed like the plugin does. */
  const widgetToken = (uid = 7, opts: { exp?: number; site?: string; secret?: string } = {}) => {
    const payload = b64url(JSON.stringify({ v: 1, k: "widget", site: opts.site ?? s.url, uid, login: "editor" + uid, name: "Editor " + uid, edit: true, deploy: false, exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600 }));
    return payload + "." + b64url(crypto.createHmac("sha256", opts.secret ?? secret).update(payload).digest());
  };
  const actorOf = (req: http.IncomingMessage) => {
    const t = String(req.headers["x-livecrafts-actor"] ?? "");
    if (!t) return { id: 1, login: "admin", name: "Admin" };
    s.seenActors.push(t);
    const [p, sig] = t.split(".");
    if (b64url(crypto.createHmac("sha256", secret).update(p).digest()) !== sig) return { id: 1, login: "admin", name: "Admin" };
    const d = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return { id: d.uid, login: d.login, name: d.name };
  };
  /** Value of a target as editors see it (live + drafts). */
  const draftValue = (target: string) => { const d = s.changes.filter((c) => c.status === "draft" && c.target === target).at(-1); return d ? String(d.payload.after) : s.live[target]; };
  const page = (preview: boolean) => {
    const v = (t: string) => (preview ? draftValue(t) : s.live[t]);
    return `<!doctype html><html><head><title>Home</title></head><body><h1 class="hero">${v("field_hero_title")}</h1><div class="elementor-element elementor-element-abc123"><h2>${v("abc123:title")}</h2></div></body></html>`;
  };
  const make = (req: http.IncomingMessage, b: any, kind: string, target: string, after: unknown, summary: string, extra: Partial<FakeChange> = {}): FakeChange => {
    const c: FakeChange = { id: s.nextId++, status: "draft", source: b.source ?? "assistant", user: actorOf(req), object: { type: "post", id: 5, label: "Page “Home”", url: s.url + "/" },
      kind, target, summary, release: null, reverts: null, ref: b.ref ?? "", at: new Date().toISOString(), payload: { before: draftValue(target), after }, ...extra };
    s.changes.push(c);
    return c;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const raw = await new Promise<string>((r) => { let x = ""; req.on("data", (c) => (x += c)); req.on("end", () => r(x)); });
    const b = raw && /json/.test(String(req.headers["content-type"])) ? JSON.parse(raw) : {};
    const json = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const lc = u.pathname.replace("/wp-json/livecrafts/v1/", "");
    const get = req.method === "GET", post = req.method === "POST";

    if (lc === "ping") return json(200, { ok: true, plugin: "livecrafts", version: "0.10.0", capabilities: { acf: true, elementor: true, drafts: true }, drafts: s.changes.filter((c) => c.status === "draft").length });
    if (lc === "connect" && post) return json(200, { ok: true, secret, site: s.url, version: "0.10.0" });
    if (lc === "assistant") return json(200, { ok: true, botName: "Aero bot", welcome: "Hi", instructions: "", model: "", approvalMode: "every" });
    if (lc === "preview-token" && post) { const t = crypto.randomBytes(8).toString("hex"); s.previewTokens.add(t); return json(200, { ok: true, token: t, param: "lc_preview" }); }
    if (lc === "map") return json(200, { ok: true, view: u.searchParams.get("view") ?? "draft", post: { id: 5, title: "Home", url: s.url + "/" }, builders: { elementor: true, acf_fields: 1 },
      acf: [{ kind: "acf", tid: "acf:field_hero_title:5", key: "field_hero_title", name: "hero_title", label: "Hero title", ftype: "text", value: u.searchParams.get("view") === "live" ? s.live.field_hero_title : draftValue("field_hero_title") }],
      elementor: [{ kind: "el", tid: "el:5:abc123:title", id: "abc123", label: "Heading › Title", ftype: "text", value: draftValue("abc123:title") }],
      elementor_outline: [{ id: "abc123", type: "heading", elType: "widget", parent: "", index: 0, depth: 0, text: draftValue("abc123:title") }], drafts: s.changes.filter((c) => c.status === "draft").length });
    if (lc === "site-profile") return json(200, { ok: true, version: "0.12.0", wp: "6.8", theme: { name: "Hello Elementor", slug: "hello-elementor", block_theme: false }, builders: { elementor: { active: true, version: "3.30", pro: false, containers: true, widgets: ["heading", "text-editor", "image", "button", "shortcode", "testimonial"], colors: [{ id: "primary", title: "Primary", value: "#1d4ed8" }], fonts: [] }, acf: { active: false }, blocks: { patterns: 0 } }, forms: [{ plugin: "Contact Form 7", id: 5, title: "Contact form 1", shortcode: '[contact-form-7 id="5"]' }] });
    if (lc === "components") return json(200, { ok: true, items: [{ id: "el-section:5:3ac5722", kind: "elementor-section", builder: "elementor", name: "Trusted by Industrial Teams", where: "Page “Home”", post: 5, matched: ["testimonial"], score: 3 }, { id: "el-widget:testimonial", kind: "elementor-widget", builder: "elementor", name: "Testimonial", where: "Elementor widget", matched: ["testimonial"], score: 2 }] });
    if (lc === "templates") return json(200, { ok: true, active: true, version: "1.2.0", components: [
      { id: "hero", shortcode: "ai_hero", title: "hero (split, text left / image right)", params: "eyebrow, heading, text, primary_label, primary_url, image", example: "[ai_hero heading=\"x\"]", attributes: ["eyebrow", "heading", "text", "image", "primary_label", "primary_url", "secondary_label", "secondary_url"], defaults: {}, list: false, item_fields: "", usedOn: [], renderedAt: [] },
      ...(s.tplExtra ? [{ id: "testimonials", shortcode: "ai_testimonials", title: "testimonials", params: "heading, items [ quote, name, role ]", example: "", attributes: ["heading"], defaults: {}, list: true, item_fields: "quote, name, role", usedOn: [], renderedAt: [] }] : []),
      { id: "faq", shortcode: "ai_faq", title: "faq (accordion)", params: "heading, text, items [ title, text ]", example: "[ai_faq]", attributes: ["heading", "text"], defaults: {}, list: true, item_fields: "title, text", usedOn: [{ post: 5, title: "Home", url: "http://x/", status: "publish", count: 1, in: ["live"] }], renderedAt: [] },
    ] });
    if (lc === "components/source") return json(200, { ok: true, builder: "elementor", kind: "el.insert", node: { elType: "container", settings: { content_width: "full" }, elements: [{ elType: "widget", widgetType: "heading", settings: { title: "Trusted by Industrial Teams" }, elements: [] }] }, dropped: ["container › __globals__"] });
    if (lc === "debug/target") return json(200, { draft_value: draftValue("field_hero_title"), live_value: s.live.field_hero_title });
    if (lc === "status") {
      const drafts = s.changes.filter((c) => c.status === "draft");
      return json(200, { ok: true, drafts: { count: drafts.length, objects: drafts.length ? [{ object: { type: "post", id: 5, label: "Page “Home”", url: s.url + "/" }, changes: drafts }] : [] },
        conflicts: [], broken: [], last_release: null, outside_changes_since_release: [{ id: 1, status: "live", source: "elementor", user: { name: "Maria" }, object: { label: "Page “Home”" }, kind: "external.edit", summary: "Edited in Elementor editor: Elementor data", at: "2026-10-06T10:00:00Z" }],
        legacy_overlay: null, deploy: { allowed: false, asks_for: "your WordPress password" } });
    }
    if (lc === "changes" && get) return json(200, { ok: true, changes: [...s.changes].reverse() });
    let m = lc.match(/^changes\/(\d+)$/);
    if (m && get) { const c = s.changes.find((x) => x.id === Number(m![1])); return c ? json(200, { ok: true, change: c }) : json(404, { code: "livecrafts_unknown", message: "Unknown change." }); }
    if (lc === "changes" && post) {
      if (b.kind === "acf.field" && b.target === "field_hero_title") {
        if (typeof b.value !== "string" || !b.value.trim()) return json(400, { code: "livecrafts_bad_value", message: "Invalid value." });
        if (draftValue(b.target) === b.value) return json(200, { ok: true, unchanged: true });
        return json(200, { ok: true, change: make(req, b, "acf.field", b.target, b.value, `ACF Hero title: “${draftValue(b.target)}” → “${b.value}”`) });
      }
      if (b.kind === "el.setting" && b.target === "abc123:title") return json(200, { ok: true, change: make(req, b, "el.setting", b.target, b.value, `Elementor Heading › Title → “${b.value}”`) });
      if (b.kind === "css.rule") { if (JSON.stringify(b.value).includes("!important")) return json(400, { code: "livecrafts_bad_value", message: "Do not use !important." }); return json(200, { ok: true, change: make(req, b, "css.rule", "rule-x", b.value?.declarations, "Style " + b.value?.selector) }); }
      if (b.kind === "css.block" || b.kind === "el.insert" || b.kind === "block.insert") {
        if (b.kind === "css.block" && draftValue(b.target) === String(b.value)) return json(200, { ok: true, unchanged: true });
        return json(200, { ok: true, change: make(req, b, b.kind, b.target, typeof b.value === "string" ? b.value : JSON.stringify(b.value), b.kind === "css.block" ? "Additional CSS block " + b.target : "Add " + (b.kind === "el.insert" ? "Elementor section" : "blocks")) });
      }
      return json(404, { code: "livecrafts_no_field", message: "That field is not part of this page." });
    }
    m = lc.match(/^changes\/(\d+)\/revert$/);
    if (m && post) {
      const c = s.changes.find((x) => x.id === Number(m![1]));
      if (!c) return json(404, { code: "livecrafts_unknown", message: "Unknown change." });
      if (c.status === "draft") { c.status = "discarded"; return json(200, { ok: true, dropped: c.id, note: "Removed from the draft. The live site was never changed by it." }); }
      return json(200, { ok: true, change: make(req, b, c.kind, c.target, c.payload.before, "Revert: " + c.summary, { reverts: c.id }), note: "The old value is back in the draft. Deploy to put it on the live site." });
    }
    if (lc === "pages" && post) {
      const allowed = new Set((b.create_terms ?? []).map((n: string) => n.toLowerCase()));
      const unknown = [...(b.categories ?? []).map((n: string) => ["categories", n]), ...(b.tags ?? []).map((n: string) => ["tags", n])]
        .filter(([tax, n]) => !s.terms[tax].some((t) => t.name.toLowerCase() === String(n).toLowerCase()) && !allowed.has(String(n).toLowerCase()));
      if (unknown.length) return json(409, { code: "livecrafts_new_terms", message: "These do not exist on the site yet: " + unknown.map((x) => x[1]).join(", ") });
      s.created.push(b);
      const c = make(req, b, "post.create", "", null, `New ${b.type === "post" ? "post" : "page"} “${b.title}”`);
      const id = s.nextId++;
      const named = (tax: string, list?: unknown[]) => (list ?? []).map((n) => { const t = s.terms[tax].find((x) => x.name.toLowerCase() === String(n).toLowerCase()); return t ? { id: t.id, name: t.name, created: false } : { id: s.nextId++, name: String(n), created: true }; });
      return json(200, { ok: true, id, preview: `${s.url}/?p=${id}&preview=true`, change: c,
        ...(b.featured_media ? { featured_media: { id: b.featured_media, url: `${s.url}/wp-content/uploads/${b.featured_media}.webp`, alt: "alt" } } : {}),
        ...(b.type === "post" ? { categories: named("categories", b.categories), tags: named("tags", b.tags) } : {}),
        ...(b.meta_description ? { seo: { plugin: "", meta_key: "lc_meta_description", description: b.meta_description } } : {}) });
    }
    if (lc === "post-terms" && post) { s.termUpdates.push(b); return json(200, { ok: true, id: b.post, categories: (b.categories ?? []).map((n: string) => ({ id: 0, name: n, created: (b.create_terms ?? []).includes(n) })), tags: (b.tags ?? []).map((n: string) => ({ id: 0, name: n, created: (b.create_terms ?? []).includes(n) })) }); }
    if (lc === "post") return json(200, { ok: true, id: 5, view: u.searchParams.get("view"), title: "Home", status: "publish", content: "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->", url: s.url + "/" });
    if (lc === "notes" && get) return json(200, { ok: true, site: { text: s.notes.site }, page: u.searchParams.get("post") ? { text: s.notes.page } : null });
    if (lc === "notes" && post) { if (Number(b.post)) s.notes.page = b.text; else s.notes.site = b.text; return json(200, { ok: true, notes: { text: b.text, updated: new Date().toISOString() } }); }
    if (lc === "deploy") { s.deployAttempts++; return json(403, { code: "rest_forbidden", message: "Sorry, you are not allowed to do that." }); }
    if (u.pathname === "/wp-json/wp/v2/media" && post) { const id = s.nextId++; s.media.push(id); return json(201, { id, source_url: `${s.url}/wp-content/uploads/${id}.png`, mime_type: req.headers["content-type"] }); }
    if (/^\/wp-json\/wp\/v2\/media\/\d+$/.test(u.pathname)) return json(200, { id: 1 });
    if (u.pathname === "/wp-json/wp/v2/media" && get) return json(200, [{ id: 42, source_url: `${s.url}/wp-content/uploads/team.jpg`, alt_text: "The team at work", title: { rendered: "Team" }, media_details: { width: 1600, height: 900 } }]);
    if (u.pathname === "/wp-json/wp/v2/categories" || u.pathname === "/wp-json/wp/v2/tags") return json(200, s.terms[u.pathname.endsWith("tags") ? "tags" : "categories"]);
    if (u.pathname === "/wp-json/wp/v2/pages") return json(200, [{ id: 5, link: s.url + "/", title: { rendered: "Home" }, status: "publish" }]);
    if (u.pathname === "/img/logo.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/img/not-an-image") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("<html>nope</html>"); }
    if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(page(s.previewTokens.has(u.searchParams.get("lc_preview") ?? ""))); }
    json(404, { code: "rest_no_route", message: "No route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { s, url: s.url, widgetToken, page, close: () => server.close() };
}
