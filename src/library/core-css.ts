/**
 * The core stylesheet of the component library. Every library component carries the class `lc-c` and relies on this
 * file, which is written once per site as the Additional CSS block "lc-core". It is what keeps a component from
 * breaking the page or being broken by the theme:
 *
 *   OVERLAY      nothing in a component is absolutely positioned or fixed; the component is its own stacking
 *                context (isolation) so no z-index of the theme or of the component leaks out or in; it clears floats
 *                and always takes its own row.
 *   OVERFLOW     width is 100% of whatever holds it - never vw, never a fixed pixel width. Grid tracks are
 *                minmax(min(100%, X), 1fr) so a track can never be wider than its container; grid/flex children get
 *                min-width:0; long words and e-mail addresses wrap; images never exceed their box.
 *   RESPONSIVE   the layout reacts to the SPACE the component has (auto-fit grids), not to the screen, so it is right
 *                in a full-width section, a boxed column or a sidebar, on 320px up to wide monitors. No breakpoints
 *                needed, which also means none can be wrong for this theme.
 *   THEME BLEED  headings, paragraphs, lists, quotes, buttons and form fields are reset by CLASS with a doubled class
 *                (.lc-c.lc-c) so a theme rule such as `.entry-content h2` or Elementor's widget margins cannot win,
 *                and no !important is needed.
 *   LEGIBLE      colours come from the surrounding text (currentColor) unless the site's brand colour is known, so the
 *                component is readable on light and dark sections alike.
 *   TOUCH/A11Y   44px targets, visible focus, 16px+ body text, reduced layout shift (images keep their ratio).
 *
 * Rules: no !important, no position:absolute|fixed, no vw/vh widths, no negative margins (lint.ts enforces this).
 */
const R = ".lc-c.lc-c";

export const CORE_CSS_ID = "lc-core";

export const CORE_CSS = `/* Livecrafts component library - core. Shared by every library component (class "lc-c"). */
.lc-c, .lc-c *, .lc-c *::before, .lc-c *::after { box-sizing: border-box; }

.lc-c {
  --lc-radius: 0.875rem;
  --lc-gap: clamp(1rem, 2.4vw, 1.75rem);
  --lc-max: 72rem;
  --lc-border: color-mix(in srgb, currentColor 18%, transparent);
  --lc-surface: color-mix(in srgb, currentColor 5%, transparent);
  --lc-muted: color-mix(in srgb, currentColor 70%, transparent);

  position: relative;
  isolation: isolate;
  z-index: 0;
  display: block;
  float: none;
  clear: both;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin: 0;
  padding: clamp(2.5rem, 7vw, 5rem) clamp(1rem, 4vw, 2rem);
  color: inherit;
  font-family: inherit;
  font-size: 1rem;
  line-height: 1.55;
  text-align: start;
  overflow-wrap: break-word;
}

/* ---- structure ---- */
${R} .lc-inner {
  display: flex;
  flex-direction: column;
  gap: clamp(1.5rem, 4vw, 2.5rem);
  width: 100%;
  max-width: var(--lc-max);
  min-width: 0;
  margin: 0 auto;
  padding: 0;
}
${R} .lc-header {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-width: 42rem;
  min-width: 0;
  margin: 0;
  padding: 0;
}
${R} .lc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
  gap: var(--lc-gap);
  align-items: stretch;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
${R} .lc-grid.lc-grid--pairs { grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr)); }
${R} .lc-grid > * { min-width: 0; max-width: 100%; margin: 0; }
/* block themes put a margin between siblings (is-layout-flow) and Elementor puts one under each widget: the component spaces itself with gap */
${R} :is(.lc-inner, .lc-header, .lc-card, .lc-person, .lc-person-text) > * { margin: 0; }
${R} .lc-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: clamp(1.25rem, 3vw, 1.75rem);
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius);
  background: var(--lc-surface);
  color: inherit;
}

/* ---- text: reset by class, so the theme's heading / paragraph / list rules cannot reach in ---- */
${R} .lc-eyebrow,
${R} .lc-eyebrow :is(p, span, .elementor-heading-title) {
  margin: 0;
  padding: 0;
  color: var(--lc-muted);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}
${R} .lc-title,
${R} .lc-title :is(h1, h2, h3, h4, .elementor-heading-title) {
  margin: 0;
  padding: 0;
  font-size: clamp(1.625rem, 1.25rem + 1.8vw, 2.5rem);
  line-height: 1.15;
  overflow-wrap: anywhere;
  hyphens: auto;
}
${R} .lc-intro,
${R} .lc-intro p {
  margin: 0;
  padding: 0;
  color: var(--lc-muted);
  font-size: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
  line-height: 1.6;
  max-width: 60ch;
  overflow-wrap: anywhere;
}
${R} .lc-quote-text,
${R} .lc-quote-text p {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 1.0625rem;
  font-style: normal;
  line-height: 1.6;
  quotes: none;
  overflow-wrap: anywhere;
}
${R} .lc-person { display: flex; flex-direction: row; align-items: center; gap: 0.75rem; margin: 0; padding: 0; min-width: 0; }
${R} .lc-card > .lc-person { margin-top: auto; }
${R} .lc-person-text { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; margin: 0; padding: 0; }
${R} .lc-name,
${R} .lc-name :is(p, span, strong, .elementor-heading-title) {
  margin: 0;
  padding: 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
${R} .lc-role,
${R} .lc-role :is(p, span, .elementor-heading-title) {
  margin: 0;
  padding: 0;
  color: var(--lc-muted);
  font-size: 0.9375rem;
  font-weight: 400;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
${R} .lc-avatar { flex: none; display: block; width: 3rem; height: 3rem; min-width: 3rem; max-width: 3rem; margin: 0; padding: 0; border-radius: 50%; object-fit: cover; }
${R} .lc-avatar .elementor-widget-container { width: 100%; height: 100%; margin: 0; padding: 0; }
${R} .lc-avatar :is(img) { display: block; width: 100%; max-width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }

/* ---- links and buttons ---- */
${R} a:not(.lc-btn):not(.elementor-button):not(.wp-block-button__link) {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 0.2em;
  overflow-wrap: anywhere;
}
${R} :is(a.lc-btn, .lc-btn-wrap .elementor-button, .lc-btn-wrap .wp-block-button__link, .lc-form :is(input[type="submit"], button[type="submit"], button.wpforms-submit)) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.75rem;
  min-height: 2.75rem;
  max-width: 100%;
  margin: 0;
  padding: 0.625rem 1.25rem;
  border: 2px solid var(--lc-brand, currentColor);
  border-radius: var(--lc-radius);
  background: var(--lc-brand, transparent);
  color: var(--lc-on-brand, currentColor);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.2;
  text-align: center;
  text-decoration: none;
  text-transform: none;
  letter-spacing: normal;
  box-shadow: none;
  cursor: pointer;
  overflow-wrap: anywhere;
}
${R} :is(a.lc-btn, .lc-btn-wrap .elementor-button, .lc-btn-wrap .wp-block-button__link, .lc-form :is(input[type="submit"], button[type="submit"])):hover { opacity: 0.86; }
${R} :is(a, button, input, textarea, select):focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
${R} .lc-btn-wrap { margin: 0; padding: 0; width: auto; max-width: 100%; }

/* ---- media ---- */
${R} img { max-width: 100%; height: auto; }

/* ---- lists ---- */
${R} .lc-details { display: grid; gap: 1rem; margin: 0; padding: 0; list-style: none; }
${R} .lc-details li { display: grid; gap: 0.125rem; margin: 0; padding: 0; min-width: 0; list-style: none; }
${R} .lc-label { color: var(--lc-muted); font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
${R} .lc-value { font-size: 1.0625rem; overflow-wrap: anywhere; }

/* ---- forms from any form plugin (Contact Form 7, WPForms, Fluent Forms ...) ---- */
${R} .lc-form { width: 100%; min-width: 0; margin: 0; padding: 0; }
${R} .lc-form form, ${R} .lc-form .wpcf7, ${R} .lc-form .wpforms-container, ${R} .lc-form .frm-fluent-form { width: 100%; max-width: 100%; margin: 0; padding: 0; }
${R} .lc-form :is(p, .wpforms-field, .ff-el-group) { margin: 0 0 1rem; padding: 0; }
${R} .lc-form label { display: block; margin: 0 0 0.375rem; font-size: 0.9375rem; font-weight: 500; }
${R} .lc-form .wpcf7-form-control-wrap { display: block; width: 100%; }
${R} .lc-form :is(input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="file"]), textarea, select) {
  display: block;
  width: 100%;
  max-width: 100%;
  min-height: 2.75rem;
  margin: 0;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--lc-border);
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.4;
}
${R} .lc-form textarea { min-height: 8rem; resize: vertical; }
`;
