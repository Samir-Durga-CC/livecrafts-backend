import assert from "node:assert/strict";
import { claudeCliModel, claudeCliStatus, parseReply } from "../src/claudeCli.js";
import { parseModelSpec, resolveModel } from "../src/models.js";

/**
 * The Claude CLI provider: parsing its replies (offline), and - when the CLI on this machine is signed in - one real
 * call with a tool, to prove the loop works end to end.
 *   node --import tsx test/claude-cli.ts
 */

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
};

console.log("parsing the CLI's replies");

check("plain text stays text", () => {
  const r = parseReply("Done: the heading now reads \"Hello\".");
  assert.equal(r.calls.length, 0);
  assert.match(r.text, /^Done/);
});

check("a tool call is taken out of the text", () => {
  const r = parseReply('Let me look first.\n<tool_call>{"name":"get_page_map","input":{"url":"https://x.test/"}}</tool_call>');
  assert.equal(r.text, "Let me look first.");
  assert.deepEqual(r.calls, [{ name: "get_page_map", input: { url: "https://x.test/" } }]);
});

check("several calls in one step", () => {
  const r = parseReply('<tool_call>{"name":"a","input":{}}</tool_call><tool_call>{"name":"b","input":{"n":2}}</tool_call>');
  assert.deepEqual(r.calls.map((c) => c.name), ["a", "b"]);
  assert.equal(r.text, "");
});

check("fenced JSON inside the block, and other argument names", () => {
  const r = parseReply('<tool_call>\n```json\n{"name":"find_text","arguments":{"text":"hi"}}\n```\n</tool_call>');
  assert.deepEqual(r.calls, [{ name: "find_text", input: { text: "hi" } }]);
});

check("stringified arguments are parsed", () => {
  const r = parseReply('<tool_call>{"name":"t","input":"{\\"a\\":1}"}</tool_call>');
  assert.deepEqual(r.calls[0].input, { a: 1 });
});

check("a bare call object with no block", () => {
  const r = parseReply('{"name":"site_status","input":{}}');
  assert.deepEqual(r.calls, [{ name: "site_status", input: {} }]);
  assert.equal(r.text, "");
});

check("broken JSON is left as text, not a half call", () => {
  const r = parseReply('<tool_call>{"name":"t","input":{oops}}</tool_call>');
  assert.equal(r.calls.length, 0);
});

check("text that only mentions a tool is not a call", () => {
  const r = parseReply("I will call get_page_map next.");
  assert.equal(r.calls.length, 0);
});

console.log("the provider registry");

check('"claudecli:sonnet" resolves without any API key', () => {
  assert.deepEqual(parseModelSpec("claudecli:sonnet"), { provider: "claudecli", model: "sonnet" });
  const m: any = resolveModel("claudecli:sonnet");
  assert.equal(m.specificationVersion, "v4");
  assert.equal(m.provider, "claude-cli");
  assert.equal(m.modelId, "sonnet");
});

/* ---------------------------------------------------- live, only when the CLI is signed in */

const live = async () => {
  const status = await claudeCliStatus(true);
  console.log(`the CLI on this machine: ${JSON.stringify(status)}`);
  if (!status.installed || !status.loggedIn) {
    console.log('  skipped the live call: run "claude auth login" first.');
    return;
  }

  const model: any = claudeCliModel(process.env.LC_CLAUDE_TEST_MODEL || "sonnet");
  const t0 = Date.now();
  const plain = await model.doGenerate({
    prompt: [
      { role: "system", content: "You are a terse test fixture. Answer in as few words as possible." },
      { role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] },
    ],
  });
  const text = plain.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  console.log(`  doGenerate: "${text.trim()}" in ${Date.now() - t0}ms, ${plain.usage.inputTokens.total} in / ${plain.usage.outputTokens.total} out`);
  assert.match(text, /OK/i);

  // A real tool call: the model must answer with a block, which we must get back as a tool call.
  const withTool = await model.doGenerate({
    prompt: [
      { role: "system", content: "You help with a website. Use a tool when one fits." },
      { role: "user", content: [{ type: "text", text: "What does the home page of https://example.test/ contain? Look it up." }] },
    ],
    tools: [{
      type: "function", name: "read_page", description: "Reads a page of the site and returns its text.",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "The page URL" } }, required: ["url"], additionalProperties: false },
    }],
  });
  const calls = withTool.content.filter((c: any) => c.type === "tool-call");
  console.log(`  tool step: ${calls.length} call(s) ${JSON.stringify(calls.map((c: any) => [c.toolName, c.input]))}`);
  assert.ok(calls.length >= 1, "the CLI did not ask for the tool");
  assert.equal(calls[0].toolName, "read_page");
  assert.equal(withTool.finishReason.unified, "tool-calls");
  assert.ok(JSON.parse(calls[0].input).url.includes("example.test"), "the call carried the wrong url");

  // Streaming: the same answer, in parts, with the blocks held back out of the text.
  const { stream } = await model.doStream({
    prompt: [
      { role: "system", content: "You help with a website." },
      { role: "user", content: [{ type: "text", text: "Say one short sentence about WordPress, then read https://example.test/ with the tool." }] },
    ],
    tools: [{
      type: "function", name: "read_page", description: "Reads a page of the site and returns its text.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    }],
  });
  let streamed = "", streamCalls = 0, finish = "";
  for await (const part of stream as any) {
    if (part.type === "text-delta") streamed += part.delta;
    if (part.type === "tool-call") streamCalls++;
    if (part.type === "finish") finish = part.finishReason.unified;
    if (part.type === "error") throw part.error;
  }
  console.log(`  doStream: ${streamed.length} chars of text, ${streamCalls} call(s), finish "${finish}"`);
  assert.ok(streamed.trim().length > 0, "nothing streamed");
  assert.ok(!streamed.includes("<tool_call>"), "a tool-call block leaked into the text");
  assert.ok(streamCalls >= 1, "no tool call came out of the stream");
};

await live().catch((e) => { failed++; console.error(`  FAIL live call: ${(e as Error).message}`); });

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
