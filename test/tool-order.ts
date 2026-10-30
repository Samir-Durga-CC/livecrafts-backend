import assert from "node:assert/strict";
import { inOrder } from "../src/tools.js";

/**
 * The calls of one step run at the same time. A step that reverted the old testimonials and placed the new slider
 * ran both at once and the revert, landing last, wiped out the slider. Changes must land in the order asked for.
 *   node --import tsx test/tool-order.ts
 */

let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeTools() {
  const log: string[] = [];
  const tool = (name: string, ms: number) => ({
    description: name,
    execute: async (input: any) => {
      log.push(`start ${name}${input?.tag ? ` ${input.tag}` : ""}`);
      await sleep(ms);
      log.push(`end ${name}${input?.tag ? ` ${input.tag}` : ""}`);
      if (input?.fail) throw new Error(`${name} failed`);
      return { ok: true };
    },
  });
  return {
    log,
    tools: inOrder({
      revert_change: tool("revert_change", 60),
      place_component: tool("place_component", 10),
      make_change: tool("make_change", 30),
      screenshot_page: tool("screenshot_page", 10),
      inspect_element: tool("inspect_element", 20),
      no_execute: { description: "a tool the person answers" },
    }),
  };
}

await check("a revert and a placement in one step land in the order asked for", async () => {
  const { tools, log } = fakeTools();
  await Promise.all([tools.revert_change.execute({}), tools.place_component.execute({})]);
  assert.deepEqual(log, ["start revert_change", "end revert_change", "start place_component", "end place_component"]);
});

await check("a screenshot sent with a change pictures the page after it", async () => {
  const { tools, log } = fakeTools();
  await Promise.all([tools.make_change.execute({}), tools.screenshot_page.execute({})]);
  assert.ok(log.indexOf("start screenshot_page") > log.indexOf("end make_change"), log.join(", "));
});

await check("reads with no change between them still run together", async () => {
  const { tools, log } = fakeTools();
  await Promise.all([tools.inspect_element.execute({ tag: "a" }), tools.inspect_element.execute({ tag: "b" }), tools.screenshot_page.execute({})]);
  assert.deepEqual(log.slice(0, 3).map((l) => l.split(" ")[0]), ["start", "start", "start"]);
});

await check("a read asked for BEFORE a change does not wait for it", async () => {
  const { tools, log } = fakeTools();
  await Promise.all([tools.inspect_element.execute({}), tools.revert_change.execute({})]);
  assert.deepEqual(log.slice(0, 2), ["start inspect_element", "start revert_change"]);
});

await check("a failed change neither blocks the next one nor hides its own error", async () => {
  const { tools, log } = fakeTools();
  const [a, b] = await Promise.allSettled([tools.make_change.execute({ fail: true }), tools.place_component.execute({})]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
  assert.ok(log.indexOf("start place_component") > log.indexOf("end make_change"));
});

await check("tools without execute are left as they are", async () => {
  const { tools } = fakeTools();
  assert.equal((tools as any).no_execute.execute, undefined);
  assert.equal((tools as any).no_execute.description, "a tool the person answers");
});

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("tool order: all checks passed");
