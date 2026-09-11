import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { subagentPage, threadPage } from "./thread-pages.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT,name TEXT,state TEXT,created_at TEXT,archived_at TEXT);
    CREATE TABLE subagents(session_id TEXT,parent_session_id TEXT,model TEXT);
    CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id TEXT,type TEXT,time TEXT,payload TEXT);`);
  return db;
}

test("subagent pages use message recency, stable snapshots, direct ownership and explicit idle inclusion", () => {
  const db = database();
  try {
    for (const [id, state, parent, archived] of [["a", "RUNNING", "root", null], ["b", "IDLE", "root", null], ["c", "STOPPED", "root", "2026-01-01"], ["nested", "RUNNING", "a", null]]) {
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, id, state, "2025-01-01", archived);
      db.prepare("INSERT INTO subagents VALUES(?,?,?)").run(id, parent, "luna");
    }
    const event = db.prepare("INSERT INTO events VALUES(?,?,?,?,?)");
    event.run(1, "c", "assistant", "2025-01-02", "{}");
    event.run(2, "a", "user", "2025-01-03", "{}");
    event.run(3, "b", "assistant", "2025-01-04", "{}");
    event.run(4, "a", "state", "2025-01-05", "{}");
    assert.deepEqual(subagentPage(db, "root").subagents.map(row => row.threadId), ["a"]);
    const first = subagentPage(db, "root", { includeIdle: true, limit: 1 });
    assert.deepEqual(first.subagents.map(row => row.threadId), ["b"]);
    event.run(5, "c", "assistant", "2025-01-06", "{}");
    const second = subagentPage(db, "root", { includeIdle: true, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.subagents.map(row => row.threadId), ["a"]);
    const third = subagentPage(db, "root", { includeIdle: true, limit: 1, cursor: second.nextCursor });
    assert.deepEqual(third.subagents.map(row => row.threadId), ["c"]);
    assert.equal(third.nextCursor, null);
    assert.equal(third.subagents[0].archivedAt, "2026-01-01");
    assert.throws(() => subagentPage(db, "root", { cursor: first.nextCursor }), /does not match/);
    assert.throws(() => subagentPage(db, "a", { includeIdle: true, cursor: first.nextCursor }), /does not match/);
    assert.throws(() => subagentPage(db, "root", { limit: 0 }), /Page size/);
  } finally { db.close(); }
});

test("thread pages retain branch and snapshot, and large entries can be read without lost text", () => {
  const root = mkdtempSync(join(tmpdir(), "thread-pages-"));
  const path = join(root, "session.jsonl");
  const db = database();
  const entries = [
    { type: "session", id: "session", timestamp: "2025-01-01" },
    { type: "message", id: "a", parentId: null, timestamp: "2025-01-01", message: { role: "user", content: "First" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2025-01-02", message: { role: "assistant", content: [{ type: "thinking", thinking: "omitted" }, { type: "text", text: "x".repeat(9000) }] } },
    { type: "message", id: "c", parentId: "b", timestamp: "2025-01-03", message: { role: "user", content: "Last" } },
  ];
  const save = () => writeFileSync(path, entries.map(JSON.stringify).join("\n") + "\n");
  const row = { id: "root", name: "Root", state: "IDLE", session_path: path };
  try {
    save();
    const first = threadPage(db, row, { limit: 1 });
    assert.equal(first.entries[0].entryId, "c");
    entries.push({ type: "message", id: "d", parentId: "c", timestamp: "2025-01-04", message: { role: "user", content: "New after read" } });
    save();
    const second = threadPage(db, row, { limit: 1, cursor: first.nextCursor });
    assert.equal(second.entries[0].entryId, "b");
    assert.equal(second.entries[0].truncated, true);
    let full = "", offset = 0;
    do {
      const chunk = threadPage(db, row, { entryId: "b", offset, maxChars: 1000 });
      full += chunk.text; offset = chunk.nextOffset;
    } while (offset !== null);
    assert.equal(full.match(/x/g).length, 9000);
    assert.doesNotMatch(full, /omitted/);
    assert.equal(threadPage(db, row, { cursor: second.nextCursor }).nextCursor, null);
    assert.throws(() => threadPage(db, { ...row, id: "other" }, { cursor: first.nextCursor }), /does not match/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
