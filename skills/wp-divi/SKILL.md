---
name: wp-divi
description: "Use when the page is built with Divi (et_pb_ shortcodes or Divi 5 blocks): what can be changed safely (text and links in place), what must never be rewritten, how to add a section without touching the builder's own data, and the compatibility traps that take a Divi front end down."
---

# Divi pages

Divi stores the page as its own nested shortcodes (`[et_pb_section][et_pb_row][et_pb_column][et_pb_text]…`), or, in
Divi 5, as its own block format. Both are the builder's private data: it re-serialises them, keeps ids in sync and
caches CSS per module. Rewriting that data by hand is how a page loses its layout - or the front end.

## What is safe
- `divi.text` - the words inside one module, in place. The shortcode, its attributes, its ids are untouched.
- `divi.link` - one link's address and label.
- `css.rule` - how something looks, scoped to the page (`body.page-id-12 .et_pb_text h2`). Use `inspect_element`
  first and write a selector more specific than the rule that currently wins. Never `!important`.
That covers almost every request: change a heading, a paragraph, a button's text or address, a colour, a size.

## What you must not do
- Never rebuild a page's Divi content, and never paste a block of `[et_pb_*]` shortcodes you wrote yourself: the
  attribute set is large, version-specific and partly generated (module ids, `_builder_version`, global colours). A
  hand-written module can take the front end down, and the visual builder may refuse to open the page.
- Never put HTML for a whole section into a Text module.
- Never change module ids or `_builder_version`.

## Adding a section
1. Prefer a template shortcode: `place_component` puts ONE shortcode into a Code module / a Text module at page level.
   Divi renders it as its own band, it is responsive by itself, and the builder's data stays untouched.
2. Or duplicate what already exists: if the page has a row that does the job, duplicating it in the builder keeps every
   Divi setting. Tell the person when that is the better route - some structural edits belong in the Divi editor.
3. Where it goes: page level, between sections - never inside an existing `et_pb_column`, or it inherits that
   column's width and padding.

## Compatibility
- Divi 5 has a "backwards compatibility mode". Which mode the site runs in decides the storage format: read
  `site_profile` / `get_page_map` and do not assume. A change written in the other format is not shown and can break
  the page.
- Divi's own CSS is heavy and specific. If a style rule has no effect, raise specificity with the page's body class
  and the module's own class instead of reaching for `!important`.
- Divi caches module CSS. After a change, re-check the page before reporting; a stale look is not a failed change.

## Before you say it is done
Open the page in the draft view and look at it at desktop, tablet and phone widths. Confirm the Divi section above and
below the change still render, and that the builder's own layout did not shift - that is the signal that the data is
still intact.
