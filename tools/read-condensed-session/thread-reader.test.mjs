import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listThreads, renderThread, resolveThread } from "./thread-reader.mjs";

const rows = [
  { id: "aaaaaaaa-0000", name: "Build runtime", state: "stopped", updated_at: "2026-08-29T10:00:00Z" },
  { id: "bbbbbbbb-0000", name: "Build runtime", state: "running", updated_at: "2026-08-30T10:00:00Z" },
  { id: "cccccccc-0000", name: "Fix storage", state: "stopped", updated_at: "2026-08-28T10:00:00Z" },
];

test("thread selectors prefer ids and the newest exact title", () => {
  assert.equal(resolveThread(rows, "cccc").id, "cccccccc-0000");
  assert.equal(resolveThread(rows, "Build runtime").id, "bbbbbbbb-0000");
  assert.equal(resolveThread(rows, "storage").id, "cccccccc-0000");
  assert.throws(() => resolveThread(rows, "b"), /ambiguous/);
});

test("thread listing is newest first", () => {
  const output = listThreads(rows);
  assert.ok(output.indexOf("bbbbbbbb") < output.indexOf("aaaaaaaa"));
});

test("default rendering follows the active branch without successful results", () => {
  const root = mkdtempSync(join(tmpdir(), "read-thread-"));
  const session = join(root, "session.jsonl");
  const entries = [
    { type: "session", id: "session", cwd: "/tmp", timestamp: "2026-08-30T10:00:00Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-30T10:01:00Z", message: { role: "user", content: [{ type: "text", text: "Fix it" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-30T10:02:00Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private details" }, { type: "toolCall", name: "bash", arguments: { command: "make" } }] } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-08-30T10:03:00Z", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "large successful output" }], isError: false } },
    { type: "message", id: "abandoned", parentId: "u1", timestamp: "2026-08-30T10:04:00Z", message: { role: "assistant", content: [{ type: "text", text: "wrong branch" }] } },
    { type: "message", id: "a2", parentId: "r1", timestamp: "2026-08-30T10:05:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
  ];
  writeFileSync(session, `${entries.map(JSON.stringify).join("\n")}\n`);
  const row = { id: "thread-id", name: "Test thread", updated_at: "2026-08-30T10:05:00Z", session_path: session };
  const ordinary = renderThread(row);
  assert.match(ordinary, /Fix it/);
  assert.match(ordinary, /tool bash/);
  assert.match(ordinary, /Done/);
  assert.doesNotMatch(ordinary, /private details|large successful output|wrong branch/);
  const work = renderThread(row, { work: true });
  assert.match(work, /private details/);
  assert.match(work, /large successful output/);
});
