import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { configuredCore, type CoreAgent, type CoreId } from "pi-orchestrator/api";

export interface SessionCore { core: CoreId; stateDir: string }
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
  recordAgent(sessionId: string, agent: CoreAgent): void {
    if (!agent?.id || !["running","idle","failed","cancelled"].includes(agent.state)) throw new Error("Invalid core agent state");
    this.db.query("INSERT INTO core_agents VALUES(?,?,?,?) ON CONFLICT(session_id,state_dir,agent_id) DO UPDATE SET data=excluded.data")
      .run(sessionId,this.get(sessionId).stateDir,agent.id,JSON.stringify(agent));
  }
  agents(sessionId: string): CoreAgent[] {
    return (this.db.query("SELECT data FROM core_agents WHERE session_id=? AND state_dir=? ORDER BY agent_id").all(sessionId,this.get(sessionId).stateDir) as {data:string}[]).map(row=>JSON.parse(row.data));
  }
}
