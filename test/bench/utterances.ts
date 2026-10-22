/**
 * What people actually say to a website assistant, in the phrasings a non-technical client uses.
 *
 * `keywords` are the words that DECIDE the edit - the element, the surface, the breakpoint, the literal new text. If
 * the transcriber loses one of these the request is unexecutable no matter how good the rest of the sentence is, so
 * they are scored separately from word error rate. Brand words come from the real sites (AEROMATIC, Communication
 * Crafts, Anythin), because those are exactly the words a generic vocabulary hint mangles.
 *
 * To test a real accent in a real room, read these aloud and save them as 1.webm, 2.webm ... then
 * `npm run bench:voice -- --dir ./recordings`.
 */
export interface Utterance { n: number; text: string; keywords: string[] }

export const UTTERANCES: Utterance[] = [
  { n: 1, text: "Change the big AEROMATIC heading at the top to AEROMATIC LABS", keywords: ["aeromatic", "heading", "aeromatic labs"] },
  { n: 2, text: "That heading is too big on my phone, make it smaller on mobile only", keywords: ["heading", "mobile"] },
  { n: 3, text: "The Get in touch button should say Talk to us and go to the contact page", keywords: ["button", "talk to us", "contact"] },
  { n: 4, text: "Add a FAQ section at the end of the page with three common questions", keywords: ["faq", "section"] },
  { n: 5, text: "Remove the testimonials section from the home page", keywords: ["testimonials", "section"] },
  { n: 6, text: "Change the hero title from Communication Crafts to Aeromatic Industrial", keywords: ["hero", "communication crafts", "aeromatic industrial"] },
  { n: 7, text: "Make the padding above the pricing section a bit tighter on tablet", keywords: ["padding", "pricing", "tablet"] },
  { n: 8, text: "The counter that says Projects delivered should read Websites shipped instead", keywords: ["projects delivered", "websites shipped"] },
  { n: 9, text: "Put the Lightning fast blurb heading as Fast by default", keywords: ["lightning fast", "fast by default"] },
  { n: 10, text: "Move the newsletter signup above the footer", keywords: ["newsletter", "footer"] },
  { n: 11, text: "Write a new blog post about industrial vacuum systems and keep it as a draft", keywords: ["blog post", "draft"] },
  { n: 12, text: "Change the navigation link colour to dark navy but do not publish it yet", keywords: ["navigation", "colour", "publish"] },
  { n: 13, text: "Hide the second section on phones but leave it on desktop", keywords: ["section", "phones", "desktop"] },
  { n: 14, text: "On the Anythin page change the quote button to Book a visit", keywords: ["anythin", "button", "book a visit"] },
  { n: 15, text: "Undo the last change you made, it looks wrong", keywords: ["undo", "last change"] },
];
