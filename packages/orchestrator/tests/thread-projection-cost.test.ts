import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ThreadService } from "../src/threads/service.js";

it("pending projections visit unfinished input, not a long completed transcript queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-projection-cost-"));
  const service = new ThreadService({ databasePath: ":memory:", sessionsDir: root,
    capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("Read projection must not start a runtime"); } });
  try {
    const settings = { model: "sol", thinkingLevel: "high" as const, speed: "standard" as const };
    expect(service.importState([{ id: "long", title: "Long", cwd: root, sessionFile: join(root, "long.jsonl"), settings, held: true }],
      Array.from({ length: 300 }, (_,i) => ({ id: `done-${i}`, threadId: "long", text: "Synthetic completed input", state: "done" as const })))).toEqual({ ok: true, value: undefined });
    expect(service.importMessage({ id: "pending", threadId: "long", text: "Synthetic pending input", state: "queued" })).toMatchObject({ ok: true });
    expect(service.get("long")?.pendingMessages).toBe(1);
    expect(await service.list({ id: "long" })).toMatchObject({ ok: true, value: { threads: [{ pendingMessages: 1 }] } });
    expect(service.snapshot()[0]?.pendingMessages).toBe(1);
    const internal = service as unknown as { db: DatabaseSync; statements: Map<string, unknown> };
    const projections = [...internal.statements.keys()].filter(sql => sql.startsWith("SELECT t.*") && sql.includes("pending_count"));
    expect(projections).toHaveLength(3);
    for (const sql of projections) {
      const args = sql.includes("WHERE id=?") ? ["long"] : sql.includes("WHERE t.id=?") ? ["long", 101] : [];
      const plan = internal.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes("w USING INDEX thread_work_unfinished"))).toBe(true);
    }
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
