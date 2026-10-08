import { escapeHtml, safeUrl } from "../engine.js";
import { button, container, heading, paragraph, shortcode, textEditor } from "../elementor.js";
import type { Content, LibraryComponent } from "../types.js";

const KIND_LABEL: Record<string, string> = { address: "Address", phone: "Phone", email: "Email", hours: "Opening hours", other: "Details" };

const html = `<section class="lc-c lc-contact" aria-label="{{title}}"{{{placeholderAttr}}}>
<div class="lc-inner">
<div class="lc-header">
{{#if eyebrow}}<p class="lc-eyebrow">{{eyebrow}}</p>{{/if}}
<h2 class="lc-title">{{title}}</h2>
{{#if intro}}<p class="lc-intro">{{intro}}</p>{{/if}}
</div>
<div class="lc-split{{{splitClass}}}">
<ul class="lc-details">
{{#each details}}<li>{{#if label}}<span class="lc-label">{{label}}</span>{{/if}}{{#if href}}<a class="lc-value" href="{{url:href}}">{{value}}</a>{{/if}}{{#unless href}}<span class="lc-value">{{value}}</span>{{/unless}}</li>
{{/each}}</ul>
<div class="lc-form">
{{#if formShortcode}}{{shortcode:formShortcode}}{{/if}}
{{#unless formShortcode}}{{#if ctaUrl}}<p class="lc-cta"><a class="lc-btn" href="{{url:ctaUrl}}">{{ctaLabel}}</a></p>{{/if}}{{/unless}}
</div>
</div>
</div>
</section>
`;

const blocks = `<!-- wp:group {"tagName":"section","className":"lc-c lc-contact","layout":{"type":"default"}} -->
<section class="wp-block-group lc-c lc-contact"><!-- wp:group {"className":"lc-inner","layout":{"type":"default"}} -->
<div class="wp-block-group lc-inner"><!-- wp:group {"className":"lc-header","layout":{"type":"default"}} -->
<div class="wp-block-group lc-header">{{#if eyebrow}}<!-- wp:paragraph {"className":"lc-eyebrow"} -->
<p class="lc-eyebrow">{{eyebrow}}</p>
<!-- /wp:paragraph -->{{/if}}<!-- wp:heading {"className":"lc-title"} -->
<h2 class="wp-block-heading lc-title">{{title}}</h2>
<!-- /wp:heading -->{{#if intro}}<!-- wp:paragraph {"className":"lc-intro"} -->
<p class="lc-intro">{{intro}}</p>
<!-- /wp:paragraph -->{{/if}}</div>
<!-- /wp:group -->

<!-- wp:group {"className":"lc-split{{{splitClass}}}","layout":{"type":"default"}} -->
<div class="wp-block-group lc-split{{{splitClass}}}"><!-- wp:list {"className":"lc-details"} -->
<ul class="wp-block-list lc-details">{{#each details}}<!-- wp:list-item -->
<li>{{#if label}}<span class="lc-label">{{label}}</span>{{/if}}{{#if href}}<a class="lc-value" href="{{url:href}}">{{value}}</a>{{/if}}{{#unless href}}<span class="lc-value">{{value}}</span>{{/unless}}</li>
<!-- /wp:list-item -->{{/each}}</ul>
<!-- /wp:list -->

<!-- wp:group {"className":"lc-form","layout":{"type":"default"}} -->
<div class="wp-block-group lc-form">{{#if formShortcode}}<!-- wp:shortcode -->
{{shortcode:formShortcode}}
<!-- /wp:shortcode -->{{/if}}{{#unless formShortcode}}{{#if ctaUrl}}<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"className":"lc-btn-wrap"} -->
<div class="wp-block-button lc-btn-wrap"><a class="wp-block-button__link wp-element-button" href="{{url:ctaUrl}}">{{ctaLabel}}</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->{{/if}}{{/unless}}</div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
`;

/** tel: / mailto: for a detail when the person gave none. */
function hrefFor(kind: string, value: string): string {
  if (kind === "email" && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) return "mailto:" + value;
  if (kind === "phone") { const d = value.replace(/[^\d+]/g, ""); if (d.replace(/\D/g, "").length >= 5) return "tel:" + d; }
  return "";
}

export const contact: LibraryComponent = {
  id: "contact",
  name: "Contact",
  description: "Contact section: heading and intro, a list of address / phone / email / hours (phone and e-mail become tap-to-call and tap-to-mail links) beside the site's own contact form, or a button when there is no form plugin.",
  keywords: ["contact", "contact us", "get in touch", "reach us", "enquiry", "inquiry", "form", "address", "phone", "email", "call us", "location", "write to us"],
  slots: [
    { name: "eyebrow", label: "Small label above the heading", type: "text", max: 60 },
    { name: "title", label: "Heading", type: "text", required: true, max: 120 },
    { name: "intro", label: "Intro sentence", type: "textarea", max: 300 },
    {
      name: "details", label: "Contact details", type: "list", required: true, minItems: 1, maxItems: 6, fields: [
        { name: "kind", label: "Kind", type: "select", choices: ["address", "phone", "email", "hours", "other"], required: true },
        { name: "label", label: "Label (default from the kind)", type: "text", max: 40 },
        { name: "value", label: "Text shown", type: "text", required: true, max: 200 },
        { name: "href", label: "Link (tel:, mailto: or a map address; filled for phone and email)", type: "url" },
      ],
    },
    { name: "formShortcode", label: "Shortcode of the site's contact form, e.g. [contact-form-7 id=\"12\"]", type: "shortcode", help: "Use a form that exists: see site_profile.forms." },
    { name: "ctaLabel", label: "Button text when there is no form", type: "text", max: 40 },
    { name: "ctaUrl", label: "Button link when there is no form (default: mailto: the first e-mail)", type: "url" },
  ],
  sample: () => ({
    eyebrow: "Contact",
    title: "Get in touch",
    intro: "Tell us what you need and we will get back to you.",
    details: [
      { kind: "address", label: "", value: "Your street 1, Your city", href: "" },
      { kind: "phone", label: "", value: "+00 000 000 0000", href: "" },
      { kind: "email", label: "", value: "hello@example.com", href: "" },
    ],
    formShortcode: "", ctaLabel: "", ctaUrl: "",
  }),
  css: `/* Livecrafts component: contact */
.lc-c.lc-c.lc-contact .lc-split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: clamp(1.5rem, 4vw, 3rem);
  align-items: start;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
}
.lc-c.lc-c.lc-contact .lc-split > * { min-width: 0; max-width: 100%; margin: 0; }
.lc-c.lc-c.lc-contact .lc-split.lc-split--single { grid-template-columns: minmax(0, 1fr); }
.lc-c.lc-c.lc-contact .lc-cta { margin: 0; }
`,
  isPlaceholder: (c) => (c.details as Content[]).some((d) => /example.com|Your street|000 000/.test(String(d.value))),
  php: { placeholderAttr: "", splitClass: "<?php echo get_sub_field( 'formShortcode' ) ? '' : ' lc-split--single'; ?>" },
  prepare: (c: Content) => {
    const details: Content[] = (c.details as Content[]).map((d) => ({
      ...d, label: d.label || KIND_LABEL[d.kind] || "Details", href: d.href || hrefFor(d.kind, d.value),
    }));
    const firstEmail = details.find((d) => d.kind === "email" && d.href.startsWith("mailto:"));
    const ctaUrl = c.ctaUrl || (firstEmail ? firstEmail.href : "");
    return { ...c, details, ctaUrl, ctaLabel: c.ctaLabel || (ctaUrl.startsWith("mailto:") ? "Email us" : "Contact us"), splitClass: c.formShortcode ? "" : " lc-split--single" };
  },
  html,
  blocks,
  elementor: (c) => {
    const items = (c.details as Content[]).map((d) => {
      const url = safeUrl(d.href);
      const value = url ? `<a class="lc-value" href="${escapeHtml(url)}">${escapeHtml(d.value)}</a>` : `<span class="lc-value">${escapeHtml(d.value)}</span>`;
      return `<li><span class="lc-label">${escapeHtml(d.label)}</span>${value}</li>`;
    }).join("");
    return container("lc-c lc-contact", [
      container("lc-inner", [
        container("lc-header", [
          ...(c.eyebrow ? [heading(c.eyebrow, "p", "lc-eyebrow")] : []),
          heading(c.title, "h2", "lc-title"),
          ...(c.intro ? [paragraph(c.intro, "lc-intro")] : []),
        ]),
        container(`lc-split${c.splitClass}`, [
          textEditor(`<ul class="lc-details">${items}</ul>`, "lc-details-wrap"),
          ...(c.formShortcode || c.ctaUrl ? [container("lc-form", [c.formShortcode ? shortcode(c.formShortcode, "lc-form-wrap") : button(c.ctaLabel, c.ctaUrl)])] : []),
        ], { flex_direction: "row" }),
      ]),
    ]) as unknown as Record<string, any>;
  },
};
