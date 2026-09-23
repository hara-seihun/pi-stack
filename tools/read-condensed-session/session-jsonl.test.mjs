import assert from "node:assert/strict";
import test from "node:test";
import { activePath, parseSession, sessionRecords } from "pi-orchestrator/history";

test("live JSONL tolerates only an unfinished last line and retains source line numbers", () => {
  const text = '{"type":"session","id":"s"}\n\n{"type":"message","id":"a","parentId":null}\n{"type":';
  assert.equal(parseSession(text).length, 2);
  assert.deepEqual(sessionRecords(text).map(({ line }) => line), [1, 3]);
  assert.throws(() => parseSession('{"type":\n{}\n'), /line 1/);
});

test("branch selection detects missing entries and cycles instead of hanging or silently losing history", () => {
  const entries = [
    { type: "session", id: "s" },
    { type: "message", id: "a", parentId: null },
    { type: "message", id: "b", parentId: "a" },
    { type: "message", id: "c", parentId: "a" },
  ];
  assert.deepEqual(activePath(entries).map(({ id }) => id), ["a", "c"]);
  assert.deepEqual(activePath(entries, "b").map(({ id }) => id), ["a", "b"]);
  assert.throws(() => activePath(entries, "unknown"), /not found/);
  assert.throws(() => activePath([{ type: "message", id: "a", parentId: "a" }]), /Cycle/);
  assert.throws(() => activePath([{ type: "message", id: "a", parentId: "missing" }]), /Missing session parent/);
});
