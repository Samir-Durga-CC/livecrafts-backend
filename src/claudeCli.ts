import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";

/**
 * The local Claude Code CLI as a model provider ("claudecli:sonnet").
 *
 * WHY: it answers on the machine's own Claude subscription, so the agent keeps working when an API key has no credit.
 * HOW: every agent step spawns `claude --print` IN THE BACKGROUND (no terminal, no interactive session, no session
 * files): the conversation so far goes in on stdin, the answer comes back on stdout and becomes the same text /
 * tool-call parts any other provider returns - so the chat UI, approvals, checks and the ledger behave exactly as
 * they do with OpenAI, and the person sees the CLI's work in the Livecrafts UI.
 *
 * The CLI is itself a coding agent, so we take its own brain off: --system-prompt-file replaces its system prompt
 * with Livecrafts', --tools "" removes its tools, --safe-mode + --strict-mcp-config drop CLAUDE.md, skills, hooks and
 * MCP servers, and it runs in an empty scratch directory. It never touches this project - it only answers.
 *
 * Tool calling: the CLI has no function-calling API, so the tools are described in the system prompt and asked for in
 * <tool_call>{"name":...,"input":{...}}</tool_call> blocks, which we parse back into real tool calls.
 */

export const CLAUDE_CLI_MODELS = ["sonnet", "opus", "haiku", "fable"];

export interface ClaudeCliSettings {
  /** The executable. Default: LC_CLAUDE_BIN or "claude" (it must be on PATH). */
  bin?: string;
  /** How long one step may take. Default: LC_CLAUDE_CLI_TIMEOUT_MS or 4 minutes. */
  timeoutMs?: number;
  /** Thinking effort: low | medium | high | xhigh | max (LC_CLAUDE_EFFORT). */
  effort?: string;
  /** Tool results longer than this are cut in the transcript (the CLI's context is large, but not free). */
  maxToolResultChars?: number;
}

const DEFAULTS = {
  timeoutMs: () => Number(process.env.LC_CLAUDE_CLI_TIMEOUT_MS ?? 4 * 60_000),
  effort: () => process.env.LC_CLAUDE_EFFORT || "",
  maxToolResultChars: 60_000,
};

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const id = (p: string) => p + randomBytes(8).toString("hex");

/**
 * Models do not always write the tag we asked for: <call>…</tool_call>, <tool-call>…</tool-call> and friends all mean
 * the same thing, so every variant (open and close, even mismatched) counts as a call.
 */
const OPENS = ["<tool_call>", "<tool-call>", "<toolcall>", "<call>"];
const CLOSES = ["</tool_call>", "</tool-call>", "</toolcall>", "</call>"];
const CALL_RE = /<(?:tool[_-]?call|call)>([\s\S]*?)<\/(?:tool[_-]?call|call)>/gi;
const first = (list: string[], s: string, from = 0) => {
  let at = -1, len = 0;
  for (const t of list) { const i = s.indexOf(t, from); if (i !== -1 && (at === -1 || i < at)) { at = i; len = t.length; } }
  return { at, len };
};
const couldOpen = (tail: string) => OPENS.some((o) => o.startsWith(tail));
const LONGEST_OPEN = Math.max(...OPENS.map((o) => o.length));

/**
 * The transcript we send shows past turns and tool results. A model that is not careful CONTINUES that format: it
 * writes its own "TOOL RESULT (…)" with invented output and then reports success for work that never ran. Everything
 * from such a line on is thrown away - a reply may never contain a result the model wrote itself.
 */
const FABRICATED = /^\s*(?:#{1,3}\s*(?:tool results?|user|assistant|your turn)\b|tool result ?\(|approval: the person\b|the conversation so far\b|<\/?transcript>)/i;

/** Everything before the first line where the model started writing the transcript itself. */
function cutFabricated(text: string): { text: string; cut: boolean } {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FABRICATED.test(lines[i])) return { text: lines.slice(0, i).join("\n"), cut: true };
  }
  return { text, cut: false };
}

/* ------------------------------------------------------------------ the prompt */

function toolSection(tools: LanguageModelV4CallOptions["tools"], choice: LanguageModelV4CallOptions["toolChoice"]): string {
  const fns = (tools ?? []).filter((t): t is LanguageModelV4FunctionTool => t.type === "function");
  if (!fns.length) return "";
  const must = choice?.type === "required" ? "\nYou MUST make at least one tool call in this reply."
    : choice?.type === "none" ? "\nDo NOT make any tool call in this reply; answer in plain text."
    : choice?.type === "tool" ? `\nYou MUST call the tool "${choice.toolName}" in this reply.` : "";
  const list = fns.map((t) => `--- ${t.name}\n${t.description ?? ""}\ninput schema: ${JSON.stringify(t.inputSchema)}`).join("\n");
  return [
    "",
    "HOW YOU USE TOOLS (read carefully - this is the only way you can act)",
    "You cannot run anything yourself. To use a tool, write a block exactly like this:",
    `${OPEN}{"name":"tool_name","input":{ ... }}${CLOSE}`,
    `- The tag is exactly ${OPEN} … ${CLOSE}. One block per call; several blocks = several calls in one step.`,
    `- The JSON must be complete and valid: no comments, no trailing commas, no "..." placeholders, and "input" must match the tool's schema.`,
    `- Any words for the person come BEFORE the first block. Write nothing after the last ${CLOSE} - STOP there.`,
    `- Never say you are "going to" call a tool, and never show a call as an example: write the block, or do not.`,
    "- When no tool is needed, reply in plain text only (no blocks).",
    "",
    "WHAT YOU MUST NEVER DO (this is how work gets faked)",
    `- NEVER write a tool's result yourself: no "TOOL RESULT (…)", no "## TOOL RESULTS", no "## USER", no invented output of any kind.`,
    "- You CANNOT see what a call returned in this turn. The result comes back in the NEXT turn, inside the transcript.",
    "  So: write the call, stop, and wait. Anything you write after a call is a guess and will be thrown away.",
    `- NEVER tell the person something was changed, checked, verified or placed unless a real TOOL RESULT in the transcript`,
    "  shows it succeeded. If you have not called the tool yet, say what you are about to do - or just make the call.",
    must,
    "",
    "TOOLS YOU HAVE",
    list,
    "",
  ].join("\n");
}

type Img = { mediaType: string; data: string };

export const asBase64 = (d: unknown): string | null => {
  if (typeof d === "string") return d.startsWith("data:") ? d.slice(d.indexOf(",") + 1) : d;
  if (d instanceof Uint8Array) return Buffer.from(d).toString("base64");
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString("base64");
  // vision.ts hands an image over as { type: "data", data: <bytes> }, which is bytes wrapped one level deeper than
  // the shapes above. Without this the bytes fell through to "a URL the CLI cannot fetch", so every screenshot the
  // agent took was dropped and it was told the picture had only arrived as a link - while looking straight at it.
  if (d && typeof d === "object" && "data" in d) return asBase64((d as { data: unknown }).data);
  return null; // a URL: the CLI cannot fetch it, so it is reported as skipped
};

/** The AI SDK prompt becomes: the system prompt (a file), one transcript (stdin) and the recent images. */
function render(o: LanguageModelV4CallOptions, max: number) {
  const system: string[] = [];
  const lines: string[] = [];
  const images: Img[] = [];
  const warnings: SharedV4Warning[] = [];
  const cut = (s: string) => (s.length > max ? `${s.slice(0, max)}\n...[cut: ${s.length - max} more characters]` : s);
  const out = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  for (const m of o.prompt as LanguageModelV4Prompt) {
    if (m.role === "system") { system.push(m.content); continue; }

    if (m.role === "user") {
      const parts: string[] = [];
      for (const p of m.content) {
        if (p.type === "text") parts.push(p.text);
        else if (p.type === "file" && p.mediaType?.startsWith("image/")) {
          const data = asBase64(p.data);
          if (data) { images.push({ mediaType: p.mediaType, data }); parts.push(`[image ${images.length} - attached at the end of this message]`); }
          else {
            parts.push("[an image was only given as a link, so it is not attached]");
            warnings.push({ type: "unsupported", feature: "image URLs", details: "The Claude CLI provider can only attach image bytes." });
          }
        } else if (p.type === "file") parts.push(`[file ${p.filename ?? ""} (${p.mediaType}) - not attached]`);
      }
      lines.push(`## USER\n${parts.join("\n")}`);
      continue;
    }

    if (m.role === "assistant") {
      const parts: string[] = [];
      for (const p of m.content) {
        if (p.type === "text") parts.push(p.text);
        else if (p.type === "tool-call") parts.push(`${OPEN}{"name":"${p.toolName}","input":${out(p.input)}}${CLOSE}`);
        else if (p.type === "tool-result") parts.push(`TOOL RESULT (${p.toolName}): ${cut(out((p.output as any)?.value ?? p.output))}`);
      }
      if (parts.length) lines.push(`## ASSISTANT (you)\n${parts.join("\n")}`);
      continue;
    }

    // role "tool": the results of the calls in the step before, and answers to approval requests.
    const parts: string[] = [];
    for (const p of m.content) {
      if (p.type === "tool-result") {
        const r: any = p.output;
        const body = r?.type === "execution-denied" ? `the person did NOT approve this call${r.reason ? ` (${r.reason})` : ""}`
          : r?.type === "error-text" || r?.type === "error-json" ? `ERROR: ${out(r.value)}`
          : out(r?.value ?? r);
        parts.push(`TOOL RESULT (${p.toolName}): ${cut(body)}`);
      } else if (p.type === "tool-approval-response") {
        parts.push(`APPROVAL: the person ${p.approved ? "approved" : "refused"} the call${p.reason ? ` (${p.reason})` : ""}`);
      }
    }
    lines.push(`## TOOL RESULTS\n${parts.join("\n")}`);
  }

  const unsupported: [string, unknown][] = [
    ["temperature", o.temperature], ["topP", o.topP], ["topK", o.topK], ["seed", o.seed],
    ["presencePenalty", o.presencePenalty], ["frequencyPenalty", o.frequencyPenalty], ["stopSequences", o.stopSequences?.length],
  ];
  for (const [feature, v] of unsupported) {
    if (v !== undefined && v !== 0) warnings.push({ type: "unsupported", feature, details: "The Claude CLI does not take sampling settings." });
  }
  if (o.responseFormat?.type === "json") warnings.push({ type: "unsupported", feature: "responseFormat json", details: "Ask for JSON in the prompt instead." });

  // The history goes inside <transcript>…</transcript> and the instruction comes after it, so the model can tell what
  // it is reading (the past, written by us) from what it is writing (its next reply, and nothing more).
  const transcript = [
    "<transcript>",
    `Everything in here already happened (oldest first). "ASSISTANT (you)" are your own earlier replies, and every`,
    `"TOOL RESULT" is real output that was handed to you. You did not write any of it.`,
    "",
    lines.join("\n\n"),
    "</transcript>",
    "",
    `Now write ONLY your next reply: plain text for the person, and/or ${OPEN} blocks for the tools you need now.`,
    `Do not write "</transcript>", a "## …" heading, or any "TOOL RESULT" - you have not seen one yet this turn.`,
  ].join("\n");

  return { system: system.join("\n\n") + toolSection(o.tools, o.toolChoice), transcript, images, warnings };
}

/* ------------------------------------------------------------------ the answer */

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();

/** One <tool_call> body -> a real call. Tolerates the other names models use for the arguments. */
function parseCall(body: string): { name: string; input: unknown } | null {
  try {
    const o = JSON.parse(stripFence(body));
    const name = typeof o?.name === "string" ? o.name : typeof o?.tool === "string" ? o.tool : "";
    if (!name) return null;
    const raw = o.input ?? o.arguments ?? o.args ?? o.parameters ?? o.params ?? {};
    const input = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw;
    return { name, input };
  } catch { return null; }
}

/** The JSON object that starts at `from`, by counting braces (for a block whose closing tag never came). */
function objectAt(s: string, from: number): string | null {
  const start = s.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export function parseReply(raw: string): { text: string; calls: { name: string; input: unknown }[]; broken: number } {
  const { text } = cutFabricated(raw); // anything the model wrote as if it were a tool result is dropped
  const calls: { name: string; input: unknown }[] = [];
  let broken = 0;

  let plain = text.replace(CALL_RE, (_m, body: string) => {
    const c = parseCall(body);
    if (c) calls.push(c); else broken++;
    return "";
  });

  // A block whose closing tag never arrived (the model stopped, or ran out of room).
  const open = first(OPENS, plain);
  if (open.at !== -1) {
    const body = objectAt(plain, open.at + open.len);
    const c = body ? parseCall(body) : null;
    if (c) calls.push(c); else broken++;
    plain = plain.slice(0, open.at);
  }

  plain = plain.trim();
  // Some replies are the bare JSON of a single call, with no block around it.
  if (!calls.length && !broken && /^\{[\s\S]*\}$/.test(plain)) {
    const c = parseCall(plain);
    if (c) return { text: "", calls: [c], broken: 0 };
  }
  return { text: plain, calls, broken };
}

/** A malformed call must never pass as a finished answer: say so, so the step is visibly wrong instead of silently empty. */
export const brokenNote = (broken: number) =>
  `(${broken} tool call${broken === 1 ? " was" : "s were"} written in the wrong format and did NOT run - nothing was changed. Let me write ${broken === 1 ? "it" : "them"} again correctly.)`;

const usageOf = (u: any, costUsd?: number): LanguageModelV4Usage => {
  const n = (v: any) => (typeof v === "number" ? v : undefined);
  const noCache = n(u?.input_tokens) ?? 0;
  const cacheRead = n(u?.cache_read_input_tokens);
  const cacheWrite = n(u?.cache_creation_input_tokens);
  const output = n(u?.output_tokens) ?? 0;
  const think = n(u?.output_tokens_details?.thinking_tokens);
  return {
    inputTokens: { total: noCache + (cacheRead ?? 0) + (cacheWrite ?? 0), noCache, cacheRead, cacheWrite },
    outputTokens: { total: output, text: think ? Math.max(0, output - think) : output, reasoning: think },
    raw: { ...(u ?? {}), ...(costUsd !== undefined ? { total_cost_usd: costUsd } : {}) },
  };
};

/** The CLI's own errors, said in a way the person can act on. */
function cliError(msg: string, code: number | null): Error {
  const m = String(msg || "").trim();
  if (/authenticat|oauth|logged in|login|unauthorized|401/i.test(m)) {
    return new Error(`The Claude CLI is not signed in (${m.slice(0, 160)}). Run "claude auth login" on the backend machine, then try again.`);
  }
  if (/ENOENT|not recognized|no such file/i.test(m)) {
    return new Error(`The Claude Code CLI was not found on this machine. Install it from claude.com/claude-code, or set LC_CLAUDE_BIN to the full path of the executable.`);
  }
  if (/unknown option|unknown argument|unrecognized option/i.test(m)) {
    return new Error(`This Claude Code CLI is too old for Livecrafts (${m.slice(0, 120)}). Update it ("claude update", or reinstall from claude.com/claude-code) and try again.`);
  }
  if (/rate.?limit|usage limit|quota|too many requests/i.test(m)) {
    return new Error(`The Claude subscription refused for rate-limit or usage-limit reasons: ${m.slice(0, 200)}`);
  }
  return new Error(`Claude CLI failed${code !== null && code !== 0 ? ` (exit ${code})` : ""}: ${m.slice(0, 500) || "no output"}`);
}

/* ------------------------------------------------------------------ running it */

/** An empty directory to run in, so none of our CLAUDE.md, settings or project files reach the CLI. */
const scratch = () => {
  const d = path.join(os.tmpdir(), "livecrafts-claude-cli");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function baseArgs(model: string, systemFile: string, s: ClaudeCliSettings): string[] {
  const effort = s.effort ?? DEFAULTS.effort();
  return [
    "--print",
    "--model", model,
    "--system-prompt-file", systemFile,
    "--tools", "",                       // no Bash, no file tools: it only answers
    "--safe-mode",                       // no CLAUDE.md, skills, plugins, hooks, custom agents
    "--strict-mcp-config",               // no MCP servers
    "--no-session-persistence",          // nothing written to ~/.claude/projects
    "--permission-prompts", "none",      // nothing may ever wait for a human in a terminal
    ...(effort ? ["--effort", effort] : []),
  ];
}

const childEnv = () => ({ ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });

interface Run { stdout: string; stderr: string; code: number | null }
interface RunOpts { timeoutMs: number; abortSignal?: AbortSignal }

/**
 * How to start the CLI on THIS machine. The name is not enough: Claude Code installs as a native `claude.exe`
 * (the installer), as a `claude.cmd` shim (npm on Windows, which node cannot spawn directly - it needs cmd.exe),
 * or as a plain `claude` on PATH everywhere else. We find out once instead of assuming.
 */
export interface Bin { cmd: string; prefix: string[]; label: string }

const asBin = (p: string): Bin =>
  process.platform === "win32" && /\.(cmd|bat)$/i.test(p)
    ? { cmd: process.env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", p], label: p } // node cannot spawn a .cmd itself
    : { cmd: p, prefix: [], label: p };

/** Every name worth trying, best first. LC_CLAUDE_BIN, when set, is the only one: a wrong path should say so. */
const candidates = (): Bin[] => {
  const pinned = process.env.LC_CLAUDE_BIN?.trim();
  if (pinned) return [asBin(pinned)];
  return process.platform === "win32"
    ? [asBin("claude.exe"), asBin("claude"), asBin("claude.cmd")]
    : [asBin("claude")];
};

let binCache: { at: number; bin: Bin } | null = null;

/** The first candidate that answers `--version`, remembered for 5 minutes (an install can appear while we run). */
export async function resolveBin(force = false): Promise<Bin> {
  if (!force && binCache && Date.now() - binCache.at < 5 * 60_000) return binCache.bin;
  const tried: string[] = [];
  for (const bin of candidates()) {
    tried.push(bin.label);
    try {
      const v = await run(bin, ["--version"], "", { timeoutMs: 20_000 });
      if (v.code === 0 && /\d+\.\d+/.test(v.stdout)) { binCache = { at: Date.now(), bin }; return bin; }
    } catch { /* this name is not it: try the next */ }
  }
  binCache = null;
  throw new Error(`The Claude Code CLI was not found on this machine (tried: ${tried.join(", ")}). Install it from claude.com/claude-code, or set LC_CLAUDE_BIN to the full path of the executable.`);
}

/** Spawns the CLI in the background, feeds it stdin, and (optionally) hands every NDJSON line to onEvent. */
function run(bin: Bin, args: string[], stdin: string, o: RunOpts, onEvent?: (ev: any) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin.cmd, [...bin.prefix, ...args], { cwd: scratch(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    } catch (e) { return reject(cliError(String((e as Error).message), null)); }

    let stdout = "", stderr = "", buf = "", done = false;
    const kill = () => { try { child.kill(); } catch { /* already gone */ } };
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.abortSignal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => { kill(); finish(() => reject(new Error(`The Claude CLI did not answer within ${Math.round(o.timeoutMs / 1000)}s.`))); }, o.timeoutMs);
    const onAbort = () => { kill(); finish(() => reject(new Error("aborted"))); };
    if (o.abortSignal?.aborted) { kill(); return reject(new Error("aborted")); }
    o.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (!onEvent) { stdout += d; return; }
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); } catch { /* a log line, not JSON */ }
      }
    });
    child.stderr.on("data", (d: string) => { stderr += d.slice(0, 4000); });
    child.on("error", (e) => { kill(); finish(() => reject(cliError(String(e.message), null))); });
    child.on("close", (code) => finish(() => {
      if (onEvent && buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* a partial last line */ } }
      resolve({ stdout, stderr, code });
    }));

    child.stdin.on("error", () => { /* the CLI closed stdin first */ });
    child.stdin.end(stdin);
  });
}

/** stdin for the CLI: plain text, or one stream-json message when images have to go with it. */
function stdinFor(transcript: string, images: Img[]): { text: string; streamJson: boolean } {
  if (!images.length) return { text: transcript, streamJson: false };
  const content: unknown[] = [{ type: "text", text: transcript }];
  for (const im of images) content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
  return { text: `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`, streamJson: true };
}

/* ------------------------------------------------------------------ the provider */

export function claudeCliModel(modelId: string, settings: ClaudeCliSettings = {}): LanguageModelV4 {
  // Found on first use, not here: the model object is built long before a step runs, and an install (or a fixed
  // LC_CLAUDE_BIN) can appear in between.
  const bin = () => (settings.bin ? Promise.resolve(asBin(settings.bin)) : resolveBin());
  const timeoutMs = settings.timeoutMs ?? DEFAULTS.timeoutMs();
  const maxTool = settings.maxToolResultChars ?? DEFAULTS.maxToolResultChars;

  /** Writes the system prompt where the CLI can read it and builds this step's command line. */
  const prepare = (o: LanguageModelV4CallOptions, stream: boolean) => {
    const r = render(o, maxTool);
    const file = path.join(scratch(), `sys-${id("")}.txt`);
    fs.writeFileSync(file, r.system, "utf8");
    const input = stdinFor(r.transcript, r.images);
    const args = [
      ...baseArgs(modelId, file, settings),
      "--output-format", stream ? "stream-json" : "json",
      ...(stream ? ["--include-partial-messages", "--verbose"] : []),
      ...(input.streamJson ? ["--input-format", "stream-json"] : []),
    ];
    return { ...r, file, args, stdin: input.text };
  };

  /** --output-format json: one object. Older builds print a few lines with the result last. */
  const resultOf = (stdout: string, stderr: string, code: number | null) => {
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o && (o.type === "result" || typeof o.result === "string")) return o;
      } catch { /* not JSON */ }
    }
    throw cliError(stderr || stdout, code);
  };

  return {
    specificationVersion: "v4",
    provider: "claude-cli",
    modelId,
    supportedUrls: {},

    async doGenerate(o): Promise<LanguageModelV4GenerateResult> {
      const p = prepare(o, false);
      let res: any;
      try {
        const out = await run(await bin(), p.args, p.stdin, { timeoutMs, abortSignal: o.abortSignal });
        res = resultOf(out.stdout, out.stderr, out.code);
        if (res.is_error || res.subtype === "error_during_execution") throw cliError(String(res.result ?? res.error ?? out.stderr), out.code);
      } finally { try { fs.unlinkSync(p.file); } catch { /* best effort */ } }

      const { text, calls, broken } = parseReply(String(res.result ?? ""));
      const content: LanguageModelV4Content[] = [];
      const say = broken && !calls.length ? `${text}\n\n${brokenNote(broken)}`.trim() : text;
      if (say) content.push({ type: "text", text: say });
      for (const c of calls) content.push({ type: "tool-call", toolCallId: id("call_"), toolName: c.name, input: JSON.stringify(c.input ?? {}) });

      return {
        content,
        finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: res.stop_reason ?? undefined },
        usage: usageOf(res.usage, res.total_cost_usd),
        warnings: p.warnings,
        response: { id: res.session_id, modelId, timestamp: new Date() },
      };
    },

    async doStream(o) {
      // Streamed, so the chat shows the CLI's words as they arrive. The <tool_call> blocks are held back and become
      // real tool calls - they are never shown as text.
      const p = prepare(o, true);
      const textId = id("txt_");

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start: async (ctrl) => {
          ctrl.enqueue({ type: "stream-start", warnings: p.warnings });

          const calls: { name: string; input: unknown }[] = [];
          let open = false, held = "", full = "", errored = "", line = "", broken = 0;
          let fabricating = false; // the model started writing its own "tool results": everything after is dropped
          let usage: any = null, cost: number | undefined, stopRaw: string | undefined, sessionId: string | undefined;

          const emit = (t: string) => {
            if (!t) return;
            if (!open) { ctrl.enqueue({ type: "text-start", id: textId }); open = true; }
            ctrl.enqueue({ type: "text-delta", id: textId, delta: t });
          };
          /**
           * Text leaves here a whole line at a time: a line is only sent on once it cannot turn out to be the model
           * writing its own tool result (those always start a line). A half-written tag is held back too.
           */
          const feed = (t: string) => {
            if (fabricating || !t) return;
            line += t;
            for (let nl = line.indexOf("\n"); nl !== -1; nl = line.indexOf("\n")) {
              const done = line.slice(0, nl + 1);
              line = line.slice(nl + 1);
              if (FABRICATED.test(done)) { fabricating = true; line = ""; return; }
              emit(done);
            }
          };
          const flush = () => { if (!fabricating && line && !FABRICATED.test(line)) { emit(line); } line = ""; };

          /** Text may hold the start of a tool-call block: pass on what is certainly plain text, keep the rest back. */
          const push = (delta: string) => {
            full += delta;
            if (fabricating) return;
            held += delta;
            for (;;) {
              const s = first(OPENS, held);
              if (s.at === -1) break;
              const e = first(CLOSES, held, s.at + s.len);
              if (e.at === -1) { feed(held.slice(0, s.at)); held = held.slice(s.at); return; } // the block is still arriving
              feed(held.slice(0, s.at));
              const c = parseCall(held.slice(s.at + s.len, e.at));
              if (c) calls.push(c); else broken++;
              held = held.slice(e.at + e.len);
            }
            let keep = 0; // whatever could still grow into an opening tag
            for (let k = Math.min(LONGEST_OPEN - 1, held.length); k > 0; k--) {
              if (couldOpen(held.slice(held.length - k))) { keep = k; break; }
            }
            feed(held.slice(0, held.length - keep));
            held = held.slice(held.length - keep);
          };

          const onEvent = (ev: any) => {
            if (!ev || typeof ev !== "object") return;
            if (ev.type === "stream_event") {
              const e = ev.event;
              if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") push(e.delta.text);
              if (e?.type === "message_delta" && e.usage) usage = { ...(usage ?? {}), ...e.usage };
              return;
            }
            if (ev.type === "assistant" && ev.message) {
              // Builds that stream no partial messages: the whole text arrives here at once.
              if (!full) for (const b of ev.message.content ?? []) if (b?.type === "text" && typeof b.text === "string") push(b.text);
              if (ev.message.usage) usage = { ...(usage ?? {}), ...ev.message.usage };
              if (ev.message.stop_reason) stopRaw = ev.message.stop_reason;
              return;
            }
            if (ev.type === "system" && ev.session_id) sessionId = ev.session_id;
            if (ev.type === "result") {
              if (ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
              if (typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
              if (ev.stop_reason) stopRaw = ev.stop_reason;
              if (ev.is_error) errored = String(ev.result ?? ev.error ?? "the CLI reported an error");
              if (!full && typeof ev.result === "string") push(ev.result);
            }
          };

          try {
            const out = await run(await bin(), p.args, p.stdin, { timeoutMs, abortSignal: o.abortSignal }, onEvent);
            if (errored) throw cliError(errored, out.code);
            if (out.code !== 0 && !full.trim() && !calls.length) throw cliError(out.stderr || "the CLI exited without an answer", out.code);
            if (held) {
              // A block that never closed: take the call out of it by counting braces, and never show the tag as text.
              const o = first(OPENS, held);
              if (o.at === -1) feed(held);
              else {
                feed(held.slice(0, o.at));
                const body = objectAt(held, o.at + o.len);
                const c = body ? parseCall(body) : null;
                if (c) calls.push(c); else broken++;
              }
              held = "";
            }
            flush();
            if (broken && !calls.length) emit((open ? "\n\n" : "") + brokenNote(broken));
            if (open) ctrl.enqueue({ type: "text-end", id: textId });
            for (const c of calls) ctrl.enqueue({ type: "tool-call", toolCallId: id("call_"), toolName: c.name, input: JSON.stringify(c.input ?? {}) });
            ctrl.enqueue({ type: "response-metadata", id: sessionId, modelId, timestamp: new Date() });
            ctrl.enqueue({ type: "finish", usage: usageOf(usage, cost), finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: stopRaw } });
          } catch (e) {
            if (open) ctrl.enqueue({ type: "text-end", id: textId });
            ctrl.enqueue({ type: "error", error: e });
            ctrl.enqueue({ type: "finish", usage: usageOf(usage, cost), finishReason: { unified: "error", raw: stopRaw } });
          } finally {
            try { fs.unlinkSync(p.file); } catch { /* best effort */ }
            ctrl.close();
          }
        },
      });

      return { stream, request: { body: { model: modelId, args: p.args } } };
    },
  };
}

/* ------------------------------------------------------------------ is it usable? */

export interface CliStatus {
  /** The CLI answered `--version`. */
  installed: boolean;
  version?: string;
  /** It has credentials it can use right now (a subscription login, or an API key in the backend's environment). */
  loggedIn: boolean;
  /** "subscription" (claude auth login), "apiKey" / "bedrock" / "vertex" (the environment), or what the CLI reported. */
  authMethod?: string;
  /** Installed AND signed in: the only thing the rest of the app should test. */
  ready: boolean;
  /** What is wrong, in one line. */
  error?: string;
  /** The one thing the person has to do about it - shown in the UI, so keep it a command or a short instruction. */
  fix?: string;
  /** Which executable answered, so a wrong LC_CLAUDE_BIN is visible. */
  bin?: string;
}

let cached: { at: number; status: CliStatus } | null = null;

/** The CLI also runs on a key from the environment, with no `claude auth login` at all. */
function envAuth(): string | null {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  if (process.env.CLAUDE_CODE_USE_VERTEX === "1") return "vertex";
  if (process.env.ANTHROPIC_API_KEY) return "apiKey";
  if (process.env.ANTHROPIC_AUTH_TOKEN) return "authToken";
  return null;
}

/**
 * Whether this machine can answer at all (cached for 30s; `force` re-reads at once, which is what the UI's
 * "Check again" does after someone has just run `claude auth login`).
 */
export async function claudeCliStatus(force = false): Promise<CliStatus> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.status;
  const status: CliStatus = { installed: false, loggedIn: false, ready: false };
  try {
    const bin = await resolveBin(force);
    status.bin = bin.label;

    const v = await run(bin, ["--version"], "", { timeoutMs: 20_000 });
    if (v.code !== 0) throw cliError(v.stderr || v.stdout, v.code);
    status.installed = true;
    status.version = v.stdout.trim().split("\n")[0]?.slice(0, 60);

    const a = await run(bin, ["auth", "status"], "", { timeoutMs: 25_000 });
    const at = a.stdout.indexOf("{");
    const o = at === -1 ? {} : JSON.parse(a.stdout.slice(at));
    status.loggedIn = !!o.loggedIn;
    status.authMethod = typeof o.authMethod === "string" && o.authMethod !== "none" ? o.authMethod : undefined;

    if (!status.loggedIn) {
      // No subscription login, but a key in the backend's own environment works just as well.
      const env = envAuth();
      if (env) { status.loggedIn = true; status.authMethod = env; }
      else {
        status.error = "The Claude CLI is installed but not signed in.";
        status.fix = 'Run "claude auth login" on the backend machine, then press Check again.';
      }
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    status.error = msg;
    status.fix = status.installed
      ? 'Run "claude auth login" on the backend machine, then press Check again.'
      : "Install Claude Code on the backend machine (claude.com/claude-code), or set LC_CLAUDE_BIN to its full path.";
  }
  status.ready = status.installed && status.loggedIn;
  cached = { at: Date.now(), status };
  return status;
}
