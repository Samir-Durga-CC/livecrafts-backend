/**
 * The Section Gallery's library: ready-made sections a person adds to a page with one click (no AI, no tokens).
 *
 * WHY THIS SHAPE
 *   - One source per section: portable HTML + one scoped CSS block. The same markup goes into every builder
 *     (an Elementor container, a Gutenberg group, a Divi section, a classic page), and keeps rendering if the
 *     Livecrafts plugin is turned off, because the CSS lives in Additional CSS and the HTML in the page itself.
 *   - One design system (lcs-core): one spacing scale, one type scale, one radius, one button. Every section looks
 *     like part of the same family, and none of them looks like a stock template.
 *   - The site's own look, without measuring anything: the brand colour comes from Elementor's global accent or the
 *     block theme's primary colour (the --lc-brand token wins when the site has one), headings and text inherit the
 *     theme's fonts. Sizes follow the section's own width (container queries), so a section is right in a narrow
 *     content column and full width alike.
 *   - Markup a builder accepts as it is: no inline styles, scripts, SVG or h1 (the page has one); single line, so
 *     Elementor's text editor does not add stray paragraphs; plain classes the Livecrafts editor can find.
 *
 * Adding a section: write one entry in SECTIONS. The text in it is sample wording the person replaces; it reads as a
 * real business would write it, never "lorem ipsum".
 */

export type SectionCategory = "hero" | "features" | "cta";

export interface SectionDef {
  id: string;
  category: SectionCategory;
  name: string;
  /** One line under the name in the gallery. */
  summary: string;
  html: string;
  css: string;
}

export const CATEGORIES: Array<{ id: SectionCategory; name: string }> = [
  { id: "hero", name: "Hero" },
  { id: "features", name: "Features" },
  { id: "cta", name: "Call to action" },
];

/** Single line, no whitespace between tags (Elementor's text editor turns line breaks into paragraphs). */
const tidy = (s: string) => s.replace(/\n\s*/g, "").replace(/>\s+</g, "><").trim();

export const CORE_ID = "lcs-core";

/** The design system every section shares. Scoped to .lcs, so it never touches the rest of the page. */
export const CORE_CSS = `/* Livecrafts sections: design system */
.lcs {
  /* No Elementor --e-global-color-accent here: on a kit nobody customised it is Elementor's default green, and a
     section that falls back to it wears a colour the site never uses. The brand comes from --lc-brand, which the
     backend writes from the site's own buttons. */
  --lcs-brand: var(--lc-brand, var(--wp--preset--color--primary, #2f5bea));
  --lcs-on-brand: var(--lc-on-brand, #ffffff);
  --lcs-radius: var(--lc-radius, 14px);
  /*
   * The page's own ink and paper. These used to be inherit and currentColor, so a heading, its lead paragraph
   * and a card border were all the one colour the page happened to be using - on a site whose body text is grey,
   * every section came out flat and faded. Measured values win (--lc-*, chosen in siteLook by contrast against the
   * paper, never by the name a kit gives a colour), then a block theme's own contrast colour, then a near-black.
   * Elementor's --e-global-color-text is deliberately NOT in this chain: on a default kit it is #7A7A7A, a body
   * grey, and using it for headings is the faded look this whole set exists to end.
   */
  --lcs-ink: var(--lc-ink, var(--wp--preset--color--contrast, #14171f));
  --lcs-surface: var(--lc-surface, var(--wp--preset--color--base, #ffffff));
  --lcs-muted: var(--lc-muted, color-mix(in srgb, var(--lcs-ink) 66%, var(--lcs-surface)));
  --lcs-tint: color-mix(in srgb, var(--lcs-brand) 9%, transparent);
  --lcs-tint-2: color-mix(in srgb, var(--lcs-brand) 18%, transparent);
  --lcs-line: var(--lc-line, color-mix(in srgb, var(--lcs-ink) 14%, var(--lcs-surface)));
  container-type: inline-size;
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding-block: clamp(56px, 7cqi, 112px);
  line-height: 1.55;
  color: var(--lcs-ink);
}
/* A band on the brand colour is its own colour context: flip the tokens once here and everything inside follows. */
.lcs .lcs-band {
  --lcs-ink: var(--lcs-on-brand);
  --lcs-muted: color-mix(in srgb, var(--lcs-on-brand) 82%, transparent);
  --lcs-line: color-mix(in srgb, var(--lcs-on-brand) 38%, transparent);
  --lcs-surface: var(--lcs-brand);
}
.lcs *, .lcs *::before, .lcs *::after { box-sizing: border-box; }
.lcs h2, .lcs h3, .lcs p, .lcs ul, .lcs li, .lcs figure { margin: 0; padding: 0; }
.lcs p:empty { display: none; }
.lcs ul { list-style: none; }
.lcs img { display: block; max-width: 100%; height: auto; }
/* The content box. Zero specificity on purpose: when the section also wears the theme's own container class
   (.wrap, .container...), the theme's rules win at every breakpoint. Otherwise the measured width is used
   (--lc-container / --lc-gutter, written per site), else 1160px. */
:where(.lcs .lcs-in) { max-width: var(--lc-container, 1160px); margin-inline: auto; padding-inline: var(--lc-gutter, clamp(20px, 4cqi, 40px)); }
.lcs .lcs-eyebrow { display: inline-block; font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--lcs-brand); }
.lcs .lcs-h { font-size: clamp(34px, 5.2cqi, 60px); line-height: 1.06; letter-spacing: -0.02em; font-weight: 700; text-wrap: balance; color: var(--lcs-ink); }
.lcs .lcs-h2 { font-size: clamp(28px, 3.6cqi, 42px); line-height: 1.12; letter-spacing: -0.015em; font-weight: 700; text-wrap: balance; color: var(--lcs-ink); }
.lcs .lcs-h3 { font-size: 19px; line-height: 1.3; font-weight: 650; color: var(--lcs-ink); }
.lcs .lcs-lead { font-size: clamp(17px, 1.7cqi, 20px); color: var(--lcs-muted); max-width: 40em; }
.lcs .lcs-text { font-size: 16px; color: var(--lcs-muted); }
.lcs .lcs-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.lcs .lcs-actions p { display: contents; }
.lcs a.lcs-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 12px 22px; border-radius: calc(var(--lcs-radius) * .7); font-size: 16px; font-weight: 600; line-height: 1.2; text-decoration: none; background: var(--lcs-brand); color: var(--lcs-on-brand); border: 1px solid var(--lcs-brand); transition: transform .15s ease, box-shadow .15s ease; }
.lcs a.lcs-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px -8px var(--lcs-brand); }
.lcs a.lcs-btn:focus-visible { outline: 3px solid var(--lcs-tint-2); outline-offset: 2px; }
.lcs a.lcs-btn-ghost { background: transparent; color: inherit; border-color: var(--lcs-line); }
.lcs a.lcs-btn-ghost:hover { box-shadow: none; border-color: currentColor; }
.lcs .lcs-media { position: relative; aspect-ratio: 4 / 3; border-radius: var(--lcs-radius); background:
  radial-gradient(120% 90% at 85% 10%, var(--lcs-tint-2), transparent 60%),
  linear-gradient(135deg, var(--lcs-tint), transparent),
  repeating-linear-gradient(0deg, var(--lcs-line) 0 1px, transparent 1px 28px),
  repeating-linear-gradient(90deg, var(--lcs-line) 0 1px, transparent 1px 28px); border: 1px solid var(--lcs-line); }
.lcs .lcs-media img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.lcs .lcs-ico { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--lcs-tint); color: var(--lcs-brand); font-size: 18px; font-weight: 700; line-height: 1; }
.lcs .lcs-check { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; align-items: start; }
.lcs .lcs-check::before { content: ""; justify-self: center; width: 7px; height: 13px; margin-top: 3px; border: solid var(--lcs-brand); border-width: 0 2.5px 2.5px 0; transform: rotate(45deg); }
@media (prefers-reduced-motion: reduce) { .lcs a.lcs-btn { transition: none; } .lcs a.lcs-btn:hover { transform: none; } }
`;

export const SECTIONS: SectionDef[] = [
  // ---------------------------------------------------------------- hero
  {
    id: "hero-split",
    category: "hero",
    name: "Hero, split",
    summary: "Message and buttons beside a large picture",
    html: tidy(`
      <section class="lcs lcs-hero-split" data-lcs="hero-split">
        <div class="lcs-in lcs-grid">
          <div class="lcs-copy">
            <span class="lcs-eyebrow">New for this season</span>
            <h2 class="lcs-h">Everything your customers need, in one place</h2>
            <p class="lcs-lead">Tell visitors in one sentence what you do and why it matters to them. Keep it short enough to read in five seconds.</p>
            <div class="lcs-actions"><a class="lcs-btn" href="#contact">Get started</a><a class="lcs-btn lcs-btn-ghost" href="#about">See how it works</a></div>
            <p class="lcs-proof">Trusted by 1,200+ businesses</p>
          </div>
          <figure class="lcs-media" aria-hidden="true"></figure>
        </div>
      </section>`),
    css: `/* Hero, split */
.lcs-hero-split .lcs-grid { display: grid; gap: clamp(32px, 5cqi, 64px); align-items: center; }
.lcs-hero-split .lcs-copy { display: grid; gap: 20px; justify-items: start; }
.lcs-hero-split .lcs-proof { font-size: 14px; color: var(--lcs-muted); }
.lcs-hero-split .lcs-media { aspect-ratio: 5 / 4; }
@container (min-width: 820px) { .lcs-hero-split .lcs-grid { grid-template-columns: 1.05fr 1fr; } }
`,
  },
  {
    id: "hero-centered",
    category: "hero",
    name: "Hero, centred",
    summary: "Centred message with a wide picture underneath",
    html: tidy(`
      <section class="lcs lcs-hero-centered" data-lcs="hero-centered">
        <div class="lcs-in lcs-stack">
          <span class="lcs-pill">Now booking for next month</span>
          <h2 class="lcs-h">The simplest way to get it done right</h2>
          <p class="lcs-lead">One clear promise for the people you serve. Say what they get, how quickly, and what makes you the safe choice.</p>
          <div class="lcs-actions"><a class="lcs-btn" href="#contact">Book a call</a><a class="lcs-btn lcs-btn-ghost" href="#work">View our work</a></div>
          <figure class="lcs-media lcs-wide" aria-hidden="true"></figure>
        </div>
      </section>`),
    css: `/* Hero, centred */
.lcs-hero-centered .lcs-stack { display: grid; gap: 22px; justify-items: center; text-align: center; }
.lcs-hero-centered .lcs-lead { margin-inline: auto; }
.lcs-hero-centered .lcs-actions { justify-content: center; }
.lcs-hero-centered .lcs-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; background: var(--lcs-tint); color: var(--lcs-brand); }
.lcs-hero-centered .lcs-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--lcs-brand); }
.lcs-hero-centered .lcs-wide { width: 100%; aspect-ratio: 16 / 7; margin-top: clamp(16px, 3cqi, 40px); }
`,
  },
  {
    id: "hero-band",
    category: "hero",
    name: "Hero, brand band",
    summary: "Bold band in your brand colour with three key figures",
    html: tidy(`
      <section class="lcs lcs-hero-band" data-lcs="hero-band">
        <div class="lcs-in">
          <div class="lcs-band">
            <div class="lcs-copy">
              <span class="lcs-eyebrow">Since 2009</span>
              <h2 class="lcs-h">Built for the work that matters most to you</h2>
              <p class="lcs-lead">A short promise in your own words: who you help, and the result they can count on.</p>
              <div class="lcs-actions"><a class="lcs-btn" href="#contact">Talk to us</a></div>
            </div>
            <ul class="lcs-figures">
              <li><b>15+</b><span>years of experience</span></li>
              <li><b>4.9/5</b><span>average customer rating</span></li>
              <li><b>24h</b><span>reply time, every time</span></li>
            </ul>
          </div>
        </div>
      </section>`),
    css: `/* Hero, brand band */
.lcs-hero-band .lcs-band { display: grid; gap: clamp(28px, 4cqi, 56px); padding: clamp(28px, 6cqi, 72px); border-radius: calc(var(--lcs-radius) * 1.4); background: var(--lcs-brand); color: var(--lcs-on-brand); }
.lcs-hero-band .lcs-copy { display: grid; gap: 18px; justify-items: start; }
.lcs-hero-band .lcs-eyebrow { color: inherit; opacity: .8; }
.lcs-hero-band .lcs-lead { color: inherit; opacity: .86; }
.lcs-hero-band a.lcs-btn { background: var(--lcs-on-brand); color: var(--lcs-brand); border-color: var(--lcs-on-brand); }
.lcs-hero-band .lcs-figures { display: grid; gap: 12px; align-content: center; }
.lcs-hero-band .lcs-figures li { display: grid; gap: 2px; padding: 16px 20px; border-radius: var(--lcs-radius); background: color-mix(in srgb, var(--lcs-on-brand) 12%, transparent); }
.lcs-hero-band .lcs-figures b { font-size: 28px; line-height: 1.1; }
.lcs-hero-band .lcs-figures span { font-size: 14px; opacity: .82; }
@container (min-width: 820px) { .lcs-hero-band .lcs-band { grid-template-columns: 1.5fr 1fr; } }
`,
  },

  // ---------------------------------------------------------------- features
  {
    id: "features-grid",
    category: "features",
    name: "Features, grid",
    summary: "Six benefits in a tidy grid with icons",
    html: tidy(`
      <section class="lcs lcs-features-grid" data-lcs="features-grid">
        <div class="lcs-in">
          <div class="lcs-head">
            <span class="lcs-eyebrow">Why choose us</span>
            <h2 class="lcs-h2">Everything you need, nothing you do not</h2>
            <p class="lcs-lead">A sentence that sums up the benefits below, written for the person reading it.</p>
          </div>
          <ul class="lcs-cards">
            <li><span class="lcs-ico">1</span><h3 class="lcs-h3">Fast to start</h3><p class="lcs-text">Up and running in days, not months, with a clear plan from day one.</p></li>
            <li><span class="lcs-ico">2</span><h3 class="lcs-h3">Clear pricing</h3><p class="lcs-text">One price agreed up front, with no surprises on the final invoice.</p></li>
            <li><span class="lcs-ico">3</span><h3 class="lcs-h3">Real people</h3><p class="lcs-text">Talk to the same small team every time you get in touch.</p></li>
            <li><span class="lcs-ico">4</span><h3 class="lcs-h3">Built to last</h3><p class="lcs-text">Quality materials and careful work that holds up for years.</p></li>
            <li><span class="lcs-ico">5</span><h3 class="lcs-h3">Fully insured</h3><p class="lcs-text">Every job is covered, so you never carry the risk yourself.</p></li>
            <li><span class="lcs-ico">6</span><h3 class="lcs-h3">Guaranteed</h3><p class="lcs-text">If something is not right, we come back and fix it, free.</p></li>
          </ul>
        </div>
      </section>`),
    css: `/* Features, grid */
.lcs-features-grid .lcs-head { display: grid; gap: 14px; justify-items: center; text-align: center; margin-bottom: clamp(32px, 5cqi, 56px); }
.lcs-features-grid .lcs-head .lcs-lead { margin-inline: auto; }
.lcs-features-grid .lcs-cards { display: grid; gap: 16px; }
.lcs-features-grid .lcs-cards li { display: grid; gap: 10px; align-content: start; padding: 24px; background: var(--lcs-surface); border: 1px solid var(--lcs-line); border-radius: var(--lcs-radius); }
.lcs-features-grid .lcs-ico { margin-bottom: 6px; }
@container (min-width: 560px) { .lcs-features-grid .lcs-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 900px) { .lcs-features-grid .lcs-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
`,
  },
  {
    id: "features-split",
    category: "features",
    name: "Features, picture and checklist",
    summary: "A picture beside a heading and four ticked benefits",
    html: tidy(`
      <section class="lcs lcs-features-split" data-lcs="features-split">
        <div class="lcs-in lcs-grid">
          <figure class="lcs-media" aria-hidden="true"></figure>
          <div class="lcs-copy">
            <span class="lcs-eyebrow">How we work</span>
            <h2 class="lcs-h2">A better experience from the first call to the final result</h2>
            <p class="lcs-lead">Explain in two sentences what working with you feels like, and why people come back.</p>
            <ul class="lcs-list">
              <li class="lcs-check">A free, no-pressure first conversation</li>
              <li class="lcs-check">A written plan and price before any work starts</li>
              <li class="lcs-check">Updates at every step, in plain language</li>
              <li class="lcs-check">Support that continues after the job is done</li>
            </ul>
            <div class="lcs-actions"><a class="lcs-btn" href="#contact">Start your project</a></div>
          </div>
        </div>
      </section>`),
    css: `/* Features, picture and checklist */
.lcs-features-split .lcs-grid { display: grid; gap: clamp(32px, 5cqi, 72px); align-items: center; }
.lcs-features-split .lcs-copy { display: grid; gap: 20px; justify-items: start; }
.lcs-features-split .lcs-list { display: grid; gap: 12px; font-size: 16px; }
.lcs-features-split .lcs-media { aspect-ratio: 1 / 1; }
@container (min-width: 820px) { .lcs-features-split .lcs-grid { grid-template-columns: 1fr 1.1fr; } }
`,
  },
  {
    id: "features-bento",
    category: "features",
    name: "Features, bento",
    summary: "Four benefits in tiles of different sizes, one highlighted",
    html: tidy(`
      <section class="lcs lcs-features-bento" data-lcs="features-bento">
        <div class="lcs-in">
          <div class="lcs-head">
            <h2 class="lcs-h2">What you get when you work with us</h2>
            <p class="lcs-lead">One line that frames the four benefits below.</p>
          </div>
          <ul class="lcs-tiles">
            <li class="lcs-tile lcs-tile-main"><h3 class="lcs-h3">Your main benefit goes here</h3><p class="lcs-text">The one thing customers value most. Give it the most space and the clearest words.</p><div class="lcs-media" aria-hidden="true"></div></li>
            <li class="lcs-tile"><span class="lcs-ico">A</span><h3 class="lcs-h3">Second benefit</h3><p class="lcs-text">One sentence on what it means for the customer.</p></li>
            <li class="lcs-tile"><span class="lcs-ico">B</span><h3 class="lcs-h3">Third benefit</h3><p class="lcs-text">One sentence on what it means for the customer.</p></li>
            <li class="lcs-tile lcs-tile-wide"><span class="lcs-ico">C</span><h3 class="lcs-h3">Fourth benefit</h3><p class="lcs-text">A slightly longer sentence for the benefit that needs a little more explaining.</p></li>
          </ul>
        </div>
      </section>`),
    css: `/* Features, bento */
.lcs-features-bento .lcs-head { display: grid; gap: 12px; margin-bottom: clamp(28px, 4cqi, 48px); }
.lcs-features-bento .lcs-tiles { display: grid; gap: 16px; }
.lcs-features-bento .lcs-tile { display: grid; gap: 10px; align-content: start; padding: 26px; border-radius: calc(var(--lcs-radius) * 1.2); background: var(--lcs-tint); }
.lcs-features-bento .lcs-tile-main { background: var(--lcs-tint-2); }
.lcs-features-bento .lcs-tile-main .lcs-media { aspect-ratio: 16 / 9; margin-top: 10px; border: 0; }
.lcs-features-bento .lcs-ico { background: color-mix(in srgb, var(--lcs-brand) 16%, transparent); }
@container (min-width: 760px) {
  .lcs-features-bento .lcs-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .lcs-features-bento .lcs-tile-main { grid-column: span 2; grid-row: span 2; }
  .lcs-features-bento .lcs-tile-wide { grid-column: span 3; }
}
`,
  },

  // ---------------------------------------------------------------- call to action
  {
    id: "cta-band",
    category: "cta",
    name: "Call to action, brand band",
    summary: "A bold band in your brand colour with one clear next step",
    html: tidy(`
      <section class="lcs lcs-cta-band" data-lcs="cta-band">
        <div class="lcs-in">
          <div class="lcs-band">
            <h2 class="lcs-h2">Ready to get started?</h2>
            <p class="lcs-lead">Tell people exactly what happens when they click, and how soon they will hear back.</p>
            <div class="lcs-actions"><a class="lcs-btn" href="#contact">Get a free quote</a><a class="lcs-btn lcs-btn-ghost" href="tel:+10000000000">Call us today</a></div>
          </div>
        </div>
      </section>`),
    css: `/* Call to action, brand band */
.lcs-cta-band .lcs-band { display: grid; gap: 18px; justify-items: center; text-align: center; padding: clamp(36px, 7cqi, 88px) clamp(24px, 5cqi, 64px); border-radius: calc(var(--lcs-radius) * 1.4); background: var(--lcs-brand); color: var(--lcs-on-brand); }
.lcs-cta-band .lcs-lead { color: inherit; opacity: .86; margin-inline: auto; }
.lcs-cta-band .lcs-actions { justify-content: center; }
.lcs-cta-band a.lcs-btn { background: var(--lcs-on-brand); color: var(--lcs-brand); border-color: var(--lcs-on-brand); }
.lcs-cta-band a.lcs-btn-ghost { background: transparent; color: inherit; border-color: color-mix(in srgb, var(--lcs-on-brand) 45%, transparent); }
`,
  },
  {
    id: "cta-split",
    category: "cta",
    name: "Call to action, card",
    summary: "A soft card with the message on one side and buttons on the other",
    html: tidy(`
      <section class="lcs lcs-cta-split" data-lcs="cta-split">
        <div class="lcs-in">
          <div class="lcs-card">
            <div class="lcs-copy">
              <h2 class="lcs-h2">Let us take this off your plate</h2>
              <p class="lcs-text">One reassuring sentence about what happens next, such as a free consultation or a same-day reply.</p>
            </div>
            <div class="lcs-actions"><a class="lcs-btn" href="#contact">Book a free consultation</a></div>
          </div>
        </div>
      </section>`),
    css: `/* Call to action, card */
.lcs-cta-split .lcs-card { display: grid; gap: 22px; align-items: center; padding: clamp(28px, 5cqi, 56px); border-radius: calc(var(--lcs-radius) * 1.3); background: var(--lcs-tint); border: 1px solid var(--lcs-tint-2); }
.lcs-cta-split .lcs-copy { display: grid; gap: 10px; }
@container (min-width: 760px) { .lcs-cta-split .lcs-card { grid-template-columns: 1fr auto; } }
`,
  },
];

export const getSection = (id: string) => SECTIONS.find((s) => s.id === id);
