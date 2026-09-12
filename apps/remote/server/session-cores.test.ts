import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SessionCores } from "./session-cores";

test("existing threads stay on Pi while new core selections and child state survive reopening", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('existing'),('new');");
    const cores = new SessionCores(db,"/state");
    expect(cores.get("existing")).toEqual({core:"pi",stateDir:"/state/core-sessions/existing"});
    cores.create("new","codex");
    cores.recordAgent("new",{id:"child",parentId:"root",name:"Inspect",state:"running"});
    const reopened = new SessionCores(db,"/state");
    expect(reopened.get("new").core).toBe("codex");
    expect(reopened.agents("new")[0].state).toBe("running");
    reopened.recordAgent("new",{id:"child",parentId:"root",name:"Inspect",state:"idle"});
    expect(cores.agents("new")).toHaveLength(1);
    expect(cores.agents("new")[0].state).toBe("idle");
  } finally { db.close(); }
});
