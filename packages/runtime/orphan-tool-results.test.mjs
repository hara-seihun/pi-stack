import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchOrphanToolResults } from "./patch-orphan-tool-results.mjs";
import { projectOrphanToolResults } from "./orphan-tool-results.mjs";

const modules = process.env.PI_TEST_NODE_MODULES;
const provider = modules ? join(modules, "@earendil-works/pi-ai/dist/api/anthropic-messages.js")
  : fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/anthropic-messages"));
const sdk = join(dirname(provider), "transform-messages.js");
const chunks = resolve(dirname(provider), "../../../pi-coding-agent/dist/bundle/chunks");
const paths = [sdk, ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name))
  .filter(path => readFileSync(path, "utf8").includes("function transformMessages("))];
assert.equal(paths.length, 3);
const model = { id: "fixture", api: "anthropic-messages", provider: "anthropic", input: ["text", "image"] };
const assistant = (ids, stopReason = "toolUse") => ({ role: "assistant", stopReason, api: model.api,
  provider: model.provider, model: model.id, content: ids.map(id => ({ type: "toolCall", id, name: "fixture", arguments: {} })), timestamp: 0 });
const receipt = (id, content = [{ type: "text", text: `genuine ${id}` }]) => ({ role: "toolResult", toolCallId: id,
  toolName: "fixture", content, isError: true, timestamp: 1, details: { operationId: "fixture-operation" } });
const source = readFileSync(provider, "utf8");
const convert = new Function("convertContentBlocks", "sanitizeSurrogates", "anthropicNarrationReplaySignature", "renderSystemMessageUpdate",
  source.slice(source.indexOf("function convertToolResult("), source.indexOf("function isAnthropicEffort(")) + "; return convertMessages;")
  (blocks => blocks, String, () => undefined, message => message.content);

for (const path of paths) test(`${path.endsWith("transform-messages.js") ? "SDK" : path.split("/").at(-1)} preserves orphan evidence and valid wire pairing`, () => {
  const original = readFileSync(path, "utf8");
  const patched = patchOrphanToolResults(original);
  assert.equal(patchOrphanToolResults(patched), patched);
  let transform;
  if (path === sdk) transform = new Function(patched.replace("export function transformMessages", "function transformMessages") + "\n; return transformMessages;")();
  else {
    const start = patched.indexOf("var NON_VISION_USER_IMAGE_PLACEHOLDER");
    const ending = "return closePendingToolCalls(),result}";
    const end = patched.indexOf(ending, patched.indexOf("function transformMessages(")) + ending.length;
    transform = new Function(readFileSync(new URL("./orphan-tool-results.mjs", import.meta.url), "utf8").replace("export function", "function")
      + "\n" + patched.slice(start, end) + "; return transformMessages;")();
  }
  const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
  const cases = [
    [assistant(["aborted"], "aborted"), receipt("aborted")],
    [assistant(["error"], "error"), receipt("error")],
    [assistant(["valid"]), receipt("unknown"), receipt("valid")],
    [assistant(["duplicate"]), receipt("duplicate"), receipt("duplicate")],
    [assistant(["late"]), { role: "user", content: "new request", timestamp: 2 }, receipt("late")],
    [assistant(["system"]), { role: "system", content: "update", timestamp: 2 }, receipt("system")],
    [receipt("image", [image, { type: "text", text: "genuine image" }])],
    [{ ...assistant(["cross|provider"]), provider: "other-provider" }, receipt("cross|provider")],
    [assistant(["null"], "aborted"), { ...receipt("null"), content: null }],
  ];
  for (const messages of cases) {
    const before = structuredClone(messages);
    const projected = transform(messages, model, id => id.replaceAll("|", "_"));
    const wire = convert(projected, false).messages;
    for (let i = 0; i < wire.length; i++) {
      const results = Array.isArray(wire[i].content) ? wire[i].content.filter(block => block.type === "tool_result") : [];
      if (!results.length) continue;
      const prior = wire[i - 1];
      assert.equal(prior?.role, "assistant");
      const calls = new Set(prior.content.filter(block => block.type === "tool_use").map(block => block.id));
      const seen = new Set();
      for (const result of results) { assert.ok(calls.has(result.tool_use_id)); assert.ok(!seen.has(result.tool_use_id)); seen.add(result.tool_use_id); }
    }
    assert.deepEqual(messages, before, "native history and genuine details stay intact");
    for (const message of messages.filter(m => m.role === "toolResult")) for (const block of message.content ?? [])
      assert.ok(projected.some(m => Array.isArray(m.content) && m.content.some(b => JSON.stringify(b) === JSON.stringify(block))));
    assert.deepEqual(projectOrphanToolResults(projected), projected);
  }
  assert.equal(readFileSync(path, "utf8"), original, "installed code is not patched by a test");
});

test("changed provider transform refuses projection patch", () => {
  assert.throws(() => patchOrphanToolResults("function transformMessages() {}"), /transform changed/);
});
