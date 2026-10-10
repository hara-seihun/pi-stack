import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchAnthropicNarration } from "./patch-anthropic-narration.mjs";
import { anthropicSignatureChannel, projectAnthropicNarrationMessage } from "../orchestrator/src/threads/anthropic-narration.mjs";

const field = (number, bytes) => Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
const signature = channel => field(2, field(1, field(8, Buffer.from(channel)))).toString("base64");
const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/anthropic-messages"));
const chunks = resolve(dirname(sdk), "../../../pi-coding-agent/dist/bundle/chunks");
const bundle = join(chunks, readdirSync(chunks).find(name => /^anthropic-messages-.*\.js$/.test(name)));
const model = { id: "claude-fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.test", reasoning: true, input: ["text"], maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function events(channel, tool) {
  return [
    { type: "message_start", message: { id: "msg_fixture", model: model.id, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Exact synthetic words after tools" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: signature(channel).slice(0, 4) } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: signature(channel).slice(4) } },
    { type: "content_block_stop", index: 0 },
    ...(tool ? [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "wait", name: "thread_wait", input: { kind: "agents", threadIds: ["peer"] } } },
      { type: "content_block_stop", index: 1 },
    ] : []),
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}

for (const [name, path] of [["SDK", sdk], ["bundled", bundle]]) test(`${name}: signed narration remains text after tools and before thread_wait; signed thinking stays thinking`, async t => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-narration-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
  const original = readFileSync(path, "utf8");
  const patched = patchAnthropicNarration(original);
  assert.equal(patchAnthropicNarration(patched), patched);
  const temporary = join(fixture, "provider.mjs");
  writeFileSync(temporary, patched.replace(/(from\s*|import\s*)(["'])(\.[^"']+)\2/g, (_match, keyword, quote, specifier) => `${keyword}${quote}${pathToFileURL(resolve(dirname(path), specifier)).href}${quote}`));
  const provider = await import(pathToFileURL(temporary).href);
  for (const channel of ["narration", "thinking", "unknown"]) for (const tool of [false, true]) {
    const requests = [];
    const client = { beta: { messages: { create: params => {
      requests.push(params);
      return { asResponse: async () => new Response(events(channel, tool).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")) };
    } } } };
    const context = { messages: [
      { role: "user", content: "Synthetic prompt", timestamp: 1 },
      { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "Synthetic result" }], isError: false, timestamp: 3 },
    ] };
    const stream = provider.stream(model, context, { client });
    const received = [];
    for await (const event of stream) received.push(event.type);
    const output = await stream.result();
    assert.equal(output.stopReason, tool ? "toolUse" : "stop", output.errorMessage);
    assert.equal(output.content[0].type, channel === "narration" ? "text" : "thinking");
    assert.ok(received.includes(channel === "narration" ? "text_end" : "thinking_end"));
    if (tool) assert.equal(output.content[1].name, "thread_wait");
    const persisted = JSON.parse(JSON.stringify(output));
    if (channel === "narration") assert.equal(persisted.content[0].text, "Exact synthetic words after tools");
    const replay = provider.stream(model, { messages: [...context.messages, persisted] }, { client });
    for await (const event of replay) void event;
    const wire = requests[1].messages.find(message => message.role === "assistant" && message.content.some(block => block.signature));
    assert.equal(wire.content[0].type, "thinking", "Anthropic signed continuation representation is retained");
    assert.equal(wire.content[0].signature, signature(channel));
  }
  assert.equal(readFileSync(path, "utf8"), original, "installed provider remains untouched");
});

test("persisted projection uses only exact Anthropic channel metadata, preserves source and rejects lookalikes", () => {
  const message = { role: "assistant", api: "anthropic-messages", content: [
    { type: "thinking", thinking: "Narration", thinkingSignature: signature("narration") },
    { type: "thinking", thinking: "Thinking", thinkingSignature: signature("thinking") },
    { type: "thinking", thinking: "Ordinary words", thinkingSignature: "opaque" },
  ] };
  const before = structuredClone(message);
  const projected = projectAnthropicNarrationMessage(message);
  assert.deepEqual(projected.content.map(block => block.type), ["text", "thinking", "thinking"]);
  assert.deepEqual(message, before);
  assert.equal(projectAnthropicNarrationMessage({ ...message, api: "openai-codex-responses" }).content[0].type, "thinking");
  for (const sig of ["opaque", "!!!", signature("other"), field(2, field(1, field(9, Buffer.from("narration")))).toString("base64"), Buffer.from([18, 255, 127]).toString("base64"), Buffer.concat([field(2, field(1, field(8, Buffer.from("narration")))), field(2, field(1, field(8, Buffer.from("thinking"))))]).toString("base64")]) {
    assert.equal(anthropicSignatureChannel(sig).kind, "unrecognized");
  }
  const redacted = { ...message, content: [{ ...message.content[0], redacted: true }] };
  assert.equal(projectAnthropicNarrationMessage(redacted), redacted);
  assert.throws(() => patchAnthropicNarration("changed source"), /not found/);
});
