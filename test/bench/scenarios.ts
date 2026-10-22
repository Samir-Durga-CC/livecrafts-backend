/**
 * What the bench asks the agent, per site, in the words a non-technical client would use.
 *
 * Expectations are written from `npm run bench:discover` output - the site's REAL current content. An assertion
 * against invented text fails for the wrong reason and teaches nothing.
 *
 *   draft    text that must appear on the DRAFT page after the turn (what editors see)
 *   notDraft text that must NOT appear on the draft page
 *   notLive  text that must NOT appear on the LIVE page (proves the change stayed a draft)
 *   tool     a tool the turn is expected to use at least once
 */
export interface Turn {
  say: string;
  expect?: {
    draft?: string[]; notDraft?: string[]; notLive?: string[];
    /** A tool that must be used. Only assert this when exactly ONE tool can be right - prefer asserting the outcome. */
    tool?: string;
    /** The turn must change something on the site, by whatever route the agent judges best. */
    changed?: boolean;
  };
  /** A turn that should NOT write anything (a question, or something the agent must refuse). */
  readOnly?: boolean;
}

export interface Scenario {
  id: string;
  siteId: string;
  /** The page the conversation is about (default: the site's start page). */
  page?: string;
  builder: string;
  turns: Turn[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "elementor",
    siteId: "site_a283e4115cb5",
    builder: "Elementor 4.3.5 / Hello Elementor / plugin 0.19.0",
    turns: [
      {
        say: "Change the big AEROMATIC heading at the top to 'AEROMATIC LABS'",
        expect: { draft: ["AEROMATIC LABS"], notLive: ["AEROMATIC LABS"], tool: "make_change" },
      },
      {
        say: "That heading is too big on my phone - make it smaller on mobile only",
        expect: { tool: "make_change" },
      },
      {
        say: "The 'Get in touch' button should say 'Talk to us' and go to the contact page",
        expect: { draft: ["Talk to us"], notDraft: ["Get in touch"], tool: "make_change" },
      },
      {
        say: "What is on this page right now? Just tell me, do not change anything.",
        readOnly: true,
      },
      {
        // No `tool`: placing a section through the component library (place_component) is the RIGHT answer here,
        // and an earlier version of this file demanded make_change and so failed the agent for being correct.
        say: "Add a FAQ section at the end of the page with three common questions",
        expect: { changed: true },
      },
      {
        // Undoing the previous turn with revert_change is also correct - assert the OUTCOME, not the mechanism.
        say: "Actually remove that FAQ section again",
        expect: { changed: true },
      },
    ],
  },
  {
    id: "acf",
    siteId: "site_0b660fd0530e",
    builder: "ACF 6.8.10 / custom theme Aeromatic Exp1 / plugin 0.18.2",
    turns: [
      {
        say: "Change the hero title from 'Communication Crafts' to 'Aeromatic Industrial'",
        expect: { draft: ["Aeromatic Industrial"], notLive: ["Aeromatic Industrial"], tool: "make_change" },
      },
      {
        say: "The hero button says 'Request Consultation' - make it 'Book a Consultation' instead",
        expect: { draft: ["Book a Consultation"], notDraft: ["Request Consultation"], tool: "make_change" },
      },
      {
        say: "Under 'Why Aeromatic', change the heading to 'Four Decades of Engineering Expertise'",
        expect: { draft: ["Four Decades of Engineering Expertise"], tool: "make_change" },
      },
      {
        say: "Which of these fields are images, and are any of them empty? Do not change anything.",
        readOnly: true,
      },
      {
        say: "Make the first product card title say 'Industrial Heating and Drying Systems'",
        expect: { draft: ["Industrial Heating and Drying Systems"], tool: "make_change" },
      },
      {
        // Reverting the earlier change is a legitimate way to do this, so assert the page, not the tool.
        say: "Put the hero title back to 'Communication Crafts'",
        expect: { draft: ["Communication Crafts"], notDraft: ["Aeromatic Industrial"], changed: true },
      },
    ],
  },
  {
    id: "divi",
    siteId: "site_106e9c7f1aa8",
    builder: "Divi 5.15.0 / plugin 0.18.0",
    turns: [
      {
        say: "Change the 'Start your project' button to say 'Get a free quote'",
        expect: { draft: ["Get a free quote"], notDraft: ["Start your project"], notLive: ["Get a free quote"], tool: "make_change" },
      },
      {
        say: "The counter that says 'Projects delivered' should read 'Websites shipped' instead",
        expect: { draft: ["Websites shipped"], tool: "make_change" },
      },
      {
        say: "Point that quote button at the contact page instead of the anchor",
        expect: { tool: "make_change" },
      },
      {
        say: "List the sections of this page in order so I know what is where. Change nothing.",
        readOnly: true,
      },
      {
        say: "The 'Lightning fast' blurb heading should say 'Fast by default'",
        expect: { draft: ["Fast by default"], notDraft: ["Lightning fast"], tool: "make_change" },
      },
      {
        say: "Change the projects number from 280 to 310",
        expect: { draft: ["310"], tool: "make_change" },
      },
    ],
  },
];
