import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSupervisorGeneration, ensureSupervisorSchema } from "./database";

function fixture(db: Database) {
  ensureSupervisorSchema(db);
  for (const id of ["parent", "child"]) {
    db.query(`INSERT INTO sessions(id,name,workspace_id,state,created_at,updated_at,profile_id,initial_provider,initial_model)
      VALUES(?,?,?,'RUNNING','t','t','home','openai-codex','gpt-5.6-luna')`).run(id, id, "/tmp");
  }
  db.query("INSERT INTO subagents VALUES('child','parent','openai-codex','gpt-5.6-luna')").run();
  db.query(`INSERT INTO work_items(id,session_id,request_id,event_seq,text,state,available_at,created_at,updated_at)
    VALUES('task','child','request',1,'task','dispatched',0,'t','t')`).run();
  db.query("INSERT INTO thread_delegations VALUES('task','parent',NULL)").run();
  db.query("INSERT INTO events(seq,session_id,time,type,payload) VALUES(1,'child','t','user','{}'),(2,'child','t','assistant',?)")
    .run(JSON.stringify({ text: "first result" }));
}

test("completion records its outcome without inferring a result from assistant presentation events", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-result-"));
  const path = join(root, "state.sqlite3");
  let db = new Database(path);
  try {
    fixture(db);
    const fail = db.transaction(() => {
      db.query("UPDATE work_items SET state='complete' WHERE id='task'").run();
      throw new Error("crash before commit");
    });
    expect(fail).toThrow("crash before commit");
    expect(db.query("SELECT * FROM delegation_results").all()).toEqual([]);
    db.query("UPDATE work_items SET state='complete' WHERE id='task'").run();
    expect(db.query("SELECT * FROM delegation_results").all()).toEqual([
      { work_id: "task", result: "", status: "complete", error: null },
    ]);
    db.query("UPDATE delegation_results SET result='named native result' WHERE work_id='task'").run();
    db.close();
    db = new Database(path);
    ensureSupervisorSchema(db);
    beginSupervisorGeneration(db, "restarted");
    db.query("INSERT INTO events(session_id,time,type,payload) VALUES('child','t','assistant',?)")
      .run(JSON.stringify({ text: "another task's result" }));
    ensureSupervisorSchema(db);
    expect(db.query("SELECT * FROM delegation_results").all()).toEqual([
      { work_id: "task", result: "named native result", status: "complete", error: null },
    ]);
    expect(db.query("SELECT reply_work_id FROM thread_delegations WHERE work_id='task'").get()).toEqual({ reply_work_id: null });
    expect(() => db.query("UPDATE subagents SET model='gpt-6-astra' WHERE session_id='child'").run()).toThrow("immutable");
    expect(db.query("SELECT parent_session_id,model FROM subagents WHERE session_id='child'").get())
      .toEqual({ parent_session_id: "parent", model: "gpt-5.6-luna" });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoption changes pending automatic replies to steer without changing human follow-ups", () => {
  const db = new Database(":memory:");
  try {
    fixture(db);
    for (const id of ["reply", "human"]) db.query(`INSERT INTO work_items(id,session_id,request_id,event_seq,text,state,delivery,available_at,created_at,updated_at)
      VALUES(?,'parent',?,0,?,'queued','followUp',0,'t','t')`).run(id, id, id);
    db.query("UPDATE thread_delegations SET reply_work_id='reply' WHERE work_id='task'").run();
    ensureSupervisorSchema(db);
    expect(db.query("SELECT id,delivery FROM work_items WHERE session_id='parent' ORDER BY id").all()).toEqual([
      { id: "human", delivery: "followUp" }, { id: "reply", delivery: "steer" },
    ]);
  } finally { db.close(); }
});

test.each(["cancelled", "failed"])("delegation retains %s outcome rather than treating it as success", (status) => {
  const db = new Database(":memory:");
  try {
    fixture(db);
    db.query("UPDATE work_items SET state=?,last_error='operation stopped' WHERE id='task'")
      .run(status === "cancelled" ? "cancelled" : "complete");
    expect(db.query("SELECT status,error FROM delegation_results WHERE work_id='task'").get())
      .toEqual({ status, error: "operation stopped" });
  } finally { db.close(); }
});
