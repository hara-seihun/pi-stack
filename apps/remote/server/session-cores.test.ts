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
    const payload = {type:"steer",message:"Original input",images:[]};
    expect(cores.dispatch("new","work",payload)).toEqual(payload);
    expect(reopened.dispatch("new","work",{...payload,type:"prompt",message:"Rebuilt input"})).toEqual(payload);
    const source = cores.get("new"), target = {core:"pi" as const,stateDir:"/state/core-sessions/new/switch"};
    db.query("INSERT INTO core_switches VALUES(?,?,?, ?,?,'starting',NULL)")
      .run("interrupted","new","now",JSON.stringify(source),JSON.stringify(target));
    cores.started("new");
    expect(db.query("SELECT state FROM core_switches WHERE id='interrupted'").get()).toEqual({state:"failed"});
    db.query("INSERT INTO core_switches VALUES(?,?,?, ?,?,'starting',NULL)")
      .run("selected","new","now",JSON.stringify(source),JSON.stringify(target));
    cores.set("new",target);
    expect(() => cores.dispatch("new","work",payload)).toThrow("another session generation");
    expect(cores.agents("new")).toEqual([]);
    cores.started("new");
    expect(db.query("SELECT state FROM core_switches WHERE id='selected'").get()).toEqual({state:"complete"});
  } finally { db.close(); }
});
