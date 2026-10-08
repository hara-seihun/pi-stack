import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchAnthropicErrorContent } from "./patch-anthropic-error-content.mjs";

const modules = process.env.PI_TEST_NODE_MODULES;
const sdk = modules ? join(modules, "@earendil-works/pi-ai/dist/api/anthropic-messages.js")
  : fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/anthropic-messages"));
for (const path of [sdk]) test("Anthropic error image conversion in SDK", () => {
  const source = patchAnthropicErrorContent(readFileSync(path, "utf8"));
  assert.equal(patchAnthropicErrorContent(source), source);
  const contentStart = source.indexOf("function convertContentBlocks(");
  const contentEnd = source.indexOf("FINE_GRAINED_TOOL_STREAMING_BETA", contentStart);
  const content = source.slice(contentStart, contentEnd).replace(/(?:const|var)\s*$/u, "");
  const resultStart = source.indexOf("function convertToolResult(msg)");
  const resultEnd = source.indexOf("function convertMessages(", resultStart);
  const convert = new Function("sanitizeSurrogates", `${content}; ${source.slice(resultStart, resultEnd)}; return convertToolResult;`)(String);
  const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
  for (const blocks of [[{ type: "text", text: "Scroll failed; screenshot saved at /tmp/screenshot.png" }, image], [image], [{ type: "text", text: "Only text" }], []]) {
    const message = { role: "toolResult", toolCallId: "tool_123", content: blocks, isError: true };
    const before = structuredClone(message);
    const converted = convert(message);
    assert.equal(converted.is_error, true);
    assert.equal(converted.tool_use_id, "tool_123");
    assert.equal(typeof converted.content, "string");
    assert.deepEqual(message, before, "wire normalization must not mutate native history");
    if (blocks.includes(image)) {
      assert.match(converted.content, /image\/png/);
      assert.match(converted.content, /preserved in native tool-result history/);
      assert.ok(!converted.content.includes(image.data), "base64 is not sent as text");
    }
    if (blocks[0]?.type === "text") assert.ok(converted.content.includes(blocks[0].text));
  }
  const success = convert({ toolCallId: "tool_123", content: [image], isError: false });
  assert.equal(success.is_error, false);
  assert.ok(success.content.some(block => block.type === "image" && block.source.data === image.data));
});

test("unrecognized provider source rejects the patch", () => {
  assert.throws(() => patchAnthropicErrorContent("function changed() {}"), /not found/);
});
