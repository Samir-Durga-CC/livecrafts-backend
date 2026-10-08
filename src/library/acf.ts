import { parseTemplate, templateToPhp } from "./engine.js";
import { CORE_CSS, CORE_CSS_ID } from "./core-css.js";
import type { CssBlock, LibraryComponent, Slot } from "./types.js";

/**
 * ACF / custom-theme hand-off. A theme driven by ACF flexible content renders its page from its own template, so a
 * component cannot just be pasted into the page content. For those sites the library produces what a developer
 * would write by hand - from the SAME content model and template that the other builders use:
 *
 *   layout       an ACF flexible-content layout (import in ACF > Tools, or add to a field group)
 *   fieldGroup   a ready field group "Livecrafts components" holding that layout
 *   phpPartial   template-parts/lc-<id>.php that renders the layout's sub fields with the same markup and classes
 *   css          the core + component CSS (Additional CSS or the theme's stylesheet)
 *
 * Nothing here is applied to the site automatically: field groups and theme files are code, the person reviews them.
 */
const key = (comp: LibraryComponent, ...path: string[]) => ["field", "lc", comp.id, ...path].join("_");

function field(comp: LibraryComponent, s: Slot, path: string[]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    key: key(comp, ...path, s.name), label: s.label, name: s.name, "aria-label": "", instructions: s.help ?? "", required: s.required ? 1 : 0, wrapper: { width: "", class: "", id: "" },
  };
  switch (s.type) {
    case "text": return { ...base, type: "text", maxlength: s.max ?? "" };
    case "shortcode": return { ...base, type: "text", instructions: s.help ?? "A single shortcode, e.g. [contact-form-7 id=\"12\"]" };
    case "textarea": return { ...base, type: "textarea", rows: 3, new_lines: "", maxlength: s.max ?? "" };
    case "url": return { ...base, type: "url" };
    case "image": return { ...base, type: "image", return_format: "url", preview_size: "thumbnail", library: "all" };
    case "select": return { ...base, type: "select", choices: Object.fromEntries((s.choices ?? []).map((c) => [c, c])), default_value: s.choices?.[0] ?? "", return_format: "value", multiple: 0, allow_null: 0 };
    case "list": return {
      ...base, type: "repeater", layout: "block", button_label: "Add row", min: s.minItems ?? 0, max: s.maxItems ?? 0,
      sub_fields: (s.fields ?? []).map((f) => field(comp, f, [...path, s.name])),
    };
  }
}

export interface AcfExport {
  component: string;
  layout: Record<string, unknown>;
  fieldGroup: Record<string, unknown>;
  phpPartial: string;
  css: CssBlock[];
  howTo: string[];
}

export function acfExport(comp: LibraryComponent): AcfExport {
  const layout = {
    key: `layout_lc_${comp.id}`, name: `lc_${comp.id}`, label: `${comp.name} (Livecrafts)`, display: "block", min: "", max: "",
    sub_fields: comp.slots.map((s) => field(comp, s, [])),
  };
  const fieldGroup = {
    key: "group_lc_components", title: "Livecrafts components",
    fields: [{ key: "field_lc_sections", label: "Livecrafts sections", name: "lc_sections", "aria-label": "", type: "flexible_content", instructions: "", required: 0, layouts: { [layout.key]: layout }, button_label: "Add section", min: "", max: "" }],
    location: [[{ param: "post_type", operator: "==", value: "page" }]], menu_order: 0, position: "normal", style: "default", label_placement: "top", instruction_placement: "label", active: true,
  };
  const phpPartial = `<?php
/**
 * Livecrafts component: ${comp.name}.
 * Renders the ACF layout "lc_${comp.id}". Load it inside the flexible-content loop of your page template:
 *
 *   while ( have_rows( 'lc_sections' ) ) : the_row();
 *       if ( 'lc_${comp.id}' === get_row_layout() ) get_template_part( 'template-parts/lc-${comp.id}' );
 *   endwhile;
 *
 * The markup and class names are the library's, so its core stylesheet (class "lc-c") protects it from the theme.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
${templateToPhp(parseTemplate(comp.html), comp.php)}`;
  return {
    component: comp.id, layout, fieldGroup, phpPartial,
    css: [{ id: CORE_CSS_ID, label: "Livecrafts components: core", css: CORE_CSS }, { id: `lc-c-${comp.id}`, label: `Livecrafts component: ${comp.name}`, css: comp.css }],
    howTo: [
      "ACF > Tools > Import Field Groups: import `fieldGroup` (as JSON), or add `layout` to your own flexible-content field.",
      `Save the PHP partial as template-parts/lc-${comp.id}.php in the (child) theme and call it from the flexible-content loop of the page template.`,
      "Add the CSS blocks to Additional CSS (core first) or to the theme stylesheet.",
      "Fill the layout in the page editor. The core CSS keeps it inside its container on every screen size.",
    ],
  };
}
