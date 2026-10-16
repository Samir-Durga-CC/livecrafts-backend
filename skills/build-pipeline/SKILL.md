---
name: build-pipeline
description: "Use at the START of every request that adds, builds or rebuilds a component, section or page: the fixed order of work - read the page's real source (Elementor / blocks / ACF / Divi), measure what is already there, pick a template and its variant, fit it to the site, place it, prove it with screenshots at three widths, and report what was used. Following it is what makes a section land stable, on-theme and responsive instead of hand-written and fragile."
---

# Building a component, a section or a page

You never hand-write a section. You measure the page, pick a template, adapt it, place it, prove it. Seven steps, in
this order. Skipping a step is how sections end up off-theme, overlapping, or broken on a phone.

## 0. Know what you are standing on (once per request)
`load_skill("page-builders")` to decide which source this page is: Elementor, Gutenberg blocks, ACF flexible content,
Divi or classic/shortcode. Then load that one's skill - `wp-elementor`, `wp-gutenberg`, `wp-acf`, `wp-divi` - because
it decides which change kinds are safe and where a new section may go. Load `templates` and `mobile-first` too.

## 1. Read the page (never guess its structure)
- `site_status` and `site_history` - what is already drafted and what someone changed by hand. Never undo their work.
- `read_notes` for this site and this page - what you learned last time.
- `get_page_map` - the page's sections in order, Elementor outline with data-ids, ACF fields and rows, post fields.
- `read_post` when the page is blocks, for the real block markup.
- `site_profile` - the builder, the global colours and fonts, the forms that exist.
Write down, in your answer, which source the page is and where the new section will go (e.g. "root:3, after the
services section"). If the page map and the screenshot disagree, trust the page map: the picture may be a cached view.

## 2. Measure what is already there (never invent a look)
`analyze_design` on the page, and `inspect_element` on the neighbouring section. You need, as numbers:
- container width (`max`), section padding top/bottom (`py`, and the phone value `py_sm`)
- the brand colour (the site's own button / link colour), surface and alternate surface, text and muted text, border
- corner radius, the heading font and its sizes
These become the template's `fit`. A value you did not measure is a value you must not set: leave it out and the
template inherits the theme. Never introduce a colour or a font the site does not already use.

## 3. Pick the template AND its variant
`find_components` with what is wanted, then `get_component` for the exact attribute names.
Order of preference: a section this page already shows that does the job -> a template -> the component library ->
native widgets or blocks (last resort, and say so).
Every template family has layouts - pick by the job, not by taste:
- `testimonials`: `cards` (three or more quotes) | `centered` (one strong quote) | `split` (one quote with a photo)
- `feature_grid`: `icons` (benefits with icons) | `checklist` (an argument plus a ticked list and a button) | `band` (figures)
- `blog_grid`: `grid` (latest posts) | `list` (long lists, sidebars) | `featured` (one lead article plus the rest)
- `contact_form`: `split` (details beside the form) | `stacked` (form only) | `inline` (call-back strip)
- `slider`: `hero` (full-width message) | `quote` (quotations) | `cards` (many cards, scrolled sideways)
Say in your answer which variant you chose and why.

## 3b. When the theme builds the page itself
Some pages (front pages above all) are built by the theme: `front-page.php` loads a fixed list of template parts and
never prints what the page holds in WordPress. A section saved into that page would never appear.
This is NOT a reason to stop and ask for a developer. `get_page_map` reports `sections.themeParts` (the parts the
theme loaded) and `sections.places`. Place the section at one of those seams:
`place_component position "theme:before:template-parts/why"` (also `theme:after:…`, `theme:start`, `theme:end`).
Livecrafts renders it there itself: no theme file is touched, nothing is lost on a theme update, and it stays a draft
that is checked, previewed, deployed and reverted like any other change. Say it in business words ("it will sit
between the intro and the products"), never in file names.
If `sections.places` is empty, the page has not been opened by an editor yet - `screenshot_page` it once and read the
map again; `theme:start` and `theme:end` always work.

## 4. Fit it, then place it
`place_component` with `source: "template"`, the id, the variant, the content, and `fit` from step 2 (`fit: "auto"`
when the design was measured). Content only - never HTML, never classes, never inline styles. If something is missing
(a real quote, a price, a phone number), ask for it; never invent it, and never leave sample text on a page.
If `place_component` returns an error, report the error. Never work around it by writing the markup by hand.

## 5. Prove it (three widths, nothing hidden)
`screenshot_page` at desktop, tablet and phone, plus the component checks that come back from `place_component`.
- The editor's chrome (the Livecrafts chat, the draft bar, the WordPress admin bar) is NOT part of the page and is
  already removed from what you see. Never design around it, never leave room for it, never call content "hidden
  behind the chat panel". The page starts at the top of the picture.
- Look for: the section wider than the page (sideways scrolling), text touching an edge, cards of different heights,
  a heading colliding with the next section, tap targets under 44px, an image squashed out of ratio.
- A failed check is fixed (a fit value, the content) or reverted with `revert_change`. Then check again.
- If the browser cannot see the page (BOT_CHECK), say so plainly and do not claim it looks right.

## 6. Record it
- `write_notes` for the page: which template and variant now provide this section, and the fit you measured.
- In your answer, name: the template and variant used, where it was placed, what you measured, what the checks said,
  the preview link - and that it is a draft that someone has to deploy.

## Talking to the person while you do all this
They own the site; they do not write code. Never put PHP, file names, shortcodes or CSS in your answer, never ask
which builder or which hook, and never hand them a list of things for a developer to do. Decide with your tools, do
the work, then say what changed, where it sits, and that it is a draft only they can see until they press Deploy.

## Building a whole page
Same steps, once per section. `create_page` first (a draft), then place the sections in the order the recipe gives,
each one its own change so each can be reverted alone. A page is: header -> hero -> what you offer -> proof
(testimonials, figures) -> FAQ -> contact -> footer. Keep one rhythm: the same container width and section padding for
every section, alternating surfaces for separation, one accent colour.
