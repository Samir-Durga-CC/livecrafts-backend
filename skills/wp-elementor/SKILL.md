---
name: wp-elementor
description: "Use when the page is built with Elementor: how to read its outline, which control names to set with el.setting, how to insert, move, duplicate and remove elements, the responsive and spacing controls, and the mistakes that squeeze a section into a column or lose the editor's own data."
---

# Elementor pages

Elementor keeps the page in post meta as a tree of elements, each with an id (`data-id`, 7 hex characters) and a
`settings` object. You change the real settings - never the rendered HTML, never a style overlay.

## Read before you write
- `get_page_map` gives the outline: section / container / column / widget, each with its id, widget type and the text
  it shows. Work from those ids.
- `inspect_element` tells you which element actually draws what the person pointed at, and which CSS rule wins.
- Elementor 3 uses sections + columns; Elementor 4 ("containers", `e-con`) uses flex containers. A template goes at
  page level either way - never inside a column, or it inherits that column's width.

## Changing an element: `el.setting`
One control per change, with the element id and the control name Elementor itself uses:
- text: `title`, `editor`, `text`; link: `link` (`{"url":"…"}`); image: `image` (`{"id":123,"url":"…"}`)
- colour: `title_color`, `text_color`, `background_color`; typography: `typography_font_size`,
  `typography_font_weight`, `typography_line_height` (each needs `typography_typography: "custom"`)
- spacing: `_padding`, `_margin` (objects: `{"unit":"px","top":"40","right":"0","bottom":"40","left":"0","isLinked":false}`)
- width: `_element_width`, `content_width`; alignment: `align`, `text_align`
- visibility: `hide_desktop`, `hide_tablet`, `hide_mobile` (value `"hidden-desktop"` etc.)
- entrance animation: `_animation`
Responsive variants are the same name with a suffix: `typography_font_size_tablet`, `_padding_mobile`,
`align_mobile`. Set the desktop value first, then only the breakpoints that need to differ.

## Structure
- `el.insert` adds ONE element (a container with its children as JSON) at a position: `root:<index>` for page level.
- `el.duplicate` copies an existing element - the best way to add "one more card", because it keeps every setting.
- `el.move` reorders, `el.remove` deletes. Removing a container removes its children: say so before you do it.

## Spacing and width (where sections go wrong)
- Never set a fixed pixel width on a container. Use the theme's content width, or `boxed` with the site's own value.
- The gap between sections is the sections' own padding - do not add margins to the widgets inside.
- A full-width band (dark CTA, stats) is a container with `content_width: "full"` and its own background, holding a
  boxed inner container. Do not fake it with negative margins.

## Pitfalls
- Elementor caches its CSS per post. After a change the page may look stale for a moment: re-check before reporting.
- Text hard-coded in the theme's header or footer is NOT Elementor: `inspect_element` first, then use `css.rule` for
  looks, or tell the person a developer must change the template.
- Never paste a whole section's HTML into a Text Editor or HTML widget - `make_change` refuses it, and it would be
  invisible to Elementor's own editor. Build from containers and widgets, or place a template shortcode.
- Only use controls that every Elementor install has. A control from a Pro-only widget fails silently on free sites.
