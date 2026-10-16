---
name: wp-gutenberg
description: "Use when the page is made of Gutenberg blocks: how to read the block markup, change text, links and images in place, insert or replace whole sections with valid core-block markup, and keep the block comments intact so the editor does not report 'this block contains unexpected or invalid content'."
---

# Gutenberg (block) pages

A block page is HTML with block comments around it: `<!-- wp:paragraph -->…<!-- /wp:paragraph -->`. Those comments
and the attributes in them ARE the block. Break them and WordPress shows "this block contains unexpected or invalid
content" and the person loses the visual editor for that block.

## Read first
`read_post` gives the real markup. `get_page_map` gives the outline. Work on the smallest block that holds what you
want to change.

## Small changes in place
- `block.text` - the words inside one block. `block.link` - one link's address and label. `block.image` - swap an
  image (attachment id; upload it first).
- `block.class` - add a class the theme already defines. Never add a class that nothing styles.
These keep the block's attributes and comments exactly as they were - always prefer them over replacing markup.

## Sections: `block.insert` / `block.replace`
The markup must be valid core-block markup, with every attribute the editor writes itself. A group section looks like:

    <!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem"}}},"layout":{"type":"constrained"}} -->
    <div class="wp-block-group alignfull" style="padding-top:4rem;padding-bottom:4rem"> … </div>
    <!-- /wp:group -->

Rules that keep it valid:
- The class list and the inline styles must match the JSON attributes exactly - the editor compares them.
- Columns: `wp:columns` with `wp:column` children; give each column its `width` attribute or none at all.
- Use the theme's own palette and spacing presets (`var:preset|color|primary`, `var:preset|spacing|50`) instead of raw
  values: `site_profile` lists them. A raw hex colour will not follow the theme.
- `align":"full"` only works in a theme that supports it; check `site_profile` before using it.
- Never invent a block name, and never use a block from a plugin that may not be installed. Core blocks only:
  group, columns, column, heading, paragraph, image, buttons, button, list, separator, spacer, cover, media-text.

## Structure
`block.move`, `block.duplicate`, `block.remove` reorder, copy or delete a whole block with its children. Duplicating
an existing card and changing its text is safer than writing a new one, and it keeps the design.

## Patterns and templates
If the site registers block patterns, `find_components` shows them: a pattern is already styled for this theme, so it
beats hand-written markup. A template shortcode goes in a `wp:shortcode` block and works everywhere.

## Before you say it is done
Read the post back and check the block comments are balanced (every `<!-- wp:x -->` has its `<!-- /wp:x -->`), then
look at the page at phone width: a `wp:columns` row does not stack unless the theme says so - set
`{"isStackedOnMobile":true}` (the default) and never force a fixed column width in pixels.
