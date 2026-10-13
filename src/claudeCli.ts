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
  bin: () => process.env.LC_CLAUDE_BIN || "claude",
  timeoutMs: () => Number(process.env.LC_CLAUDE_CLI_TIMEOUT_MS ?? 4 * 60_000),
  effort: () => process.env.LC_CLAUDE_EFFORT || "",
  maxToolResultChars: 60_000,
};

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const id = (p: string) => p + randomBytes(8).toString("hex");

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
    "- One block per call; several blocks = several calls in one step.",
    `- The JSON must be complete and valid: no comments, no trailing commas, no "..." placeholders, and "input" must match the tool's schema.`,
    `- Any words for the person come BEFORE the first block. Write nothing after the last ${CLOSE}.`,
    `- Never say you are "going to" call a tool, and never show a call as an example: write the block, or do not.`,
    `- Tool results come back in the next turn as "TOOL RESULT". Then continue.`,
    "- When no tool is needed, reply in plain text only (no blocks).",
    must,
    "",
    "TOOLS YOU HAVE",
    list,
    "",
  ].join("\n");
}

type Img = { mediaType: string; data: string };

const asBase64 = (d: unknown): string | null => {
  if (typeof d === "string") return d.startsWith("data:") ? d.slice(d.indexOf(",") + 1) : d;
  if (d instanceof Uint8Array) return Buffer.from(d).toString("base64");
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString("base64");
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

  const transcript = [
    `The conversation so far (oldest first). "ASSISTANT (you)" are your own earlier replies.`,
    "",
    lines.join("\n\n"),
    "",
    "## YOUR TURN",
    `Continue as the assistant: either reply to the person in plain text, or write ${OPEN} blocks for the tools you need now. Nothing else.`,
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

export function parseReply(text: string): { text: string; calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  const re = new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`, "g");
  const plain = text.replace(re, (_m, body: string) => { const c = parseCall(body); if (c) calls.push(c); return ""; }).trim();
  // Some replies are the bare JSON of a single call, with no block around it.
  if (!calls.length && /^\{[\s\S]*\}$/.test(plain)) {
    const c = parseCall(plain);
    if (c) return { text: "", calls: [c] };
  }
  return { text: plain, calls };
}

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
    return new Error(`The Claude CLI ("${DEFAULTS.bin()}") was not found on this machine. Install Claude Code, or set LC_CLAUDE_BIN to its full path.`);
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

/** Spawns the CLI in the background, feeds it stdin, and (optionally) hands every NDJSON line to onEvent. */
function run(bin: string, args: string[], stdin: string, o: RunOpts, onEvent?: (ev: any) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: scratch(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
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
  const bin = settings.bin ?? DEFAULTS.bin();
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
        const out = await run(bin, p.args, p.stdin, { timeoutMs, abortSignal: o.abortSignal });
        res = resultOf(out.stdout, out.stderr, out.code);
        if (res.is_error || res.subtype === "error_during_execution") throw cliError(String(res.result ?? res.error ?? out.stderr), out.code);
      } finally { try { fs.unlinkSync(p.file); } catch { /* best effort */ } }

      const { text, calls } = parseReply(String(res.result ?? ""));
      const content: LanguageModelV4Content[] = [];
      if (text) content.push({ type: "text", text });
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
          let open = false, held = "", full = "", errored = "";
          let usage: any = null, cost: number | undefined, stopRaw: string | undefined, sessionId: string | undefined;

          const emit = (t: string) => {
            if (!t) return;
            if (!open) { ctrl.enqueue({ type: "text-start", id: textId }); open = true; }
            ctrl.enqueue({ type: "text-delta", id: textId, delta: t });
          };
          /** Text may hold the start of a <tool_call> block: emit what is certainly plain text, keep the rest back. */
          const push = (delta: string) => {
            full += delta;
            held += delta;
            for (;;) {
              const s = held.indexOf(OPEN);
              if (s === -1) break;
              const e = held.indexOf(CLOSE, s);
              if (e === -1) { emit(held.slice(0, s)); held = held.slice(s); return; } // the block is still arriving
              emit(held.slice(0, s));
              const c = parseCall(held.slice(s + OPEN.length, e));
              if (c) calls.push(c);
              held = held.slice(e + CLOSE.length);
            }
            let keep = 0; // whatever could still grow into "<tool_call>"
            for (let k = Math.min(OPEN.length - 1, held.length); k > 0; k--) {
              if (OPEN.startsWith(held.slice(held.length - k))) { keep = k; break; }
            }
            emit(held.slice(0, held.length - keep));
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
            const out = await run(bin, p.args, p.stdin, { timeoutMs, abortSignal: o.abortSignal }, onEvent);
            if (errored) throw cliError(errored, out.code);
            if (out.code !== 0 && !full.trim() && !calls.length) throw cliError(out.stderr || "the CLI exited without an answer", out.code);
            if (held.trim()) emit(held);
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

export interface CliStatus { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string; error?: string }
let cached: { at: number; status: CliStatus } | null = null;

/** Whether this machine can answer at all: the CLI is installed and signed in (cached for 30s). */
export async function claudeCliStatus(force = false): Promise<CliStatus> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.status;
  const bin = DEFAULTS.bin();
  const status: CliStatus = { installed: false, loggedIn: false };
  try {
    const v = await run(bin, ["--version"], "", { timeoutMs: 20_000 });
    if (v.code !== 0) throw cliError(v.stderr || v.stdout, v.code);
    status.installed = true;
    status.version = v.stdout.trim().split("\n")[0]?.slice(0, 60);

    const a = await run(bin, ["auth", "status"], "", { timeoutMs: 25_000 });
    const json = a.stdout.slice(a.stdout.indexOf("{"));
    const o = JSON.parse(json);
    status.loggedIn = !!o.loggedIn;
    status.authMethod = typeof o.authMethod === "string" ? o.authMethod : undefined;
    if (!status.loggedIn) status.error = 'Not signed in. Run "claude auth login" on the backend machine.';
  } catch (e) {
    status.error = String((e as Error).message ?? e).slice(0, 300);
  }
  cached = { at: Date.now(), status };
  return status;
}
