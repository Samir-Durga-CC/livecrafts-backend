/**
 * The voice bench: measure the SPEECH layer on its own, then measure what the speech layer costs the agent.
 *
 *   npm run bench:voice                        synthesised speech, no vocabulary hint
 *   npm run bench:voice -- --vocab             the same audio, with a vocabulary hint
 *   npm run bench:voice -- --dir ./recordings  real recordings instead (see below)
 *   npm run bench:voice -- --voices onyx,nova  synthesise with several voices
 *
 * WHY NOT COMPARE AGAINST ANOTHER ASSISTANT: "ours feels worse than X" is already known and names no cause, because
 * the two differ in transport, speech model, agent and narration all at once. These numbers name the layer:
 *
 *   WER        words the transcriber got wrong. The speech layer alone.
 *   keywords   whether the words that DECIDE the edit survived ("hero", "Elementor", "mobile", "padding").
 *              A 4% WER that eats "hero" is worse for us than a 12% WER that only fuddles filler.
 *   --vocab    the same audio with the site's own words passed to the transcriber, to prove whether
 *              conditioning is worth wiring into realtime.ts (which today passes no prompt at all).
 *
 * Synthesised speech is a CLEAN-ROOM baseline: no accent, no noise, no room. If WER is already bad here, it is bad
 * everywhere and needs no further proof. It cannot tell you how the system does on a real accent in a real room -
 * for that, record the lines in utterances.ts as audio files named 1.webm, 2.webm ... and pass --dir.
 */
import path from "node:path";
import fs from "node:fs";
import { config } from "../../src/config.js";
import { transcribe, speak, voiceInfo } from "../../src/voice.js";
import { UTTERANCES, type Utterance } from "./utterances.js";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const useVocab = argv.includes("--vocab");
const dir = flag("dir");
const voices = (flag("voices") ?? "onyx").split(",").map((v) => v.trim()).filter(Boolean);

const info = voiceInfo();
if (!info.available) { console.error("Voice needs an OpenAI API key (Integrations → AI models → OpenAI)."); process.exit(1); }

/**
 * Lower-case words, punctuation dropped, and the differences that are NOT transcription errors folded away first:
 * British/American spelling ("colour"/"color"), hyphenation ("sign-up"/"signup") and plurals ("testimonial(s)").
 * An earlier version of this file counted all three as errors and reported a 38% WER for a perfect transcript -
 * a scorer that cries wolf gets switched off, and then nothing is measured at all.
 */
const spelling = (w: string) => w
  .replace(/our(s?)$/, "or$1")       // colour -> color, favours -> favors
  .replace(/ise(s|d)?$/, "ize$1")    // customise -> customize
  .replace(/s$/, "");                // plural -> singular
const words = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[-‐-―]/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).map(spelling);

/** Levenshtein distance over word arrays -> word error rate against the reference. */
function wer(reference: string, got: string): { wer: number; edits: number; words: number } {
  const a = words(reference), b = words(got);
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  const edits = d[a.length][b.length];
  return { wer: a.length ? edits / a.length : 0, edits, words: a.length };
}

/**
 * Did the words that decide the edit survive? Compared with spaces removed too, so "home page" and "homepage" are
 * the same word to us - the agent resolves either, and a bench must only flag what would really break the edit.
 */
function keywordsKept(u: Utterance, got: string): { kept: string[]; lost: string[] } {
  const squash = (s: string) => words(s).join("");
  const hay = squash(got);
  const kept: string[] = [], lost: string[] = [];
  for (const k of u.keywords) (hay.includes(squash(k)) ? kept : lost).push(k);
  return { kept, lost };
}

interface Row { n: number; said: string; heard: string; wer: number; lost: string[]; ms: number; voice: string }
const rows: Row[] = [];

/** The site's own words, the hint a transcriber should be given. In the product these come from get_page_map. */
const VOCAB_HINT = [
  "Livecrafts, WordPress, Elementor, Divi, Gutenberg, ACF, Hostinger.",
  "Page sections: hero, header, footer, navigation, pricing, testimonials, FAQ, blog, contact.",
  "Editing words: padding, margin, font size, mobile, tablet, desktop, draft, deploy, revert, publish.",
  "This site's content: AEROMATIC, Communication Crafts, Anythin, Get in touch, Request Consultation, Projects delivered, Lightning fast.",
].join(" ");

const cacheDir = path.join(config.dataDir, "bench", "voice-audio");
fs.mkdirSync(cacheDir, { recursive: true });

for (const voice of voices) {
  for (const u of UTTERANCES) {
    let audio: Buffer, mime: string;
    if (dir) {
      const hit = ["webm", "mp3", "wav", "m4a", "ogg"].map((e) => path.join(dir, `${u.n}.${e}`)).find((p) => fs.existsSync(p));
      if (!hit) { console.log(`  ${String(u.n).padStart(2)}  (no recording for this line in ${dir}, skipped)`); continue; }
      audio = fs.readFileSync(hit);
      mime = { webm: "audio/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/m4a", ogg: "audio/ogg" }[path.extname(hit).slice(1)] ?? "audio/webm";
    } else {
      // Synthesised once per (line, voice) and cached, so repeated runs measure the transcriber, not the TTS.
      const file = path.join(cacheDir, `${u.n}-${voice}.mp3`);
      try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, await speak(u.text, voice));
      } catch (err) { console.log(`  · ${String(u.n).padStart(2)} ${voice.padEnd(7)} could not synthesise: ${(err as Error).message}`); continue; }
      audio = fs.readFileSync(file);
      mime = "audio/mpeg";
    }

    const began = Date.now();
    let heard = "";
    // One flaky request must not end the run: an unscored line is better than no report.
    try { heard = (await transcribe(audio, mime, useVocab ? VOCAB_HINT : "")).text; }
    catch (err) { console.log(`  · ${String(u.n).padStart(2)} ${voice.padEnd(7)} transcribe failed: ${(err as Error).message}`); continue; }
    const ms = Date.now() - began;

    const score = wer(u.text, heard);
    const kw = keywordsKept(u, heard);
    rows.push({ n: u.n, said: u.text, heard, wer: score.wer, lost: kw.lost, ms, voice });

    const mark = kw.lost.length ? "✗" : score.wer > 0.15 ? "~" : "✓";
    console.log(`  ${mark} ${String(u.n).padStart(2)} ${voice.padEnd(7)} WER ${(score.wer * 100).toFixed(0).padStart(3)}%  ${String(ms).padStart(5)}ms  ${kw.lost.length ? "LOST: " + kw.lost.join(", ") : ""}`);
    if (kw.lost.length || score.wer > 0.15) {
      console.log(`        said:  ${u.text}`);
      console.log(`        heard: ${heard}`);
    }
  }
}

if (!rows.length) { console.error("\nNothing was transcribed."); process.exit(1); }

const mean = rows.reduce((s, r) => s + r.wer, 0) / rows.length;
const clean = rows.filter((r) => !r.lost.length).length;
const slow = Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length);
console.log(`\n${"=".repeat(90)}`);
console.log(`source       ${dir ? `recordings in ${dir}` : `synthesised (${voices.join(", ")})`}`);
console.log(`stt model    ${info.sttModel}   language hint: ${info.language}   vocabulary hint: ${useVocab ? "ON" : "off"}`);
console.log(`mean WER     ${(mean * 100).toFixed(1)}%   over ${rows.length} utterances`);
console.log(`keywords     ${clean}/${rows.length} utterances kept every edit-deciding word`);
console.log(`latency      ${slow}ms mean per utterance`);

const worst = [...rows].sort((a, b) => b.wer - a.wer).slice(0, 5).filter((r) => r.wer > 0);
if (worst.length) {
  console.log(`\nworst lines:`);
  for (const r of worst) console.log(`  ${(r.wer * 100).toFixed(0).padStart(3)}%  "${r.said}"\n         → "${r.heard}"`);
}

const out = path.join(config.dataDir, "bench", `voice-${dir ? "recorded" : "synth"}${useVocab ? "-vocab" : ""}.json`);
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), sttModel: info.sttModel, vocab: useVocab, source: dir ?? voices, meanWer: mean, keywordsClean: clean, rows }, null, 2));
console.log(`\nsaved ${out}`);
console.log(useVocab
  ? "\nRun again WITHOUT --vocab and compare: the gap is what wiring a vocabulary hint into realtime.ts would buy."
  : "\nRun again WITH --vocab and compare: the gap is what wiring a vocabulary hint into realtime.ts would buy.");
