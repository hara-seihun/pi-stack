import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { admissionThinking, type ModelCandidate } from "./catalog.js";
import type { CompletionInput } from "./completion-contract.js";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Account, BudgetClass, FailureKind, LaneSpec, LeaseKind, ResetCreditReading, Run, RunContext, RunSource, RunState, UsageEntry, UsageTotal } from "./domain.js";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./threads/contracts.js";

import { openSqlite } from "./sqlite.js";

export const SCHEMA_VERSION = 3;
/** One broker principal's live spending grant, owned by the running model broker. */
export interface BrokerGrant { accounts: string[]; models: string[] }
const GRANT_PREFIX = "broker-grant:";
const USAGE_HOUR_SCHEMA = `
CREATE TABLE usage_hour (
  account_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  component TEXT NOT NULL CHECK (component IN ('input','output','cacheRead','cacheWrite')),
  tokens REAL NOT NULL,
  PRIMARY KEY(account_id,hour,source,run_id,model,component)
) STRICT;
CREATE INDEX usage_hour_recent ON usage_hour(hour);
`;
export const SCHEMA = `
CREATE TABLE meta (version INTEGER NOT NULL) STRICT;
INSERT INTO meta VALUES (3);
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('openai-codex','anthropic')),
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  cooldown_until INTEGER,
  concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency > 0),
  last_admitted_meter_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE meter (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  meter_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  used_percent REAL NOT NULL CHECK (used_percent >= 0 AND used_percent <= 100),
  reset_at INTEGER,
  PRIMARY KEY(account_id,meter_id,observed_at)
) STRICT;
CREATE INDEX meter_latest ON meter(account_id,meter_id,observed_at DESC);
CREATE TABLE control (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO control VALUES ('launches','enabled');
CREATE TABLE lane (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  profile TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight > 0),
  priority INTEGER NOT NULL DEFAULT 0,
  doctrine_url TEXT,
  opening_probe TEXT,
  updated_at INTEGER NOT NULL,
  admission TEXT,
  repair_readiness_command TEXT,
  thinking_level TEXT
) STRICT;
CREATE TABLE run (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('direct','lane')),
  source_id TEXT,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  profile TEXT NOT NULL,
  budget TEXT NOT NULL CHECK (budget IN ('background','force')),
  account_id TEXT REFERENCES account(id),
  provider TEXT,
  model TEXT,
  thinking TEXT,
  session_file TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','starting','running','done','failed','aborted')),
  failure_kind TEXT CHECK (failure_kind IN ('provider','account','infrastructure','operator','task')),
  result TEXT,
  worker_unit TEXT,
  release_path TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  progress_at INTEGER,
  ended_at INTEGER
) STRICT;
CREATE INDEX run_state ON run(state,created_at);
CREATE INDEX run_source ON run(source,source_id,state);
CREATE TABLE lease (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fleet','interactive','voice')),
  run_id TEXT,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
CREATE INDEX lease_active ON lease(account_id,ended_at,heartbeat_at);
${USAGE_HOUR_SCHEMA}`;

function maybe<T>(value: T | null): T | undefined { return value === null ? undefined : value; }

/** Lane columns added after the version 3 schema shipped, with the control rows they replaced. */
const LANE_COLUMNS = [["admission", "TEXT"], ["repair_readiness_command", "TEXT"], ["thinking_level", "TEXT"]] as const;

function adoptLaneColumns(db: DatabaseSync): void {
  const present = new Set((db.prepare("SELECT name FROM pragma_table_info('lane')").all() as { name: string }[]).map((column) => column.name));
  if (LANE_COLUMNS.every(([name]) => present.has(name))) return;
  for (const [name, type] of LANE_COLUMNS) if (!present.has(name)) db.exec(`ALTER TABLE lane ADD COLUMN ${name} ${type}`);
  for (const row of db.prepare("SELECT key,value FROM control WHERE key GLOB 'lane-admission:*' OR key GLOB 'lane-repair:*'").all() as { key: string; value: string }[]) {
    const separator = row.key.indexOf(":"), id = row.key.slice(separator + 1);
    if (row.key.slice(0, separator) === "lane-admission") db.prepare("UPDATE lane SET admission=? WHERE id=?").run(row.value || "force", id);
    else db.prepare("UPDATE lane SET repair_readiness_command=? WHERE id=?").run((row.value ? JSON.parse(row.value) : null)?.readinessCommand ?? null, id);
  }
  db.exec("DELETE FROM control WHERE key GLOB 'lane-admission:*' OR key GLOB 'lane-repair:*'");
}

/** Opens the ledger file itself, before anything knows which schema it holds. */
export function openLedgerDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = openSqlite(path);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  return db;
}

export class Store {
  readonly db: DatabaseSync;
  private transactionDepth=0;

  private constructor(db: DatabaseSync, readonly path: string) { this.db = db; }

  static open(path: string): Store {
    const db = openLedgerDatabase(path);
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!meta) db.exec(SCHEMA);
    const row = db.prepare("SELECT version FROM meta").get() as { version: number };
    if (row.version !== SCHEMA_VERSION) { db.close(); throw new Error(`unsupported orchestrator schema ${row.version}`); }
    db.exec("DROP TABLE IF EXISTS live_state");
    adoptLaneColumns(db);
    // Frozen subscription dollars per list-price dollar, one row per provider-hour. See person-usage.ts.
    db.exec("CREATE TABLE IF NOT EXISTS usage_rate (provider TEXT NOT NULL, hour INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY(provider,hour)) STRICT");
    return new Store(db, path === ":memory:" ? path : resolve(path));
  }

  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    const depth=this.transactionDepth++,savepoint=`orchestrator_${depth}`;
    try {
      this.db.exec(depth===0?"BEGIN IMMEDIATE":`SAVEPOINT ${savepoint}`);
      try {const result=fn();this.db.exec(depth===0?"COMMIT":`RELEASE SAVEPOINT ${savepoint}`);return result;}
      catch(error){this.db.exec(depth===0?"ROLLBACK":`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);throw error;}
    }finally{this.transactionDepth--;}
  }

  control(key: string): string | undefined {
    return maybe((this.db.prepare("SELECT value FROM control WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null);
  }
  setControl(key: string, value: string): void {
    this.db.prepare("INSERT INTO control(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value);
  }

  /** What a broker principal may spend right now. Admission reads this, never the account list a
   * queued request was submitted with: grants move between people while requests wait. */
  brokerGrant(principal: string): BrokerGrant | undefined {
    const value=this.control(`${GRANT_PREFIX}${principal}`);
    return value?JSON.parse(value) as BrokerGrant:undefined;
  }
  publishBrokerGrants(grants: readonly (BrokerGrant&{principal:string})[]): void {
    this.transaction(()=>{
      const keep=new Set(grants.map((grant)=>`${GRANT_PREFIX}${grant.principal}`));
      for(const grant of grants)this.setControl(`${GRANT_PREFIX}${grant.principal}`,JSON.stringify({accounts:grant.accounts,models:grant.models} satisfies BrokerGrant));
      const stale=(this.db.prepare("SELECT key FROM control WHERE key>=? AND key<?").all(GRANT_PREFIX,`${GRANT_PREFIX}\uffff`) as {key:string}[]).filter((row)=>!keep.has(row.key));
      for(const row of stale)this.db.prepare("DELETE FROM control WHERE key=?").run(row.key);
    });
  }

  accounts(): Account[] {
    return (this.db.prepare("SELECT * FROM account ORDER BY id").all() as any[]).map((r) => ({
      id:r.id, provider:r.provider, label:maybe(r.label), enabled:!!r.enabled,
      cooldownUntil:maybe(r.cooldown_until), concurrency:r.concurrency,
      use:this.control(`account-use:${r.id}`)==="voice"?"voice":"shared",
      reservation:JSON.parse(this.control(`account-reservation:${r.id}`)||"null")??undefined,
    }));
  }
  account(id: string): Account | undefined { return this.accounts().find((a) => a.id === id); }
  upsertAccount(input: Omit<Account,"enabled"|"concurrency"> & Partial<Pick<Account,"enabled"|"concurrency">>): void {
    this.db.prepare(`INSERT INTO account(id,provider,label,enabled,concurrency,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,label=COALESCE(excluded.label,account.label),enabled=excluded.enabled,concurrency=excluded.concurrency`)
      .run(input.id,input.provider,input.label??null,input.enabled===false?0:1,input.concurrency??1,Date.now());
  }
  setCooldown(id: string, until?: number): void { this.db.prepare("UPDATE account SET cooldown_until=? WHERE id=?").run(until??null,id); }
  setAccountEnabled(id:string,enabled:boolean):void{this.db.prepare("UPDATE account SET enabled=? WHERE id=?").run(enabled?1:0,id);}
  removeAccount(id: string): void { this.db.prepare("DELETE FROM account WHERE id=?").run(id); }

  recordMeter(accountId:string,meterId:string,usedPercent:number,resetAt:number|undefined,observedAt=Date.now()): void {
    this.db.prepare("INSERT OR IGNORE INTO meter VALUES(?,?,?,?,?)").run(accountId,meterId,observedAt,usedPercent,resetAt??null);
    this.db.prepare("DELETE FROM meter WHERE account_id=? AND meter_id=? AND observed_at<?")
      .run(accountId,meterId,observedAt-24*3_600_000);
  }
  meters(accountId?:string): any[] {
    return (accountId
      ? this.db.prepare("SELECT * FROM meter WHERE account_id=? ORDER BY observed_at DESC").all(accountId)
      : this.db.prepare("SELECT * FROM meter ORDER BY observed_at DESC").all()) as any[];
  }
  latestMeters(accountId:string): any[] {
    return this.db.prepare(`SELECT m.* FROM meter m JOIN
      (SELECT meter_id,MAX(observed_at) at FROM meter WHERE account_id=? GROUP BY meter_id) x
      ON x.meter_id=m.meter_id AND x.at=m.observed_at WHERE m.account_id=?`).all(accountId,accountId) as any[];
  }
  latestReading(accountId:string,meterId:string):{at:number;usedPercent:number;resetAt?:number}|undefined{
    const row=this.db.prepare("SELECT * FROM meter WHERE account_id=? AND meter_id=? ORDER BY observed_at DESC LIMIT 1").get(accountId,meterId) as any;
    return row?{at:row.observed_at,usedPercent:row.used_percent,resetAt:maybe(row.reset_at)}:undefined;
  }
  recordReading(accountId:string,meterId:string,reading:{at:number;usedPercent:number;resetAt?:number}):void{
    this.recordMeter(accountId,meterId,reading.usedPercent,reading.resetAt,reading.at);
  }

  /**
   * Banked rate-limit resets, as the provider last reported them. Only the
   * standing balance is useful, so each reading replaces the previous one
   * rather than accumulating history the way meters do.
   */
  resetCredits(accountId:string):ResetCreditReading|undefined{
    const raw=this.control(`reset-credits:${accountId}`);
    if(!raw)return undefined;
    try{
      const value=JSON.parse(raw) as Partial<ResetCreditReading>;
      if(typeof value?.at!=="number"||typeof value?.available!=="number")return undefined;
      return{at:value.at,available:value.available,nextExpiresAt:typeof value.nextExpiresAt==="number"?value.nextExpiresAt:undefined};
    }catch{return undefined;}
  }
  recordResetCredits(accountId:string,reading:ResetCreditReading):void{
    this.setControl(`reset-credits:${accountId}`,JSON.stringify({at:reading.at,available:reading.available,...(reading.nextExpiresAt===undefined?{}:{nextExpiresAt:reading.nextExpiresAt})}));
  }

  /** Tokens are kept per component so a reader can tell cache reads from fresh input. */
  recordUsage(entry:UsageEntry):void{
    this.db.prepare(`INSERT INTO usage_hour(account_id,hour,source,run_id,model,component,tokens) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(account_id,hour,source,run_id,model,component) DO UPDATE SET tokens=tokens+excluded.tokens`)
      .run(entry.accountId,entry.hour,entry.source,entry.runId,entry.model,entry.component,entry.tokens);
  }
  /** Totals for every hour bucket that starts at or after `since`. */
  usageSince(since:number):UsageTotal[]{
    return (this.db.prepare(`SELECT account_id,model,component,SUM(tokens) tokens FROM usage_hour
      WHERE hour>=? GROUP BY account_id,model,component`).all(since) as any[])
      .map((row)=>({accountId:row.account_id,model:row.model,component:row.component,tokens:row.tokens}));
  }

  reconcileLanes(lanes:readonly LaneSpec[], at=Date.now()): void {
    const ids=new Set<string>();
    for(const lane of lanes){
      for(const key of Object.keys(lane))if(!["id","prompt","cwd","profile","weight","priority","doctrineUrl","openingProbe","repair","admission","thinkingLevel"].includes(key))throw new Error(`unsupported lane field ${key}`);
      if(lane.admission!==undefined&&!["force","background"].includes(lane.admission))throw new Error(`lane ${lane.id} admission must be force or background`);
      if(lane.thinkingLevel!==undefined&&!isThinkingLevel(lane.thinkingLevel))throw new Error(`lane ${lane.id} thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
      if(lane.repair!==undefined&&(!lane.repair||typeof lane.repair!=="object"||Object.keys(lane.repair).some(key=>key!=="readinessCommand")||typeof lane.repair.readinessCommand!=="string"||!lane.repair.readinessCommand.trim()))throw new Error(`lane ${lane.id} repair requires a readinessCommand`);
      if(!lane.id||ids.has(lane.id))throw new Error(`invalid or duplicate lane id ${lane.id}`);
      ids.add(lane.id);
      if(!Number.isFinite(lane.weight)||lane.weight<=0)throw new Error(`lane ${lane.id} requires a positive weight`);
      for(const key of ["prompt","cwd","profile"] as const)if(typeof lane[key]!=="string"||!lane[key])throw new Error(`lane ${lane.id} requires ${key}`);
    }
    this.transaction(() => {
      const ids=new Set(lanes.map((lane)=>lane.id));
      for (const lane of lanes) this.db.prepare(`INSERT INTO lane(id,prompt,cwd,profile,weight,priority,doctrine_url,opening_probe,updated_at,admission,repair_readiness_command,thinking_level)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,cwd=excluded.cwd,profile=excluded.profile,
        weight=excluded.weight,priority=excluded.priority,doctrine_url=excluded.doctrine_url,
        opening_probe=excluded.opening_probe,updated_at=excluded.updated_at,admission=excluded.admission,
        repair_readiness_command=excluded.repair_readiness_command,thinking_level=excluded.thinking_level`)
        .run(lane.id,lane.prompt,lane.cwd,lane.profile,lane.weight,lane.priority??0,lane.doctrineUrl??null,lane.openingProbe??null,at,
          lane.admission??"force",lane.repair?.readinessCommand??null,lane.thinkingLevel??null);
      for (const row of this.db.prepare("SELECT id FROM lane").all() as {id:string}[]) if(!ids.has(row.id)) this.db.prepare("DELETE FROM lane WHERE id=?").run(row.id);
    });
  }
  lanes(): LaneSpec[] { return (this.db.prepare("SELECT * FROM lane ORDER BY priority DESC,weight DESC,id").all() as any[]).map((r)=>({id:r.id,prompt:r.prompt,cwd:r.cwd,profile:r.profile,weight:r.weight,priority:r.priority,doctrineUrl:maybe(r.doctrine_url),openingProbe:maybe(r.opening_probe),admission:(maybe(r.admission)??"force") as BudgetClass,thinkingLevel:maybe(r.thinking_level) as ThinkingLevel|undefined,repair:maybe(r.repair_readiness_command)===undefined?undefined:{readinessCommand:r.repair_readiness_command as string}})); }
  lane(id:string):LaneSpec|undefined{return this.lanes().find((x)=>x.id===id);}

  createRuns(input:{count:number;source:RunSource;sourceId?:string;prompt:string;cwd:string;profile:string;budget:BudgetClass;context?:RunContext}):string[]{
    const now=Date.now(),ids:string[]=[];
    this.transaction(()=>{for(let i=0;i<input.count;i++){const id=randomUUID();ids.push(id);this.db.prepare(`INSERT INTO run(id,source,source_id,prompt,cwd,profile,budget,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(id,input.source,input.sourceId??null,input.prompt,input.cwd,input.profile,input.budget,now,now);}});
    return ids;
  }
  run(id:string):Run|undefined{const r=this.db.prepare("SELECT * FROM run WHERE id=?").get(id) as any;return r?this.mapRuns([r])[0]:undefined;}
  runs(states?:readonly RunState[]):Run[]{const storedStates=states?.map(state=>state);const rows=storedStates?.length?this.db.prepare(`SELECT * FROM run WHERE state IN (${storedStates.map(()=>'?').join(',')}) ORDER BY created_at`).all(...storedStates):this.db.prepare("SELECT * FROM run ORDER BY created_at").all();return this.mapRuns(rows as any[]).filter(run=>!states?.length||states.includes(run.state));}
  admissionQueue():Run[]{
    const rows=this.db.prepare(`SELECT run.* FROM run LEFT JOIN lane ON run.source='lane' AND lane.id=run.source_id
      WHERE run.state='queued' AND run.account_id IS NULL
      ORDER BY CASE run.budget WHEN 'force' THEN 0 ELSE 1 END,
        CASE run.source WHEN 'direct' THEN 0 ELSE 1 END,
        COALESCE(lane.priority,0) DESC,
        CASE WHEN lane.id IS NULL THEN 0 ELSE
          CAST((SELECT count(*) FROM run active WHERE active.source='lane' AND active.source_id=run.source_id AND active.state IN ('starting','running')) AS REAL)/lane.weight
        END,
        COALESCE(lane.weight,0) DESC,run.created_at,run.id`).all();
    return this.mapRuns(rows as any[]);
  }
  private mapRuns(rows:any[]):Run[]{
    return rows.map(r=>({id:r.id,source:r.source,sourceId:maybe(r.source_id),prompt:r.prompt,cwd:r.cwd,profile:r.profile,budget:r.budget,
      accountId:maybe(r.account_id),provider:maybe(r.provider),model:maybe(r.model),thinking:maybe(r.thinking),sessionFile:maybe(r.session_file),
      state:r.state,failureKind:maybe(r.failure_kind),result:maybe(r.result),workerUnit:maybe(r.worker_unit),releasePath:maybe(r.release_path),
      createdAt:r.created_at,startedAt:maybe(r.started_at),updatedAt:r.updated_at,progressAt:maybe(r.progress_at),endedAt:maybe(r.ended_at)}));
  }
  assignRun(id:string,assignment:ModelCandidate & {accountId:string;unit:string;releasePath:string},at=Date.now()):boolean{
    return this.transaction(()=>{
      const run=this.run(id);
      if(!run || run.state!=="queued" || run.accountId)return false;
      const requestId=this.control(`completion-run:${id}`);
      const completion=requestId?JSON.parse(this.control(`completion:${requestId}`)!) as {input:CompletionInput}:undefined;
      const thinking=run.provider&&run.model?run.thinking:completion?.input.thinkingLevel??admissionThinking(assignment);
      this.db.prepare(`UPDATE run SET account_id=?,provider=?,model=?,thinking=?,worker_unit=?,release_path=?,state='starting',started_at=COALESCE(started_at,?),updated_at=?,progress_at=? WHERE id=?`)
        .run(assignment.accountId,assignment.provider,assignment.model,thinking??null,assignment.unit,assignment.releasePath,at,at,at,id);
      this.createLease(`run:${id}`,assignment.accountId,"fleet",id,at);
      return true;
    });
  }
  updateRun(id:string,patch:{state?:RunState;sessionFile?:string;progressAt?:number;result?:string;failureKind?:FailureKind;workerUnit?:string},at=Date.now()):void{
    this.transaction(()=>{
    const current=this.run(id);if(!current)throw new Error(`unknown run ${id}`);
    if(["done","failed","aborted"].includes(current.state))return;
    const state=patch.state??current.state;const terminal=["done","failed","aborted"].includes(state);
    this.db.prepare(`UPDATE run SET state=?,session_file=COALESCE(?,session_file),progress_at=COALESCE(?,progress_at),result=COALESCE(?,result),failure_kind=COALESCE(?,failure_kind),worker_unit=COALESCE(?,worker_unit),updated_at=?,ended_at=? WHERE id=?`)
      .run(state,patch.sessionFile??null,patch.progressAt??null,patch.result??null,patch.failureKind??null,patch.workerUnit??null,at,terminal?at:null,id);
    if(terminal)this.endLease(`run:${id}`,at);
    });
  }
  requeueRejectedCompletion(id:string):void{
    if(!this.control(`completion-run:${id}`))throw new Error(`Run ${id} is not a completion`);
    const run=this.run(id);if(!run||run.state==="aborted"||run.state==="done")throw new Error("Only rejected completion work can be requeued");
    this.endLease(`run:${id}`);
    this.db.prepare("UPDATE run SET state='queued',account_id=NULL,worker_unit=NULL,release_path=NULL,started_at=NULL,progress_at=NULL,ended_at=NULL,failure_kind=NULL,result=NULL,updated_at=? WHERE id=?").run(Date.now(),id);
  }
  finishCompletionRun(id:string,patch:Parameters<Store["updateRun"]>[1],at=Date.now()):void{
    this.transaction(()=>{
      if(!this.control(`completion-run:${id}`))throw new Error(`Run ${id} is not a completion`);
      const current=this.run(id);if(!current)throw new Error(`Unknown completion run ${id}`);
      if(current.state==="aborted")return;
      const state=patch.state??current.state;
      if(!["done","failed","aborted"].includes(state))throw new Error("A completion receipt must be terminal");
      this.db.prepare(`UPDATE run SET state=?,session_file=COALESCE(?,session_file),progress_at=COALESCE(?,progress_at),result=?,failure_kind=?,worker_unit=COALESCE(?,worker_unit),updated_at=?,ended_at=? WHERE id=?`)
        .run(state,patch.sessionFile??null,patch.progressAt??null,patch.result??current.result??null,state==="done"?null:patch.failureKind??null,patch.workerUnit??null,at,at,id);
      this.endLease(`run:${id}`,at);
    });
  }
  createLease(id:string,accountId:string,kind:LeaseKind,runId?:string,at=Date.now()):void{
    this.transaction(()=>{
      const current=this.db.prepare("SELECT account_id,kind,run_id,ended_at FROM lease WHERE id=?").get(id);
      if(current?.ended_at===null&&current.account_id===accountId&&current.kind===kind&&current.run_id===(runId??null)){
        this.heartbeatLease(id,at);
        return;
      }
      if(current)this.db.prepare("UPDATE lease SET id=?,ended_at=COALESCE(ended_at,?) WHERE id=?")
        .run(`${id}:interval:${randomUUID()}`,at,id);
      this.db.prepare("INSERT INTO lease(id,account_id,kind,run_id,started_at,heartbeat_at,ended_at) VALUES(?,?,?,?,?,?,NULL)")
        .run(id,accountId,kind,runId??null,at,at);
    });
  }
  heartbeatLease(id:string,at=Date.now()):void{this.db.prepare("UPDATE lease SET heartbeat_at=? WHERE id=? AND ended_at IS NULL").run(at,id);}
  endLease(id:string,at=Date.now()):void{this.db.prepare("UPDATE lease SET ended_at=? WHERE id=? AND ended_at IS NULL").run(at,id);}
  activeLeases(accountId?:string,maxAgeMs=120000,now=Date.now()):any[]{const cutoff=now-maxAgeMs;return (accountId?this.db.prepare("SELECT * FROM lease WHERE account_id=? AND ended_at IS NULL AND heartbeat_at>=?").all(accountId,cutoff):this.db.prepare("SELECT * FROM lease WHERE ended_at IS NULL AND heartbeat_at>=?").all(cutoff)) as any[];}

  activeSessionLeases(accountId?:string,maxAgeMs=120000,now=Date.now()):any[]{
    return this.db.prepare(`SELECT l.* FROM lease l WHERE l.ended_at IS NULL AND l.heartbeat_at>=? AND (? IS NULL OR l.account_id=?)
      AND NOT EXISTS (SELECT 1 FROM control c WHERE c.key='completion-run:'||l.run_id)`).all(now-maxAgeMs,accountId??null,accountId??null) as any[];
  }

}
