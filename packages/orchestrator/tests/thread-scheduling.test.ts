import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";

it("schedules indexed live custody without projecting or losing historical and held work", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-scheduling-"));
  const history = join(root, "history.jsonl");
  const transcript = '{"type":"message","message":{"role":"user","content":"retained history"}}\n';
  writeFileSync(history, transcript);
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("Synthetic reconciliation must not open sessions"); } });
  const internals = service as any;
  const db = internals.db;
  try {
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO thread(id,title,cwd,session_file,settings,admission,state,held,created_at,updated_at,metadata)
      SELECT 'history:'||i,'history',?,?,?, 'force','idle',i%2,i,i,json_object('archived',i%2,'padding',?) FROM n`)
      .run(root, history, JSON.stringify({ model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" }), "x".repeat(2048));
    const insert = db.prepare("INSERT INTO thread(id,title,cwd,session_file,settings,admission,state,held,created_at,updated_at,metadata) VALUES(?,?,?,?,?,'force',?,?,1,1,?)");
    for (const [id, state, held, metadata] of [
      ["queued", "running", 0, { laneId: "lane" }],
      ["repair", "running", 0, { laneId: "repair", execution: "root-repair" }],
      ["cancel", "running", 1, { laneId: "lane" }],
      ["retained-execution", "idle", 1, {}],
      ["retained-queue", "idle", 0, {}],
      ["held-queue", "idle", 1, {}],
    ] as const) insert.run(id, id, root, history, '{}', state, held, JSON.stringify(metadata));
    const work = db.prepare("INSERT INTO thread_work(id,thread_id,text,images,delivery,source,status,settings,created_at) VALUES(?,?,'accepted payload','[]','queue','explicit',?,'{}',1)");
    for (const id of ["queued", "retained-queue", "held-queue"]) work.run(id, id, "queued");
    work.run("retained-execution", "retained-execution", "dispatched");
    db.prepare("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES('execution','retained-execution','retained-execution','{}',1)").run();
    const before = db.prepare("SELECT * FROM thread_work ORDER BY ordinal").all();
    const wake = vi.spyOn(internals, "wake").mockImplementation(() => {});
    const halt = vi.spyOn(internals, "halt").mockResolvedValue({ ok: true });
    expect(service.runningSummary()).toEqual({ total: 3, lanes: new Map([["lane", 2], ["repair", 1]]), repairOwner: "repair" });
    await service.start();
    expect(wake.mock.calls.map(call => call[0]).sort()).toEqual(["queued", "repair", "retained-queue"]);
    expect(halt.mock.calls.map(call => call[0]).sort()).toEqual(["cancel", "retained-execution"]);
    expect(db.prepare("SELECT * FROM thread_work ORDER BY ordinal").all()).toEqual(before);
    expect(db.prepare("SELECT ended_at FROM thread_execution WHERE id='execution'").get()).toEqual({ ended_at: null });
    expect(service.get("held-queue")).toMatchObject({ held: true, pendingMessages: 1 });
    expect(service.get("history:1")).toMatchObject({ metadata: { archived: 1 }, sessionFile: history });
    expect(readFileSync(history, "utf8")).toBe(transcript);
    const page = await service.list({ limit: 100 });
    expect(page.ok && page.value.threads.length).toBe(100);
    expect(page.ok && page.value.nextCursor).toBeTruthy();
    const queries = [...internals.statements.keys()] as string[];
    for (const query of queries.filter(query => query.includes("UNION SELECT") || query.includes(" lane_id,"))) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map((row: any) => row.detail).join("\n");
      expect(plan).toContain("thread_running");
      expect(plan).not.toMatch(/SCAN t(?:\s|$)/);
      expect(plan).not.toMatch(/SCAN (?:thread|w|e)\n/);
      if (query.includes("UNION SELECT")) {
        expect(plan).toContain("thread_work_unfinished");
        expect(plan).toContain("thread_execution_active");
      }
    }
    const order = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM thread ORDER BY created_at,id").all().map((row: any) => row.detail).join("\n");
    expect(order).toContain("thread_created");
    expect(order).not.toContain("TEMP B-TREE");
    expect(db.prepare("SELECT count(*) n FROM thread").get()).toEqual({ n: 20006 });
  } finally { vi.restoreAllMocks(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
