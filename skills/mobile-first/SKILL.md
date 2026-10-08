---
name: mobile-first
description: "Use before creating or changing any layout: design for a 360px phone first, then widen. Rules for fluid sizing, tap targets, text size, stacking, images and per-builder (Elementor, blocks, ACF/custom theme) responsive settings, plus the test list."
---

# Mobile first

Most visitors arrive on a phone. Design the 360px layout first (one column, thumb-reachable actions), then let it spread out on wider screens. A layout that only works at 1366px is broken.

## Rules
1. **One column by default.** Wider screens add columns; never remove content on mobile.
2. **Fluid, not fixed.** Use %, rem, `min()`, `max()`, `clamp()`, `minmax(min(100%, 18rem), 1fr)`. Never a fixed pixel width above 100px, never `100vw` for a width (it ignores the scrollbar and causes sideways scrolling).
3. **Text:** body at least 16px; headings `clamp(1.6rem, 1.2rem + 2vw, 2.5rem)`; long words and e-mail addresses must wrap (`overflow-wrap: anywhere`).
4. **Touch:** every button and link target at least 44x44px with 8px between targets; no hover-only information.
5. **Spacing scales down:** section padding `clamp(2.5rem, 7vw, 5rem)`, side padding at least 16px.
6. **Images:** `max-width: 100%; height: auto`; give width and height to stop layout jumps; use the Media Library (WebP).
7. **No overlays:** no absolute or fixed positioning in content, no negative margins, no z-index wars. Library components are their own stacking context.
8. **Order:** the important thing first in the source.

## Per builder
- **Elementor:** flexbox containers; `flex_direction` column, rows only from tablet up (`flex_direction_tablet`); set mobile variants (the `_mobile` suffix: font size, padding, margin) with make_change el.setting; use `hide_mobile` only for decoration; use the site's breakpoints (analyze_design).
- **Blocks:** `wp:group` + `wp:columns` (stack on mobile by default); fluid font sizes through theme presets; no fixed widths.
- **ACF / custom themes:** reuse the theme's classes; scoped CSS with a mobile-first `@media (min-width: ...)`; the library's `lc-c` components already stack and wrap by themselves.

## Test before saying done
Check 320 and 390 (phone), 768 (tablet), 1280 (desktop): no sideways scroll, nothing overlaps, text readable, buttons tappable. `place_component` measures this automatically; for other changes run `screenshot_page` with device mobile and tablet.
