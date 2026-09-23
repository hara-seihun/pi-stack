import { test } from "node:test";
import assert from "node:assert/strict";
import { findCutPoint } from "@earendil-works/pi-coding-agent";

const entries = [
  { role: "user", content: "u".repeat(2000), timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "call", name: "probe", arguments: {} }], timestamp: 2 },
  { role: "toolResult", toolCallId: "call", toolName: "probe", content: [{ type: "text", text: "r".repeat(400) }], isError: false, timestamp: 3 },
].map((message, index) => ({ type: "message", id: String(index), parentId: index ? String(index - 1) : null, timestamp: new Date(index).toISOString(), message }));

test("Pi keeps a trailing tool batch together", () => {
  assert.equal(findCutPoint(entries, 0, entries.length, 1).firstKeptEntryIndex, 1);
  assert.equal(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex, 1);
  assert.equal(findCutPoint(entries, 0, entries.length, 10000).firstKeptEntryIndex, 0);
});
