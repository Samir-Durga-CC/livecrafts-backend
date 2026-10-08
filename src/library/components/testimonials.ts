import { container, heading, image, paragraph } from "../elementor.js";
import type { Content, LibraryComponent } from "../types.js";

/** Marker text of the sample content: it must be replaced with real customer words before the page goes live. */
export const SAMPLE_QUOTE = "Replace this with a real quote from a customer.";

const html = `<section class="lc-c lc-testimonials" aria-label="{{title}}"{{{placeholderAttr}}}>
<div class="lc-inner">
<div class="lc-header">
{{#if eyebrow}}<p class="lc-eyebrow">{{eyebrow}}</p>{{/if}}
<h2 class="lc-title">{{title}}</h2>
{{#if intro}}<p class="lc-intro">{{intro}}</p>{{/if}}
</div>
<div class="lc-grid{{{gridClass}}}">
{{#each items}}<figure class="lc-card">
<blockquote class="lc-quote-text"><p>{{quote}}</p></blockquote>
<figcaption class="lc-person">{{#if avatar}}<img class="lc-avatar" src="{{url:avatar}}" alt="" width="48" height="48" loading="lazy" decoding="async">{{/if}}<span class="lc-person-text"><strong class="lc-name">{{name}}</strong>{{#if role}}<span class="lc-role">{{role}}</span>{{/if}}</span></figcaption>
</figure>
{{/each}}</div>
</div>
</section>
`;

const blocks = `<!-- wp:group {"tagName":"section","className":"lc-c lc-testimonials","layout":{"type":"default"}} -->
<section class="wp-block-group lc-c lc-testimonials"><!-- wp:group {"className":"lc-inner","layout":{"type":"default"}} -->
<div class="wp-block-group lc-inner"><!-- wp:group {"className":"lc-header","layout":{"type":"default"}} -->
<div class="wp-block-group lc-header">{{#if eyebrow}}<!-- wp:paragraph {"className":"lc-eyebrow"} -->
<p class="lc-eyebrow">{{eyebrow}}</p>
<!-- /wp:paragraph -->{{/if}}<!-- wp:heading {"className":"lc-title"} -->
<h2 class="wp-block-heading lc-title">{{title}}</h2>
<!-- /wp:heading -->{{#if intro}}<!-- wp:paragraph {"className":"lc-intro"} -->
<p class="lc-intro">{{intro}}</p>
<!-- /wp:paragraph -->{{/if}}</div>
<!-- /wp:group -->

<!-- wp:group {"className":"lc-grid{{{gridClass}}}","layout":{"type":"default"}} -->
<div class="wp-block-group lc-grid{{{gridClass}}}">{{#each items}}<!-- wp:group {"className":"lc-card","layout":{"type":"default"}} -->
<div class="wp-block-group lc-card"><!-- wp:paragraph {"className":"lc-quote-text"} -->
<p class="lc-quote-text">{{quote}}</p>
<!-- /wp:paragraph -->

<!-- wp:group {"className":"lc-person","layout":{"type":"default"}} -->
<div class="wp-block-group lc-person"><!-- wp:group {"className":"lc-person-text","layout":{"type":"default"}} -->
<div class="wp-block-group lc-person-text"><!-- wp:paragraph {"className":"lc-name"} -->
<p class="lc-name"><strong>{{name}}</strong></p>
<!-- /wp:paragraph -->{{#if role}}<!-- wp:paragraph {"className":"lc-role"} -->
<p class="lc-role">{{role}}</p>
<!-- /wp:paragraph -->{{/if}}</div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

{{/each}}</div>
<!-- /wp:group --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
`;

export const testimonials: LibraryComponent = {
  id: "testimonials",
  name: "Testimonials",
  description: "Customer quotes in a responsive card grid: small label, heading, intro and 1-6 quotes, each with name, role and an optional photo.",
  keywords: ["testimonial", "testimonials", "review", "reviews", "quote", "quotes", "customer feedback", "client feedback", "client says", "what clients say", "social proof", "praise", "rating", "trusted by"],
  slots: [
    { name: "eyebrow", label: "Small label above the heading", type: "text", max: 60 },
    { name: "title", label: "Heading", type: "text", required: true, max: 120 },
    { name: "intro", label: "Intro sentence", type: "textarea", max: 300 },
    {
      name: "items", label: "Quotes", type: "list", required: true, minItems: 1, maxItems: 6, fields: [
        { name: "quote", label: "What the customer said", type: "textarea", required: true, max: 500, help: "A real quote. Never invent one." },
        { name: "name", label: "Name", type: "text", required: true, max: 80 },
        { name: "role", label: "Role / company", type: "text", max: 100 },
        { name: "avatar", label: "Photo (Media Library image id)", type: "image" },
      ],
    },
  ],
  sample: () => ({
    eyebrow: "Testimonials",
    title: "What our customers say",
    intro: "",
    items: [1, 2, 3].map((n) => ({ quote: SAMPLE_QUOTE, name: `Customer name ${n}`, role: "Role, Company", avatar: "" })),
  }),
  css: `/* Livecrafts component: testimonials */
.lc-c.lc-c.lc-testimonials .lc-quote-text { flex: 1 1 auto; }
`,
  isPlaceholder: (c) => (c.items as Content[]).some((it) => it.quote === SAMPLE_QUOTE),
  php: {
    placeholderAttr: "",
    gridClass: "<?php echo ( is_array( get_sub_field( 'items' ) ) && 4 === count( get_sub_field( 'items' ) ) ) ? ' lc-grid--pairs' : ''; ?>",
  },
  prepare: (c: Content) => ({ ...c, gridClass: (c.items?.length ?? 0) === 4 ? " lc-grid--pairs" : "" }),
  html,
  blocks,
  elementor: (c, ctx) => {
    const cards = (c.items as Content[]).map((it) => container("lc-card", [
      paragraph(it.quote, "lc-quote-text"),
      container("lc-person", [
        ...(it.avatar && ctx.media[it.avatar] ? [image(Number(it.avatar), "lc-avatar")] : []),
        container("lc-person-text", [heading(it.name, "div", "lc-name"), ...(it.role ? [heading(it.role, "div", "lc-role")] : [])]),
      ], { flex_direction: "row" }),
    ]));
    return container("lc-c lc-testimonials", [
      container("lc-inner", [
        container("lc-header", [
          ...(c.eyebrow ? [heading(c.eyebrow, "p", "lc-eyebrow")] : []),
          heading(c.title, "h2", "lc-title"),
          ...(c.intro ? [paragraph(c.intro, "lc-intro")] : []),
        ]),
        container(`lc-grid${c.gridClass ?? ""}`, cards, { flex_direction: "row" }),
      ]),
    ]) as unknown as Record<string, any>;
  },
};
