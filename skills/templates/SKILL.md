---
name: templates
description: "Use whenever a section, header, footer, hero, pricing, FAQ, CTA, cards or blog grid is needed: the site's template library. Look at how the page's own sections are sized first, place a template with only the content, let the fit adapt it, then prove it is used."
---

# Template library

The site ships ready, responsive, accessible sections as templates (hero, hero_centered, cta, feature_grid, steps, stats, logo_cloud, testimonials, team, pricing, faq, card, blog_grid, newsletter, contact_form, header, footer, sidebar, breadcrumbs, pagination, announcement, button, badge, alert, empty_state). You never write their HTML or CSS: you give them content and a fit. A template is ONE shortcode, so it works the same in Elementor, blocks, Divi, WPBakery, classic and ACF pages.

## When to use a template
"Add / create / insert / put a testimonial, hero, pricing ..." means PLACE A TEMPLATE. Do not restore an older version of the section with revert_change unless the person says undo / revert / restore. A section that was removed or sits only in the change history is not "a section the site already has". Never write the section's HTML yourself, and never paste it into an Elementor text-editor / HTML widget (make_change refuses it).

## Workflow (in this order)
1. **Look at the page first.** `analyze_design` on the page the section goes on. Read `layout`: the width, height, padding and content width of the page's own sections, plus button colour, radius, page background and text colour. A new section must sit in the same rhythm: same content width, same vertical padding, same corners. Do not guess these numbers.
2. **Find.** `find_components` with what is wanted. A section the site really shows now (on this page or another) that the person pointed at wins; a template is next. History does not count. `template_usage` shows if a template is already on the page (do not add a second hero).
3. **Read the template.** `get_component source "template"`: attribute names, the row fields of list templates, the example. Use only those names.
4. **Place.** `place_component source "template" id ... attrs {...} items [...]`. Leave `fit` at `auto`: it measures the same numbers as step 1 and applies them (`max` content width, `py` / `py_sm` padding, `radius`, `brand`, `surface`, `ink`). Override only when the person asks (`fit {max: "960px"}`) or when the measurement is clearly wrong; explicit values win.
5. **Adjust, do not rebuild.** To change a placed template, change its shortcode text with the same tools you use for text; never copy its HTML out. Wrong spacing or width = change a fit value. Wrong look that no fit value fixes = say so; do not hand-write a replacement section.
6. **Prove it.** The `place_component` result has `usedTemplate`: the shortcode, the fit that was applied and why (`fitBasis`), and `proof`. The page check fails with "not on the draft page" if the template did not render. Tell the person the `seeIt` link: as an editor it outlines and labels every template section.

## Where a template goes
A template is a section of its own at page level (`position` "root:<index>"): never inside another section. Testimonials after the products / services / about section, FAQ before the contact form, contact form last above the footer. Read `get_page_map` for the order. A contact form without `action` uses the plugin's handler (e-mail to the admin address).

## Content rules
- Plain text only; no HTML, no markdown. Quotes, brackets and line breaks are cleaned for you.
- Never invent customer quotes, prices, names, numbers, addresses or phone numbers. Use what the person gave or what the page already says; otherwise ask. Empty content is flagged as placeholders.
- Links are real addresses on the site. Images are full URLs from the Media Library (upload first).
- Buttons and heading text: verbs, 3-8 words. One h1 per page: only the hero templates carry it, so do not add a hero to a page that has an h1.
- Lists: 3 or 6 rows for grids, 4-8 for FAQ. At most 24.

## Fit values (CSS lengths and colours only)
`max` content width (1140px) | `py` section padding on desktop (96px) | `py_sm` on mobile | `radius` | `brand` | `surface` page background | `surface_alt` alternate band | `ink` text | `muted` secondary text | `line` borders | `font`.
Dark site: pass `surface`, `ink` (and `line`); every template follows. Block themes: the templates already read the theme palette (`--wp--preset--color--base / contrast / primary`).

## When the browser cannot see the site (BOT_CHECK)
The checks did not run. Say so; never claim the section fits or looks right. Give the seeIt link, ask the person to look at desktop and phone, and tell them once to allow the backend (LC_BROWSER_HEADERS) or to open the Livecrafts widget on the page.

## Checks before you say "done"
- [ ] analyze_design was read before placing (width and padding match the neighbours)
- [ ] `usedTemplate.proof` says the marker is on the page, and the component checks pass on desktop, tablet and mobile
- [ ] One mobile screenshot of the section looked right
- [ ] No sample or invented text; the person knows it is a draft to preview and deploy
