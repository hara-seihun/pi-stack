import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_RECORD_BYTES, forgetIndexedContext, openIndexedContext } from "./indexed-context";
import { readRecentContextMessages } from "./recent-context-messages";

let db: Database, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "recent-context-"));
  db = new Database(join(directory, "context.sqlite"));
  db.exec(`CREATE TABLE session_contexts(session_id TEXT PRIMARY KEY,captured_at INTEGER,context TEXT);
    CREATE TABLE session_context_patches(seq INTEGER PRIMARY KEY,session_id TEXT,captured_at INTEGER,
      base_hash TEXT,target_hash TEXT,prefix_bytes INTEGER,delete_bytes INTEGER,insert_base64 TEXT);`);
});
afterEach(() => { forgetIndexedContext(db, "s"); db.close(); rmSync(directory, { recursive: true, force: true }); });
function capture(messages: any[]) {
  db.query("INSERT INTO session_contexts VALUES('s',1,?)").run(JSON.stringify({ systemPrompt: "", tools: [], messages }));
}
const text = (content: unknown) => typeof content === "string" ? content : "";
const read = (limit: number) => readRecentContextMessages(db, "s", limit, text);

test("voice reads the latest nonempty conversation messages chronologically within one scope", () => {
  capture([
    { role: "user", content: "earlier" },
    { role: "user", content: " selected user " },
    { role: "assistant", content: "selected assistant" },
    { role: "toolResult", content: "not conversation" },
    { role: "assistant", content: "  " },
  ]);
  const opened = openIndexedContext(db, "s");
  if (!opened.ok || !opened.value) throw new Error("Missing index");
  const index = opened.value, original = index.withMessageReader;
  let scopes = 0;
  index.withMessageReader = (action, revision) => { scopes++; return original(action, revision); };
  index.readMessage = () => { throw new Error("Unscoped voice read"); };
  expect(read(2)).toEqual({ ok: true, value: [
    { role: "user", text: "selected user" }, { role: "assistant", text: "selected assistant" },
  ] });
  expect(scopes).toBe(1);
  expect(read(0)).toEqual({ ok: true, value: [] });
});

test("voice has explicit missing, invalid and cumulative oversized window outcomes", () => {
  expect(read(2)).toEqual({ ok: true, value: [] });
  for (const limit of [-1, NaN, 1.5]) expect(read(limit)).toMatchObject({ ok: false, error: { code: "invalid" } });
  capture([0, 1].map(() => ({ role: "user", content: "x".repeat(CONTEXT_RECORD_BYTES / 2) })));
  expect(read(2)).toMatchObject({ ok: false, error: { code: "oversized", limit: CONTEXT_RECORD_BYTES } });
  expect(read(1).ok).toBe(true);
});
