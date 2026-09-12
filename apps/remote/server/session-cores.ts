import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { configuredCore, type CoreAgent, type CoreId } from "pi-orchestrator/api";

export interface SessionCore { core: CoreId; stateDir: string }
export interface CoreDispatch { type: string; message: string; images: unknown[] }
export class SessionCores {
  constructor(private readonly db: Database, private readonly data: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_cores (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      core TEXT NOT NULL CHECK(core IN ('pi','codex')),
      state_dir TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS core_agents (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      state_dir TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY(session_id,state_dir,agent_id)
    );
    CREATE TABLE IF NOT EXISTS core_dispatches (
      work_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      state_dir TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS core_switches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      time TEXT NOT NULL,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT
    );`);
  }
  get(sessionId: string): SessionCore {
    const row = this.db.query("SELECT core,state_dir FROM session_cores WHERE session_id=?").get(sessionId) as {core:string;state_dir:string} | null;
    return row ? {core: configuredCore(row.core),stateDir:row.state_dir} : {core:"pi",stateDir:join(this.data,"core-sessions",sessionId)};
  }
  set(sessionId: string, value: SessionCore): void {
    this.db.query("INSERT INTO session_cores(session_id,core,state_dir) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET core=excluded.core,state_dir=excluded.state_dir")
      .run(sessionId,value.core,value.stateDir);
  }
  create(sessionId: string, core: CoreId): void {
    this.set(sessionId,{core,stateDir:join(this.data,"core-sessions",sessionId)});
  }
  started(sessionId: string): void {
    const current = this.get(sessionId);
    this.db.transaction(() => {
      const pending = this.db.query("SELECT id,target FROM core_switches WHERE session_id=? AND state='starting'").all(sessionId) as {id:string;target:string}[];
      for (const operation of pending) {
        const target = JSON.parse(operation.target) as SessionCore;
        const complete = target.core === current.core && target.stateDir === current.stateDir;
        this.db.query("UPDATE core_switches SET state=?,error=? WHERE id=?")
          .run(complete ? "complete" : "failed",complete ? null : "Switch interrupted before target selection; source core retained",operation.id);
      }
    })();
  }
  dispatch(sessionId: string, workId: string, payload: CoreDispatch): CoreDispatch {
    const stateDir = this.get(sessionId).stateDir;
    return this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO core_dispatches VALUES(?,?,?,?)").run(workId,sessionId,stateDir,JSON.stringify(payload));
      const row = this.db.query("SELECT session_id,state_dir,payload FROM core_dispatches WHERE work_id=?").get(workId) as {session_id:string;state_dir:string;payload:string};
      if (row.session_id !== sessionId || row.state_dir !== stateDir) throw new Error("Core dispatch belongs to another session generation");
      return JSON.parse(row.payload) as CoreDispatch;
    })();
  }
  recordAgent(sessionId: string, agent: CoreAgent): void {
    if (!agent?.id || !["running","idle","failed","cancelled"].includes(agent.state)) throw new Error("Invalid core agent state");
    this.db.query("INSERT INTO core_agents VALUES(?,?,?,?) ON CONFLICT(session_id,state_dir,agent_id) DO UPDATE SET data=excluded.data")
      .run(sessionId,this.get(sessionId).stateDir,agent.id,JSON.stringify(agent));
  }
  agents(sessionId: string): CoreAgent[] {
    return (this.db.query("SELECT data FROM core_agents WHERE session_id=? AND state_dir=? ORDER BY agent_id").all(sessionId,this.get(sessionId).stateDir) as {data:string}[]).map(row=>JSON.parse(row.data));
  }
}
