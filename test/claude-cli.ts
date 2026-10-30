import assert from "node:assert/strict";
import { asBase64, claudeCliModel, claudeCliStatus, parseReply } from "../src/claudeCli.js";
import { PROVIDER_IDS, parseModelSpec, providerStatus, resolveModel } from "../src/models.js";
import { secrets } from "../src/secrets.js";

/**
 * The Claude CLI provider: parsing its replies (offline), and - when the CLI on this machine is signed in - one real
 * call with a tool, to prove the loop works end to end.
 *   node --import tsx test/claude-cli.ts
 */

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
};

console.log("images reaching the CLI");

// vision.ts hands an image over as { type: "data", data: <bytes> }. That shape used to fall through to "a URL the
// CLI cannot fetch", so every screenshot the agent took was silently dropped and it was told the picture had only
// arrived as a link.
check("bytes wrapped by vision.ts are attached", () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  assert.equal(asBase64({ type: "data", data: bytes }), Buffer.from(bytes).toString("base64"));
});
check("raw bytes are attached", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(asBase64(bytes), Buffer.from(bytes).toString("base64"));
});
check("a data: URL keeps only its payload", () => {
  assert.equal(asBase64("data:image/png;base64,AAEC"), "AAEC");
});
check("a real URL is still reported as not attachable", () => {
  assert.equal(asBase64(new URL("https://example.com/shot.png")), null);
});

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

check("a wrong or mismatched tag still counts as a call", () => {
  for (const s of ['<call>{"name":"a","input":{}}</tool_call>', '<tool-call>{"name":"a","input":{}}</tool-call>', '<toolcall>{"name":"a","input":{}}</call>']) {
    const r = parseReply(s);
    assert.deepEqual(r.calls, [{ name: "a", input: {} }], `tag not understood: ${s}`);
    assert.equal(r.text, "");
  }
});

check("a block whose closing tag never came is still a call", () => {
  const r = parseReply('Looking it up.\n<tool_call>{"name":"site_history","input":{"limit":10}}');
  assert.deepEqual(r.calls, [{ name: "site_history", input: { limit: 10 } }]);
  assert.equal(r.text, "Looking it up.");
});

// The failure seen on the staging site: the model wrote the call, then invented the result and reported success.
check("invented tool results and the success claim after them are dropped", () => {
  const r = parseReply([
    '<call>{"name":"site_history","input":{"limit":10}}</tool_call>',
    "",
    "## TOOL RESULTS",
    'TOOL RESULT (site_history): {"ok":true,"changes":[]}',
    "",
    "Done! Both changes are drafts and passed verification on desktop, tablet and mobile.",
  ].join("\n"));
  assert.equal(r.calls.length, 1, "the real call was lost");
  assert.ok(!/Done!/.test(r.text), "the model's fake success claim reached the person");
  assert.ok(!/TOOL RESULT/.test(r.text), "invented tool output reached the person");
});

check("a reply that only continues the transcript says nothing at all", () => {
  const r = parseReply("## USER\nhi\n## ASSISTANT (you)\nAll done, the heading is changed.");
  assert.equal(r.text, "");
  assert.equal(r.calls.length, 0);
});

check("a malformed call is reported, never passed off as an answer", () => {
  const r = parseReply('<tool_call>{"name":"t","input":{oops}}</tool_call>');
  assert.equal(r.broken, 1);
  assert.equal(r.calls.length, 0);
});

check("ordinary text with a '#' heading is left alone", () => {
  const r = parseReply("Here is the plan:\n\n## What I will change\n- the heading\n");
  assert.match(r.text, /What I will change/);
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

check("every provider id parses back to itself", () => {
  for (const id of PROVIDER_IDS) assert.deepEqual(parseModelSpec(`${id}:some-model`), { provider: id, model: "some-model" });
  // No prefix still means what it used to: a bare name is OpenAI, "vendor/model" is the gateway.
  assert.deepEqual(parseModelSpec("gpt-5.5"), { provider: "openai", model: "gpt-5.5" });
  assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-5.5"), { provider: "gateway", model: "anthropic/claude-sonnet-5.5" });
});

await (async () => {
  const st = await providerStatus();
  check("every provider says whether it is ready, and what to do when it is not", () => {
    for (const p of st) {
      assert.equal(typeof p.ready, "boolean", `${p.id} has no ready flag`);
      assert.equal(p.configured, p.ready, `${p.id}: configured and ready disagree`);
      assert.ok(p.models.length, `${p.id} offers no model names`);
      if (!p.ready) assert.ok(p.fix && p.reason, `${p.id} is not ready but does not say what to do`);
    }
  });

  check("a model name added by hand joins that provider's list, and leaves it again", () => {
    const before = secrets.providerModels("openai");
    try {
      const added = secrets.addProviderModel("openai", "a-model-that-did-not-exist-yet");
      assert.ok(added.includes("a-model-that-did-not-exist-yet"));
      assert.equal(added.filter((m) => m === "a-model-that-did-not-exist-yet").length, 1, "added twice");
      assert.ok(!secrets.removeProviderModel("openai", "a-model-that-did-not-exist-yet").includes("a-model-that-did-not-exist-yet"));
    } finally {
      for (const m of secrets.providerModels("openai")) if (!before.includes(m)) secrets.removeProviderModel("openai", m);
    }
  });
})();

/* ---------------------------------------------------- live, only when the CLI is signed in */

const live = async () => {
  const status = await claudeCliStatus(true);
  console.log(`the CLI on this machine: ${JSON.stringify(status)}`);
  if (!status.ready) {
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

  // Step 2 of a real loop: the transcript now holds a call AND its result. This is where the model used to continue
  // the transcript and report work it never did.
  // It is checked on the model we recommend; haiku is reported as well, because it is the one that fabricated, and it
  // is still the weakest link - a warning here is the reason the UI should be left on sonnet.
  const step2 = async (name: string) => {
  const weak: any = claudeCliModel(name);
  const second = await weak.doGenerate({
    prompt: [
      { role: "system", content: "You are a careful WordPress editor. Every change must go through a tool." },
      { role: "user", content: [{ type: "text", text: "Change the h2 on https://x.test/p/ to \"Hello\"." }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "get_page_map", input: { url: "https://x.test/p/" } }] },
      {
        role: "tool", content: [{
          type: "tool-result", toolCallId: "c1", toolName: "get_page_map",
          output: { type: "json", value: { ok: true, elements: [{ id: "7f2a", type: "heading", text: "Old title" }] } },
        }],
      },
    ],
    tools: [{
      type: "function", name: "make_change", description: "Changes one thing on the site. Needs the element id, the new value and a reason.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, value: { type: "string" }, reason: { type: "string" } },
        required: ["id", "value", "reason"], additionalProperties: false,
      },
    }],
  });
    const text2 = second.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const calls2 = second.content.filter((c: any) => c.type === "tool-call");
    const invented = /TOOL RESULT|## (USER|ASSISTANT|TOOL)/i.test(text2);
    const claimed = !calls2.length && /\b(done|changed|updated|applied|added)\b/i.test(text2);
    console.log(`  step 2 (${name}): ${calls2.length} call(s)${invented ? " INVENTED RESULTS" : ""}${claimed ? " CLAIMED WORK WITHOUT CALLING" : ""}, text "${text2.replace(/\s+/g, " ").slice(0, 80)}"`);
    return { invented, claimed, calls: calls2.length };
  };

  const good = await step2(process.env.LC_CLAUDE_TEST_MODEL || "sonnet");
  assert.ok(!good.invented, "the model wrote its own tool results again");
  assert.ok(!good.claimed, "the model claimed the change was made without calling a tool");

  const weakest = await step2("haiku");
  if (weakest.invented || weakest.claimed) {
    console.log("  NOTE haiku is unreliable at prompted tool calling (it reported work it had not done). Keep the UI on sonnet.");
  }
  assert.ok(streamed.trim().length > 0, "nothing streamed");
  assert.ok(!streamed.includes("<tool_call>"), "a tool-call block leaked into the text");
  assert.ok(streamCalls >= 1, "no tool call came out of the stream");
};

await live().catch((e) => { failed++; console.error(`  FAIL live call: ${(e as Error).message}`); });

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
