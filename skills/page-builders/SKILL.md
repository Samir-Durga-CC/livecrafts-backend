---
name: page-builders
description: "Use before changing or adding anything: which builder this specific page is made with (Elementor, Gutenberg blocks, Divi, WPBakery/classic shortcodes, or an ACF-flexible-content theme) decides which tool is safe to use and where a new section may go. Getting this wrong is how sections end up squeezed into a 50%-width column, wrapped in dead overlay CSS, or break the theme."
---

# Page builders

Livecrafts edits the page's real source, never a copy. Which source depends on the builder, and the builder is a property of the PAGE, not the site - one site can mix an Elementor landing page with classic posts. Detect it every time (`find_components` / `place_component` do this for you via `site_profile` + the page's own data); never assume from a previous page or from what the site "mostly" uses.

## Load the one skill for this page
Once you know which source the page is, load its own skill - they hold the control names, the change kinds and the
traps that this file only summarises: `wp-elementor`, `wp-gutenberg`, `wp-divi`, `wp-acf`. For the ORDER of the work
(read, measure, pick a template, fit, place, prove, record) load `build-pipeline`.

## The four editable sources

1. **Elementor** (`_elementor_data` on the page) -> `el.*` kinds. Content is a tree of containers/widgets with ids.
2. **Gutenberg blocks** (post_content has `<!-- wp:... -->` comments) -> `block.*` kinds.
3. **Divi** (post_content has `[et_pb_section]...` shortcodes) -> `divi.*` kinds for the TEXT and LINKS of its existing modules; the template insert for new sections.
4. **Everything else** ("html" builder: classic editor, WPBakery, Beaver Builder, any other shortcode-based page, a block theme with no blocks yet) -> the template library's one-shortcode insert, or a Custom HTML block for library components.

A page also has **ACF fields** (`acfDriven`) independently of which of the three above it is - a theme can print ACF flexible-content layouts AND have Elementor or blocks for the rest of the body.

## Why a template (one shortcode) is the safe default everywhere

`place_component source "template"` always produces exactly one shortcode, e.g. `[ai_testimonials heading="..."][ai_item ...][/ai_testimonials]`. WordPress's `do_shortcode` runs inside `the_content`, so the SAME shortcode renders correctly no matter which builder wrote the surrounding content:
- Elementor: the shortcode is wrapped in one native `container > widget(shortcode)` and inserted with `el.insert` at `root:<index>` - a section of its own, a sibling of the page's other top-level sections. **Never pass a position that is not `root:<n>` or `root:end` for a template; the tool refuses it for exactly this reason** (it is how a template ends up squeezed inside someone else's 2-column "why we're great" container at 50% width, like the testimonials section looked before it was rebuilt properly).
- Blocks / classic / Divi / WPBakery: the shortcode is wrapped in `<!-- wp:shortcode -->...<!-- /wp:shortcode -->` and appended to the end of `post_content` with `block.insert`. `do_blocks` runs on every post's content regardless of whether the post "is" a block post, so this works even on a classic/Divi page. Appending at the end means it lands AFTER the page builder's own sections (e.g. after the last `[et_pb_section]`), never inside one - the only placement that cannot break a Divi/WPBakery row's column widths.
- The template's own CSS (`ai-*` utility classes, scoped, no `!important`, no fixed pixel widths, no site-wide selectors) never touches the theme's or the builder's CSS, so it cannot be "pushed" by a parent's flex/grid rules the way a plain widget can.

This is why `find_components` ranks a template above hand-written markup: it is the only approach proven to be builder-agnostic. Prefer it over the "library" source or hand-built widgets whenever one matches (see the `templates` skill).

## Elementor specifics
- Containers are flexbox. Before placing or resizing anything inside an EXISTING section, read its children's `width` / `flex_direction` (`get_component source "site"` or `read_target`): a column already at `width: 50%` has a sibling at the other 50% - do not add a third thing into it, and never change a template's own wrapper width, only its `fit.max`.
- Responsive variants use the `_tablet` / `_mobile` suffix; set them, don't rely on desktop values shrinking.
- `hide_desktop` / `hide_tablet` / `hide_mobile` for decoration only, never to hide content from a device.

## Gutenberg blocks specifics
- `wp:group` with `layout: {type: "flex"}` or `wp:columns` stack on mobile by default - keep it that way; do not add fixed `width` attributes to columns.
- Synced patterns (`core/block` reusable blocks) edit everywhere they are used: check `usedOn`/`find_components` before changing one, and say so to the person.
- Theme.json presets (`--wp--preset--color--*`, `--wp--preset--font-size--*`) are the site's real design tokens; templates already read them instead of hard-coded colours when the theme is a block theme.

## Divi specifics (`divi.*`)
A Divi page stores its modules as nested shortcodes in `post_content` (`[et_pb_section][et_pb_row][et_pb_column][et_pb_text]...`). Livecrafts addresses one module by its PATH (positions among the `et_pb_*` shortcodes, joined by dots) plus the FIELD to change, as `<path>:<field>`:

- **Text and links of existing modules:** `make_change` kind `divi.text` or `divi.link`, target `<path>:<field>` - e.g. `2.0.0.0:text`, `2.0.0.1:button_text`, `2.0.0.1:button_url`. The write replaces only that field's own bytes, so the surrounding shortcodes stay byte-identical and the nesting cannot break.
- **Get the path from `get_page_map`**, never by guessing or counting shortcodes yourself: every editable Divi field comes back with its exact `kind` and `target` (and `diviOutline` shows the structure). A path that is wrong by one edits the wrong module.
- Field `text` is the module's own content between its tags. A Divi **Text** module is a single rich-text field in Divi's own editor too, so `text` is its whole HTML - read the current value from the map and pass the whole thing back with your edit applied, keeping the markup (`<h1>`, `<p>`) around it. Any other field (`title`, `button_text`, `subhead`, `author`, ...) is a plain shortcode attribute: no HTML, no `"`, no `[` or `]`.
- **Not every module type is covered.** If `make_change` says a module has no such field, trust it and tell the person - do not fall back to rewriting the content.
- **Never** use a raw `post.field` rewrite of the whole `content` to edit one part of a Divi page: that risks corrupting the builder's shortcode nesting (one missing closing tag breaks every section after it). Use `divi.*`, which cannot.
- Divi keeps each module's **design** (colours, padding, fonts) in that module's own shortcode attributes, and those win over a site CSS rule for the same property. `divi.*` changes text and links, not design: for a look change, say that it belongs in the Divi editor, or use `css.rule` only where no module attribute already sets that property.

## WPBakery / other shortcode builders (reported as "html")
These also store the page as shortcodes in `post_content` (`[vc_row][vc_column]...`), but Livecrafts has no structured tree for them (no `vc.*` kind), so:
- **Never** use `make_change` with a raw `post.field` rewrite of the whole `content` to "edit" one part of the page - that risks corrupting the builder's own shortcode nesting. There is no safe partial-edit for their native modules yet; say so to the person and offer the template-insert instead, or tell them to use the builder's editor for an existing module's text.
- **Do** use `place_component source "template"`: it only appends, never rewrites existing shortcodes, so it cannot corrupt the builder's tree. This is the one reliable way to add a new section to such a page today.
- A Custom HTML block (`source "library"`) is also append-only and safe for the same reason; prefer the template when one matches (see `templates` skill) because it is already responsive and fitted.
- If the person asks to edit the TEXT of an existing WPBakery module, say plainly that Livecrafts can only add new sections on this builder today - do not guess at the shortcode syntax.

## ACF-flexible-content custom themes
- `site_profile().acf.flexibleLayouts` lists the theme's real modules (field + layout name + sub-fields) - this is the theme's own "section library"; prefer `acf.rows` (add a row with the matching layout) over a template when one exists, because it stays fully editable in the site's own admin UI exactly like its other sections.
- When the page's template prints ONLY ACF fields (no body content shown), a template/library insert into `post_content` will not appear on the front end at all - `find_components` / `place_component` already warn about this (`acfWarning`). Trust the warning; do not insert anyway "to see what happens".
- Nested repeaters inside a flexible-content row use `acf.value` (not `acf.field`) with the dotted/indexed name `find_components` or `get_page_map` shows.

## Before you say a section is done, regardless of builder
- `place_component`'s `verification` checks (desktop/tablet/mobile: fits, no overlap, nothing covered, tap targets, nothing off-screen) must all pass. A template failing a check is almost always a wrong `position` (not `root:<n>`) or a `fit` value copied from the wrong neighbour - fix that, don't patch around it with extra CSS.
- One `screenshot_page` on mobile of the new section, looked at, not assumed.
- No leftover dead CSS: if an old attempt added `css.rule` / Additional CSS for a section that is being replaced, remove that block too (`revert_change` or a new `css.block` with empty content) - an orphaned `!important` rule with no matching element is exactly the kind of debris `templates`/`section-design` tell you never to create, and it should not survive a rebuild either.
