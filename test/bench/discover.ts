/**
 * Bench step 0: what is actually on each site.
 *
 *   npm run bench:discover                  every saved site
 *   npm run bench:discover -- cct-anythin   only sites whose id or url contains this
 *   npm run bench:discover -- --page https://example.com/some-page
 *
 * Prints, per site: the plugin version and theme, any recorded fatal, and the page map by surface (ACF / Elementor /
 * Divi) with each target's id and current value. Scenario expectations are written from THIS output, never from a
 * guess - an assertion against invented text fails for the wrong reason and teaches nothing.
 */
import path from "node:path";
import { config } from "../../src/config.js";
import { JsonStore } from "../../src/store.js";
import { Bridge } from "../../src/bridge.js";
import type { Site } from "../../src/types.js";

const argv = process.argv.slice(2);
const pageFlag = argv.indexOf("--page");
const pageUrl = pageFlag >= 0 ? argv[pageFlag + 1] : undefined;
const only = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--page"));

const sites = new JsonStore<Site>(path.join(config.dataDir, "sites"));
const short = (v: unknown, n = 56) => {
  const s = String(v ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

for (const site of sites.list()) {
  if (only.length && !only.some((o) => site.id.includes(o) || site.url.includes(o))) continue;
  console.log("\n" + "=".repeat(104));
  console.log(`${site.id}  ${site.url}`);
  console.log("=".repeat(104));
  const bridge = new Bridge(site);

  try {
    const p = (await bridge.siteProfile()) as any;
    const b = p.builders ?? {};
    const parts = [
      `plugin ${p.version}`,
      `wp ${p.wp}`,
      `theme ${p.theme?.name} ${p.theme?.version}${p.theme?.block_theme ? " (block theme)" : ""}`,
      `elementor ${b.elementor?.active ? b.elementor.version : "off"}`,
      `acf ${b.acf?.active ? b.acf.version + (b.acf.pro ? " pro" : "") : "off"}`,
    ];
    console.log(parts.join("  |  "));
  } catch (err) {
    console.log(`site-profile FAILED: ${(err as any).status ?? ""} ${(err as Error).message}`);
  }

  try {
    const st = (await bridge.status()) as any;
    console.log(`drafts=${st.drafts ?? 0} conflicts=${st.conflicts ?? 0} broken=${st.broken ?? 0} outside_changes=${st.outside_changes_since_release ?? 0} legacy_overlay=${st.legacy_overlay ?? false}`);
    if (st.last_fatal) console.log(`LAST FATAL ${st.last_fatal.at}  ${st.last_fatal.file}:${st.last_fatal.line}\n   ${short(st.last_fatal.message, 200)}`);
  } catch (err) {
    console.log(`status FAILED: ${(err as any).status ?? ""} ${(err as Error).message}`);
  }

  let map: any;
  try { map = await bridge.map({ url: pageUrl ?? site.url + "/", view: "draft" }); }
  catch (err) { console.log(`map FAILED: ${(err as any).status ?? ""} ${(err as Error).message}`); continue; }

  console.log(`\npage id=${map.post?.id} "${short(map.post?.title)}"  builders=${JSON.stringify(map.builders ?? {})}`);

  for (const surface of ["acf", "elementor", "divi"] as const) {
    const list = (map[surface] ?? []) as any[];
    if (!Array.isArray(list) || !list.length) { console.log(`\n  --- ${surface}: none`); continue; }
    console.log(`\n  --- ${surface} (${list.length} editable)`);
    for (const t of list.slice(0, 18)) {
      console.log(`   tid=${String(t.tid ?? "").padEnd(32)} ${String(t.widget ?? t.ftype ?? "").padEnd(13)} ${String(t.label ?? t.name ?? "").padEnd(26)} = ${short(t.value)}`);
    }
    if (list.length > 18) console.log(`   … ${list.length - 18} more`);
  }

  for (const surface of ["elementor_outline", "divi_outline"] as const) {
    const list = (map[surface] ?? []) as any[];
    if (!Array.isArray(list) || !list.length) continue;
    console.log(`\n  --- ${surface} (${list.length})`);
    for (const o of list.slice(0, 22)) {
      console.log(`   ${"  ".repeat(Number(o.depth ?? 0))}${String(o.id ?? o.path ?? "")} ${String(o.type ?? "")} ${short(o.text, 44)}`);
    }
    if (list.length > 22) console.log(`   … ${list.length - 22} more`);
  }
}
