/**
 * Page recipes: a whole page as an ORDERED list of template sections.
 *
 * A recipe is a plan, not a renderer. The assistant creates the page as a draft (create_page) and then places each
 * section with the normal place_component pipeline - measured fit, approval, checks, ledger - so every section stays
 * separately editable and revertable, and the sections are the same ones used everywhere else on the site.
 *
 * Each step names the template, its variant, and what content the person has to provide. Content is never invented.
 */

export interface RecipeStep {
  /** A template id of the site's template library (GET /livecrafts/v1/templates). */
  template: string;
  /** The layout of that template (its "variant" attribute); left out when the template has only one. */
  variant?: string;
  /** What this section is for, in one line. */
  role: string;
  /** What the person must provide before this section can be placed. */
  needs: string;
  /** Only when it matters for the rhythm of the page. */
  note?: string;
}

export interface Recipe {
  id: string;
  kind: "about" | "contact" | "info";
  title: string;
  description: string;
  /** What the page is for, so the assistant can pick between the three of a kind. */
  bestFor: string;
  steps: RecipeStep[];
}

const HEADER: RecipeStep = { template: "header", role: "Site header", needs: "the site name or logo, the menu links", note: "Skip it when the theme already prints a header: most sites do. Check the page first." };
const FOOTER: RecipeStep = { template: "footer", role: "Site footer", needs: "the columns of links, the contact line, the copyright", note: "Skip it when the theme already prints a footer." };

export const RECIPES: Recipe[] = [
  {
    id: "about_classic",
    kind: "about",
    title: "About - classic corporate",
    description: "Banner, the story beside a picture with a ticked list, figures, the team, a closing call to action.",
    bestFor: "an established company that wants to look solid: history, numbers, faces.",
    steps: [
      HEADER,
      { template: "hero", role: "Page banner", needs: "the page title and one sentence about the company" },
      { template: "feature_grid", variant: "checklist", role: "The story, with what the company is proud of", needs: "a heading, a paragraph of history, 3-5 real achievements" },
      { template: "stats", role: "Figures that prove it", needs: "3 real numbers with their labels (projects, years, clients)", note: "Only real numbers. If the person has none, leave this section out." },
      { template: "team", role: "The people", needs: "name, role and photo of each person" },
      { template: "cta", role: "Closing call to action", needs: "one line and the button text + link" },
      FOOTER,
    ],
  },
  {
    id: "about_split",
    kind: "about",
    title: "About - dark split hero",
    description: "A dark hero with a picture beside it, the values, the journey as steps, one strong quote.",
    bestFor: "a studio or agency with a design-led brand.",
    steps: [
      HEADER,
      { template: "hero", role: "Hero with a picture beside the message", needs: "the headline, one sentence, a picture, the button text + link" },
      { template: "feature_grid", variant: "icons", role: "What the company stands for", needs: "3 values: a short title and one sentence each" },
      { template: "steps", role: "The journey, in order", needs: "3-5 milestones: year and what happened" },
      { template: "testimonials", variant: "centered", role: "One strong client quote", needs: "the real quote, the person's name and role", note: "Never invent a quote. Without a real one, leave this out." },
      FOOTER,
    ],
  },
  {
    id: "about_editorial",
    kind: "about",
    title: "About - minimal editorial",
    description: "Big type, mission and vision side by side, how the work is done, the people as a list.",
    bestFor: "a small team that wants to read as thoughtful rather than corporate.",
    steps: [
      HEADER,
      { template: "hero_centered", role: "Big statement", needs: "a short headline (3-6 words) and one sentence" },
      { template: "feature_grid", variant: "icons", role: "Mission and vision", needs: "2 cards: a title and a sentence each" },
      { template: "steps", role: "How the work runs", needs: "3 stages with one line each (discover, design, deliver)" },
      { template: "team", role: "The people", needs: "name and role of each person" },
      { template: "cta", role: "Closing call to action", needs: "one line and the button text + link" },
      FOOTER,
    ],
  },
  {
    id: "contact_cards",
    kind: "contact",
    title: "Contact - details, form and offices",
    description: "Banner, three contact cards, then the form beside the contact details.",
    bestFor: "a business people phone or visit: the address and number come first.",
    steps: [
      HEADER,
      { template: "hero", role: "Page banner", needs: "the page title and one welcoming sentence" },
      { template: "feature_grid", variant: "icons", role: "Visit / call / e-mail", needs: "the real address, phone number and e-mail", note: "Never invent contact details: ask for them." },
      { template: "contact_form", variant: "split", role: "The form, with the details beside it", needs: "a heading, and where the messages should go", note: "With no action the form posts to the plugin's own handler and e-mails the site's admin address: say so and confirm the address." },
      FOOTER,
    ],
  },
  {
    id: "contact_faq",
    kind: "contact",
    title: "Contact - form first, then answers",
    description: "The form and the contact details at the top, the questions people ask underneath.",
    bestFor: "a service business that gets the same questions before every enquiry.",
    steps: [
      HEADER,
      { template: "contact_form", variant: "split", role: "Headline, details and the form", needs: "a heading, one sentence, the address / phone / e-mail / opening hours" },
      { template: "faq", role: "Quick answers", needs: "3-6 real questions with their answers" },
      FOOTER,
    ],
  },
  {
    id: "contact_offices",
    kind: "contact",
    title: "Contact - short form and the offices",
    description: "Banner, a short form on its own, then one card per office.",
    bestFor: "a company with more than one location.",
    steps: [
      HEADER,
      { template: "hero", role: "Page banner", needs: "the page title and one sentence" },
      { template: "contact_form", variant: "stacked", role: "A short form, nothing else to distract", needs: "a heading and where the messages go" },
      { template: "feature_grid", variant: "icons", role: "The offices", needs: "the real name, role and address of each office" },
      FOOTER,
    ],
  },
  {
    id: "info_faq",
    kind: "info",
    title: "Information - questions and a help box",
    description: "Banner, the questions, and a card that points at support.",
    bestFor: "one page that answers everything before someone has to ask.",
    steps: [
      HEADER,
      { template: "hero", role: "Page banner", needs: "the page title and one sentence" },
      { template: "faq", role: "Frequently asked questions", needs: "4-8 real questions with their answers" },
      { template: "cta", role: "Still stuck? talk to us", needs: "one line and the button text + link to the contact page" },
      FOOTER,
    ],
  },
  {
    id: "info_help_center",
    kind: "info",
    title: "Information - help centre",
    description: "A hero that invites a search, the topics as cards, then the popular articles.",
    bestFor: "a product or service with enough material to browse by topic.",
    steps: [
      HEADER,
      { template: "hero_centered", role: "How can we help?", needs: "the headline and one sentence" },
      { template: "feature_grid", variant: "icons", role: "Browse by topic", needs: "4-6 topics: a title and an icon each" },
      { template: "blog_grid", variant: "list", role: "Popular articles", needs: "the real articles: title, link, and how long they take to read" },
      FOOTER,
    ],
  },
  {
    id: "info_article",
    kind: "info",
    title: "Information - the detail page",
    description: "A title, what is included at each level, and how the work runs.",
    bestFor: "explaining plans, pricing and process on one page people can be sent to.",
    steps: [
      HEADER,
      { template: "hero_centered", role: "What this page explains", needs: "the title and one sentence, plus when it was last updated" },
      { template: "pricing", role: "What each level includes", needs: "the real plans: name, what is included, and the price or timeline", note: "Never invent prices." },
      { template: "steps", role: "How a project runs", needs: "the stages, one line each" },
      { template: "faq", role: "The questions this raises", needs: "3-6 real questions with answers" },
      FOOTER,
    ],
  },
];

export const recipe = (id: string) => RECIPES.find((r) => r.id === id);

/** The list the assistant chooses from, short enough to read in one go. */
export const recipeList = () =>
  RECIPES.map((r) => ({ id: r.id, kind: r.kind, title: r.title, bestFor: r.bestFor, sections: r.steps.length }));
