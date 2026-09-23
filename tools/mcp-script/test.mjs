import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "./lib.mjs";

function runtime() {
  return {
    async search(args) { return { items: [{ path: "math_echo", query: args.query }] }; },
    async describe(path) { return { path, inputTypeScript: "type Input = { text: string };" }; },
    async call(path, args) {
      if (path === "fail") throw new Error("broken");
      return { path, args };
    },
    async close() {},
  };
}

test("scripts can search, call flat tools, emit, and return", async () => {
  const result = await runScript(`
    const found = await tools.search({query: "echo"});
    const called = await tools.math_echo({text: "hello"});
    emit(found.items[0].path);
    return called;
  `, { runtime: runtime(), timeoutMs: 1000 });
  assert.deepEqual(result.emitted, ["math_echo"]);
  assert.deepEqual(result.result, { ok: true, data: { path: "math_echo", args: { text: "hello" } } });
});

test("tool failures are data", async () => {
  const result = await runScript("return await tools.call('fail', {});", { runtime: runtime(), timeoutMs: 1000 });
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error.message, "broken");
});

test("timeout terminates a stuck script", async () => {
  await assert.rejects(() => runScript("await new Promise(() => {});", { runtime: runtime(), timeoutMs: 20 }), /timed out/);
});
