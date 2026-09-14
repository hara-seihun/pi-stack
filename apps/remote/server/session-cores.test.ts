import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionCores } from "./session-cores";

test("Pi session custody retains children and immutable dispatches across reopening", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('new')");
    const cores = new SessionCores(db, "/state");
    expect(cores.get("existing")).toEqual({ core: "pi", stateDir: "/state/core-sessions/existing" });
    cores.create("new");
    cores.recordAgent("new", { id: "child", parentId: "root", name: "Inspect", state: "running" });
    const reopened = new SessionCores(db, "/state");
    expect(reopened.get("new").core).toBe("pi");
    expect(reopened.agents("new")[0].state).toBe("running");
    reopened.recordAgent("new", { id: "child", parentId: "root", name: "Inspect", state: "idle" });
    expect(cores.agents("new")).toHaveLength(1);
    expect(cores.agents("new")[0].state).toBe("idle");
    const payload = { type: "prompt", message: "original", images: [] };
    expect(cores.dispatch("new", "work", payload)).toEqual(payload);
    expect(reopened.dispatch("new", "work", { ...payload, message: "changed" })).toEqual(payload);
    cores.set("new", { core: "pi", stateDir: "/state/core-sessions/new/fork" });
    expect(() => cores.dispatch("new", "work", payload)).toThrow("another session generation");
    expect(cores.agents("new")).toEqual([]);
  } finally { db.close(); }
});
