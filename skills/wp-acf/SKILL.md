---
name: wp-acf
description: "Use when the page's content comes from ACF fields (a custom or flexible-content theme): how to find which field draws what, change single fields, work with repeater and flexible-content rows, what a field's type allows, and why editing the rendered HTML instead of the field is always wrong here."
---

# ACF-driven pages

On an ACF theme the page's HTML is the theme's PHP template; the words and pictures come from fields on the post. The
template is the shape, the fields are the content. You change fields. You never change the theme file to change a word.

## Find the field behind what you see
- `get_page_map` lists the post's ACF fields with their names, types and current values, and the rows of every
  repeater / flexible-content field.
- `find_text` finds which field holds a phrase. If the phrase is in no field, it is hard-coded in the theme template
  (see "When it is not a field" below).
- `inspect_element` shows the markup around it, which usually names the field in a class or a wrapper.

## Change a field: `acf.field`
- Give the field name (or its key) and the new value. Sub-fields of a row: `acf.value` with the row path.
- Text and textarea: plain text. WYSIWYG: simple HTML only (`<p>`, `<a>`, `<strong>`, `<ul>`), never a whole section.
- Image / file / gallery: the attachment ID from the Media Library. Upload first
  (`upload_media_from_chat` / `upload_media_from_url`), then use the id it returns - never a bare URL.
- Link: an object (`url`, `title`, `target`). True/false: `1` / `0`. Select / radio: one of the field's own choices;
  any other value is dropped silently by ACF, so read the choices from the page map first.
- Relationship / post object: post IDs. Date: the field's own return format.

## Rows: `acf.rows` (repeater and flexible content)
- Read the existing rows first; keep their field names exactly - a row with the wrong sub-field names renders empty.
- Add, reorder or remove whole rows in one change. For flexible content, every row has a layout name: use one the
  field already defines, never a new one.
- Adding "one more card" = copying the shape of the last row and changing its content. That is the ACF equivalent of
  duplicating an element, and it always matches the design, because the theme draws every row the same way.

## Adding a section to an ACF page
1. If the page has a flexible-content field with a layout that fits (a "sections" field with a testimonials layout),
   add a row. That is the native way and the theme styles it for free.
2. If it does not, place a template shortcode in a WYSIWYG / text field that the theme outputs, or in the post content
   if the template prints it. Say which field you used.
3. Only if neither exists is this a developer job: say so plainly, and offer a styled block via `css.rule` instead of
   inventing markup the theme will not style.

## When it is not a field
Text that `find_text` cannot find in any field is in the theme's PHP. You cannot draft a change to it: theme file
edits go live at once and are off by default. Tell the person a developer must change the template, and offer what you
can do instead (a style rule, or moving that text into a field - also a developer job).

## Before you say it is done
Re-read the field you changed (it is the source of truth), then look at the page: an ACF value that renders nowhere
means the wrong field, and an empty row means wrong sub-field names.
