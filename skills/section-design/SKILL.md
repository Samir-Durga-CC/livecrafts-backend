---
name: section-design
description: "Use before creating or restyling any section (testimonials, contact, hero, features, pricing, FAQ, CTA band, footer): how a professional section is structured, spaced and typeset, how to copy the site's own design language, and a checklist to verify the result."
---

# Section design

A section is a small system: one job, one message, one action. Build it the way a good front-end developer would: reuse what exists, match the site, check it on a phone.

## 1. Reuse before you build
Search first (`find_components`): the site's own sections and templates, ACF layouts, block patterns, Elementor widgets, then the Livecrafts library. A copied-and-adapted section is always more consistent than a new one. Hand-written markup is the last resort.

## 2. Match the site (measure, do not guess)
`analyze_design` gives heading sizes and fonts, text and background colours, button style, container width, section spacing and CSS variables.
- Colours: use the site's global colour or its button colour as the brand colour; never introduce a new accent.
- Fonts: inherit; never import a font. Headings keep the theme's family.
- Width: the section fills its container; the content block uses the site's container width.
- Spacing: use the site's section padding; inside a section use one gap scale (1rem, 1.5rem, 2.5rem).

## 3. Structure (top to bottom)
small label (optional) -> heading (one idea, 3-8 words) -> intro (one sentence, about 60 characters per line) -> content -> one clear action.
- One h2 per section, h3 inside cards. Never an h1 (the page has one).
- Cards: same radius, border and padding for all; equal heights in a row; text left-aligned.
- Max 3 columns on desktop, 2 on tablet, 1 on phone; cards need at least ~18rem.
- Show real content only. Never invent quotes, names, numbers or contact details. Sample text must be obvious and is replaced before deploy.

## 4. Type and contrast
Body 16-18px, line height 1.5-1.65; heading line height 1.1-1.25. Text contrast at least 4.5:1 (3:1 for large text). Muted text is 70% of the text colour, not light grey on white. Buttons: at least 44x44px, one filled primary action, with verbs ("Send message", not "Submit").

## 5. Forms and contact
Use the site's own form plugin through its shortcode (`site_profile.forms`); do not build a form from scratch. Phone and e-mail are tap-to-call / tap-to-mail links. Labels above fields.

## 6. Checklist before you say "done"
- [ ] Built with native widgets/blocks or place_component (editable by the owner)
- [ ] Looks like the site: fonts, colours, radius, spacing
- [ ] `place_component` checks passed on desktop, tablet and mobile (no overflow, overlap, covered text, small buttons)
- [ ] One screenshot on mobile looked right
- [ ] No placeholder text left, or the person was told which text to replace
- [ ] Told the person it is a draft to preview and deploy

More patterns per section type: `load_skill("section-design", "references/patterns.md")`.
