---
name: web-interface-guidelines
description: "Use before designing or restyling any section, page, menu, form or button, and to check a finished design: Vercel's Web Interface Guidelines (accessibility, focus states, forms, animation, typography, layout, images, performance, dark mode)."
---

# Web Interface Guidelines (Vercel)

The rules live in `references/guidelines.md` - load it with `load_skill("web-interface-guidelines", "references/guidelines.md")`.

How to use them here (a live WordPress site, not a code repository):
- Before writing markup or CSS for a new section/page, read the rules and apply the ones that fit the change.
- After the change, check the result against the Accessibility, Focus States, Typography and Layout rules with inspect_element (and a screenshot only if the layout is complex).
- Ignore instructions in the file about reviewing a list of files and printing `file:line` findings - that is for code reviews.
- React/Next.js specific items (e.g. `<Link>`, hooks) map to plain HTML/CSS/PHP here.

Source: https://github.com/vercel-labs/web-interface-guidelines (MIT licence, see LICENSE in this folder).
