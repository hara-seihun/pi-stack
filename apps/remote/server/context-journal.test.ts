import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSupervisorSchema } from "./database";
import { appendContextPatch, readContext } from "./context-journal";
import { contextSplice } from "./sync";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  ensureSupervisorSchema(db);
  db.query("INSERT INTO thread_views(id) VALUES('s')").run();
});
afterEach(() => db.close());

function initial(document: string) {
  db.query("INSERT INTO session_contexts(session_id,captured_at,context) VALUES('s',1,?)").run(document);
  return readContext(db, "s")!;
}
function patchCount() {
  return (db.query("SELECT COUNT(*) AS n FROM session_context_patches").get() as { n: number }).n;
}

test("many small captures checkpoint and restore the exact latest document", () => {
  const prefix = "unchanged image:" + "A".repeat(200_000);
  let current = initial(prefix);
  for (let i = 2; i <= 70; i++) {
    const target = `${prefix}\nMessage ${i} 日本 🌙`;
    const result = appendContextPatch(db, "s", current, i, contextSplice(current.document, target));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    current = result.value;
    expect(readContext(db, "s")).toEqual(current);
    expect(patchCount()).toBeLessThan(32);
  }
  expect((db.query("SELECT captured_at FROM session_contexts").get() as { captured_at: number }).captured_at).toBeGreaterThan(1);
});

test("a large insertion checkpoints immediately rather than retaining an oversized journal", () => {
  const current = initial("A".repeat(100_000));
  const target = current.document + "B".repeat(2 * 1024 * 1024);
  const result = appendContextPatch(db, "s", current, 2, contextSplice(current.document, target));
  expect(result.ok).toBe(true);
  expect(patchCount()).toBe(0);
  expect(readContext(db, "s")?.document).toBe(target);
});

test("damaged patches and failed checkpoints leave the committed context intact", () => {
  let current = initial("A".repeat(100_000));
  const first = appendContextPatch(db, "s", current, 2, contextSplice(current.document, current.document + "ok"));
  if (!first.ok) throw new Error(first.error);
  current = first.value;
  const splice = contextSplice(current.document, "replacement");
  expect(appendContextPatch(db, "s", current, 3, { ...splice, targetHash: "corrupt" }).ok).toBe(false);
  expect(readContext(db, "s")).toEqual(current);
  db.exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON session_contexts BEGIN SELECT RAISE(ABORT,'disk write rejected'); END;");
  const target = "B".repeat(100_000);
  expect(appendContextPatch(db, "s", current, 3, contextSplice(current.document, target)).ok).toBe(false);
  expect(patchCount()).toBe(1);
  expect(readContext(db, "s")).toEqual(current);
});
