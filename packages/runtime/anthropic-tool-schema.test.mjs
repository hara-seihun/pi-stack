import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { anthropicToolSchema } from "./anthropic-tool-schema.js";
import { patchAnthropicToolSchema } from "./patch-anthropic-tool-schema.mjs";

const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/anthropic-messages"));
const chunks = resolve(dirname(sdk), "../../../pi-coding-agent/dist/bundle/chunks");
const bundle = join(chunks, readdirSync(chunks).find(name => /^anthropic-messages-.*\.js$/.test(name)));
const model = { id: "claude-fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.test", reasoning: false, input: ["text"], maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const union = Type.Union([
  Type.Object({ action: Type.Literal("set"), cadenceMs: Type.Integer({ minimum: 60000 }), settings: Type.Object({ model: Type.String({ minLength: 1 }) }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel") }, { additionalProperties: false }),
]);
const tools = [
  { name: "union", parameters: union },
  { name: "intersection", parameters: Type.Intersect([Type.Object({ action: Type.Literal("set") }), Type.Object({ reason: Type.String({ minLength: 1 }) })]) },
  { name: "closed", parameters: Type.Object({ paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }) }, { additionalProperties: false }) },
  { name: "no_arguments", parameters: Type.Object({}) },
].map(tool => ({ ...tool, description: "Synthetic schema fixture" }));
const samples = [{ action: "set", cadenceMs: 60000, settings: { model: "sol" } }, { action: "cancel" }, { action: "set", cadenceMs: 1, settings: { model: "" } }, { action: "cancel", settings: "bad" }, {}, "{}"];

for (const [name, path] of [["SDK", sdk], ["bundled", bundle]]) test(`${name}: Anthropic wire schemas preserve unions, constraints and zero-argument tools`, async t => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-tool-schema-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
  const original = readFileSync(path, "utf8");
  const patched = patchAnthropicToolSchema(original);
  assert.equal(patchAnthropicToolSchema(patched), patched);
  const temporary = join(fixture, "provider.mjs");
  writeFileSync(temporary, patched.replace(/(from\s*|import\s*)(["'])(\.[^"']+)\2/g, (_match, keyword, quote, specifier) => `${keyword}${quote}${pathToFileURL(resolve(dirname(path), specifier)).href}${quote}`));
  const provider = await import(pathToFileURL(temporary).href);
  const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools });
  const before = JSON.stringify(context);
  const requests = [];
  const client = { beta: { messages: { create: params => {
    requests.push(params);
    const events = [
      { type: "message_start", message: { id: "msg_fixture", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ];
    return { asResponse: async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")) };
  } } } };
  const result = await provider.stream(model, context, { client }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(requests.length, 1);
  for (const [index, tool] of tools.entries()) {
    const wire = requests[0].tools[index].input_schema;
    assert.equal(wire.type, "object");
    for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(Object.hasOwn(wire, keyword), false, `${tool.name}: Anthropic forbids root ${keyword}`);
    assert.deepEqual(wire, JSON.parse(JSON.stringify(anthropicToolSchema(tool.parameters))));
    const originalValidator = Compile(tool.parameters), wireValidator = Compile(wire);
    for (const sample of samples) assert.equal(wireValidator.Check(sample), originalValidator.Check(sample));
  }
  assert.equal(JSON.stringify(context), before, "native tool schemas remain intact");
  assert.equal(readFileSync(path, "utf8"), original, "installed provider remains untouched");
});

test("root object normalization nests combinators without changing accepted inputs", () => {
  for (const parameters of [
    { oneOf: union.anyOf },
    { type: "object", anyOf: union.anyOf },
    { allOf: [union, { not: { required: ["forbidden"] } }] },
    { type: "object", properties: {}, additionalProperties: false, anyOf: [{ required: ["action"] }] },
    { type: "object", $defs: { action: { const: "cancel" } }, anyOf: [{ properties: { action: { $ref: "#/$defs/action" } }, required: ["action"] }] },
  ]) {
    const wire = anthropicToolSchema(parameters);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(Object.hasOwn(wire, keyword), false);
    assert.deepEqual(wire.not.not, parameters);
    for (const sample of [...samples, { action: "cancel", forbidden: true }]) {
      assert.equal(Compile(wire).Check(sample), Compile(parameters).Check(sample), JSON.stringify(sample));
    }
  }
  const object = { type: "object", properties: {}, additionalProperties: false, minProperties: 0 };
  assert.equal(anthropicToolSchema(object), object);
  assert.throws(() => anthropicToolSchema({ anyOf: [{ type: "object" }, { type: "string" }] }), /must describe an object/);
  assert.throws(() => anthropicToolSchema({}), /must describe an object/);
  assert.throws(() => anthropicToolSchema({ type: "string", anyOf: union.anyOf }), /must describe an object/);
  assert.throws(() => patchAnthropicToolSchema("function changed() {}"), /not found/);
  assert.throws(() => patchAnthropicToolSchema("function convertTools() {}\nfunction mapStopReason() {}"), /changed/);
});
