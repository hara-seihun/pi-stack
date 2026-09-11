import { mkdirSync } from "node:fs";
import { randomInt } from "node:crypto";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Account, BudgetClass, FailureKind, FleetChild, LaneSpec, LeaseKind, ProfileCandidate, Run, RunActivity, RunContext, RunSource, RunState, UsageEntry, UsageTotal } from "./domain.js";

import { openSqlite } from "./sqlite.js";

export const SCHEMA_VERSION = 3;
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
  updated_at INTEGER NOT NULL
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
CREATE TABLE live_state (
  run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  text TEXT NOT NULL,
  thinking TEXT NOT NULL,
  tool TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
${USAGE_HOUR_SCHEMA}`;

function maybe<T>(value: T | null): T | undefined { return value === null ? undefined : value; }

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

  private constructor(db: DatabaseSync) { this.db = db; }

  static open(path: string): Store {
    const db = openLedgerDatabase(path);
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!meta) db.exec(SCHEMA);
    const row = db.prepare("SELECT version FROM meta").get() as { version: number };
    if (row.version !== SCHEMA_VERSION) { db.close(); throw new Error(`unsupported orchestrator schema ${row.version}`); }
    db.exec(`CREATE INDEX IF NOT EXISTS control_fleet_parent ON control(json_extract(value,'$.parentRunId')) WHERE key >= 'fleet-child:' AND key < 'fleet-child;'`);
    return new Store(db);
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
      for(const key of Object.keys(lane))if(!["id","prompt","cwd","profile","weight","priority","doctrineUrl","openingProbe"].includes(key))throw new Error(`unsupported lane field ${key}`);
      if(!lane.id||ids.has(lane.id))throw new Error(`invalid or duplicate lane id ${lane.id}`);
      ids.add(lane.id);
      if(!Number.isFinite(lane.weight)||lane.weight<=0)throw new Error(`lane ${lane.id} requires a positive weight`);
      for(const key of ["prompt","cwd","profile"] as const)if(typeof lane[key]!=="string"||!lane[key])throw new Error(`lane ${lane.id} requires ${key}`);
    }
    this.transaction(() => {
      const ids=new Set(lanes.map((lane)=>lane.id));
      for (const lane of lanes) this.db.prepare(`INSERT INTO lane(id,prompt,cwd,profile,weight,priority,doctrine_url,opening_probe,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,cwd=excluded.cwd,profile=excluded.profile,
        weight=excluded.weight,priority=excluded.priority,doctrine_url=excluded.doctrine_url,
        opening_probe=excluded.opening_probe,updated_at=excluded.updated_at`)
        .run(lane.id,lane.prompt,lane.cwd,lane.profile,lane.weight,lane.priority??0,lane.doctrineUrl??null,lane.openingProbe??null,at);
      for (const row of this.db.prepare("SELECT id FROM lane").all() as {id:string}[]) if(!ids.has(row.id)) this.db.prepare("DELETE FROM lane WHERE id=?").run(row.id);
    });
  }
  lanes(): LaneSpec[] { return (this.db.prepare("SELECT * FROM lane ORDER BY priority DESC,weight DESC,id").all() as any[]).map((r)=>({id:r.id,prompt:r.prompt,cwd:r.cwd,profile:r.profile,weight:r.weight,priority:r.priority,doctrineUrl:maybe(r.doctrine_url),openingProbe:maybe(r.opening_probe)})); }
  lane(id:string):LaneSpec|undefined{return this.lanes().find((x)=>x.id===id);}

  fleetChild(id:string):FleetChild|undefined{return JSON.parse(this.control(`fleet-child:${id}`)??"null")??undefined;}
  childRunIds(id:string):string[]{return (this.db.prepare("SELECT substr(key,13) id FROM control WHERE key LIKE 'fleet-child:%' AND json_extract(value,'$.parentRunId')=? ORDER BY key").all(id) as {id:string}[]).map(row=>row.id);}
  isWaiting(id:string):boolean{return this.control(`fleet-waiting:${id}`)==="1";}
  createRuns(input:{count:number;source:RunSource;sourceId?:string;prompt:string;cwd:string;profile:string;budget:BudgetClass;context?:RunContext;child?:FleetChild}):string[]{
    const now=Date.now(),ids:string[]=[];
    this.transaction(()=>{for(let i=0;i<input.count;i++){const id=crypto.randomUUID();ids.push(id);this.db.prepare(`INSERT INTO run(id,source,source_id,prompt,cwd,profile,budget,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(id,input.source,input.sourceId??null,input.prompt,input.cwd,input.profile,input.budget,now,now);if(input.context)this.setControl(`run-context:${id}`,JSON.stringify(input.context));if(input.child)this.setControl(`fleet-child:${id}`,JSON.stringify(input.child));}});
    return ids;
  }
  run(id:string):Run|undefined{const r=this.db.prepare("SELECT * FROM run WHERE id=?").get(id) as any;return r?this.mapRuns([r])[0]:undefined;}
  runs(states?:readonly RunState[]):Run[]{const storedStates=states?.map(state=>state==="waiting"?"running":state);const rows=storedStates?.length?this.db.prepare(`SELECT * FROM run WHERE state IN (${storedStates.map(()=>'?').join(',')}) ORDER BY created_at`).all(...storedStates):this.db.prepare("SELECT * FROM run ORDER BY created_at").all();return this.mapRuns(rows as any[]).filter(run=>!states?.length||states.includes(run.state));}
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
  observedRuns(limit:number):Run[]{
    const rows=this.db.prepare(`WITH family AS MATERIALIZED (
      SELECT substr(key,13) id,json_extract(value,'$.parentRunId') parent,json_extract(value,'$.rootRunId') root FROM control WHERE key LIKE 'fleet-child:%'
    ) SELECT * FROM run WHERE state IN ('queued','starting','running') OR id IN (SELECT id FROM family UNION SELECT parent FROM family UNION SELECT root FROM family)
      ORDER BY CASE WHEN state IN ('done','failed','aborted') THEN 1 ELSE 0 END,COALESCE(started_at,created_at) DESC,id LIMIT ?`).all(Math.max(0,Math.floor(limit)));
    return this.mapRuns(rows as any[]);
  }
  private mapRuns(rows:any[]):Run[]{
    if(!rows.length)return[];
    const controls=new Map<string,string>();
    for(let offset=0;offset<rows.length;offset+=200){
      const ids=rows.slice(offset,offset+200).map(row=>row.id as string);
      const keys=ids.flatMap(id=>[`fleet-child:${id}`,`fleet-delivered:${id}`,`fleet-waiting:${id}`,`run-context:${id}`]);
      const own=this.db.prepare(`SELECT key,value FROM control WHERE key IN (${keys.map(()=>'?').join(',')})`).all(...keys) as {key:string;value:string}[];
      const children=this.db.prepare(`SELECT key,value FROM control WHERE key >= 'fleet-child:' AND key < 'fleet-child;' AND json_extract(value,'$.parentRunId') IN (${ids.map(()=>'?').join(',')})`).all(...ids) as {key:string;value:string}[];
      for(const row of [...own,...children])controls.set(row.key,row.value);
    }
    const children=new Map<string,FleetChild>(),childIds=new Map<string,string[]>();
    for(const [key,value] of controls)if(key.startsWith("fleet-child:")){
      const id=key.slice(12),child=JSON.parse(value) as FleetChild;
      children.set(id,child);
      const ids=childIds.get(child.parentRunId)??[];ids.push(id);childIds.set(child.parentRunId,ids);
    }
    return rows.map(r=>{
      const child=children.get(r.id),ids=childIds.get(r.id)??[];
      return{parentRunId:child?.parentRunId,rootRunId:child?.rootRunId??(ids.length?r.id:undefined),requestedModel:child?.model,escalatesRunId:child?.escalatesRunId,childRunIds:ids,
        deliveryState:child?(controls.has(`fleet-delivered:${r.id}`)?"delivered":"pending"):undefined,
        id:r.id,source:r.source,sourceId:maybe(r.source_id),prompt:r.prompt,cwd:r.cwd,profile:r.profile,budget:r.budget,
        context:JSON.parse(controls.get(`run-context:${r.id}`)??"null")??undefined,accountId:maybe(r.account_id),provider:maybe(r.provider),model:maybe(r.model),thinking:maybe(r.thinking),sessionFile:maybe(r.session_file),
        state:r.state==="running"&&controls.get(`fleet-waiting:${r.id}`)==="1"?"waiting":r.state,failureKind:maybe(r.failure_kind),result:maybe(r.result),workerUnit:maybe(r.worker_unit),releasePath:maybe(r.release_path),
        createdAt:r.created_at,startedAt:maybe(r.started_at),updatedAt:r.updated_at,progressAt:maybe(r.progress_at),endedAt:maybe(r.ended_at)};
    });
  }
  assignRun(id:string,assignment:ProfileCandidate & {accountId:string;unit:string;releasePath:string},at=Date.now()):boolean{
    return this.transaction(()=>{
      const run=this.run(id);
      if(!run || run.state!=="queued" || run.accountId)return false;
      const fixed=this.fleetChild(id)?.assignment;
      if(fixed&&(fixed.provider!==assignment.provider||fixed.model!==assignment.model||fixed.thinking!==assignment.thinking||assignment.thinkingPair))return false;
      let thinking=assignment.thinking;
      if(assignment.thinkingPair){
        const pair=assignment.thinkingPair;
        const key=`thinking-pair:${JSON.stringify([run.profile,assignment.provider,assignment.model,[...pair].sort()])}`;
        const pending=this.control(key);
        if(pending && !pair.includes(pending))throw new Error(`invalid pending thinking level for ${key}`);
        thinking=pending || pair[randomInt(2)]!;
        this.setControl(key,pending ? "" : pair.find(level=>level!==thinking)!);
      }
      this.db.prepare(`UPDATE run SET account_id=?,provider=?,model=?,thinking=?,worker_unit=?,release_path=?,state='starting',started_at=COALESCE(started_at,?),updated_at=?,progress_at=? WHERE id=?`)
        .run(assignment.accountId,assignment.provider,assignment.model,thinking??null,assignment.unit,assignment.releasePath,at,at,at,id);
      this.createLease(`run:${id}`,assignment.accountId,"fleet",id,at);
      return true;
    });
  }
  updateRun(id:string,patch:{state?:RunState;sessionFile?:string;progressAt?:number;result?:string;failureKind?:FailureKind;workerUnit?:string},at=Date.now()):void{
    const current=this.run(id);if(!current)throw new Error(`unknown run ${id}`);
    if(["done","failed","aborted"].includes(current.state))return;
    const state=patch.state??current.state;const terminal=["done","failed","aborted"].includes(state);
    if(state==="waiting")this.setControl(`fleet-waiting:${id}`,"1");
    else if(patch.state)this.db.prepare("DELETE FROM control WHERE key=?").run(`fleet-waiting:${id}`);
    this.db.prepare(`UPDATE run SET state=?,session_file=COALESCE(?,session_file),progress_at=COALESCE(?,progress_at),result=COALESCE(?,result),failure_kind=COALESCE(?,failure_kind),worker_unit=COALESCE(?,worker_unit),updated_at=?,ended_at=? WHERE id=?`)
      .run(state==="waiting"?"running":state,patch.sessionFile??null,patch.progressAt??null,patch.result??null,patch.failureKind??null,patch.workerUnit??null,at,terminal?at:null,id);
    if(terminal||state==="waiting")this.endLease(`run:${id}`,at);
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
  resumeAssignedRun(id:string,at=Date.now(),accountId?:string):boolean{
    return this.transaction(()=>{
      const run=this.run(id);
      if(!run?.accountId||!run.provider||!run.model||!run.workerUnit||!run.releasePath)return false;
      const targetAccount=accountId??run.accountId;
      if(this.account(targetAccount)?.provider!==run.provider)return false;
      const changed=this.db.prepare(`UPDATE run SET account_id=?,state='starting',result='worker process stopped; recovering the saved Pi session',updated_at=?,ended_at=NULL WHERE id=? AND state IN ('queued','starting','running')`).run(targetAccount,at,id).changes;
      if(changed!==1)return false;
      this.db.prepare("DELETE FROM control WHERE key=?").run(`fleet-waiting:${id}`);
      this.endLease(`run:${id}`,at);
      this.createLease(`run:${id}`,targetAccount,"fleet",id,at);
      return true;
    });
  }
  adoptAssignedRun(id:string,at=Date.now()):boolean{
    return this.transaction(()=>{
      const run=this.run(id);
      if(!run?.accountId||!run.provider||!run.model||!run.workerUnit||!run.releasePath)return false;
      if(run.state==="failed"&&(run.parentRunId||run.childRunIds?.length))return false;
      const changed=this.db.prepare(`UPDATE run SET state='running',result=NULL,failure_kind=NULL,updated_at=?,ended_at=NULL WHERE id=? AND state IN ('queued','starting','running','failed')`).run(at,id).changes;
      if(changed!==1)return false;
      this.endLease(`run:${id}`,at);
      this.createLease(`run:${id}`,run.accountId,"fleet",id,at);
      return true;
    });
  }
  activeCount(source?:RunSource,sourceId?:string):number{return this.runs(["queued","starting","running","waiting"]).filter(run=>(!source||run.source===source)&&(!sourceId||run.sourceId===sourceId)).length;}
  admittedLaneCount(sourceId:string):number{return this.runs(["starting","running","waiting"]).filter((run)=>run.source==="lane"&&run.sourceId===sourceId).length;}
  trimQueuedLane(sourceId:string,keep:number,at=Date.now()):number{
    const rows=this.db.prepare("SELECT id FROM run WHERE source='lane' AND source_id=? AND state='queued' ORDER BY created_at,id").all(sourceId) as {id:string}[];
    const removed=rows.slice(Math.max(0,keep));
    this.transaction(()=>{for(const {id} of removed)this.db.prepare("UPDATE run SET state='aborted',failure_kind='task',result='unused lane queue entry withdrawn',updated_at=?,ended_at=? WHERE id=? AND state='queued'").run(at,at,id);});
    return removed.length;
  }

  createLease(id:string,accountId:string,kind:LeaseKind,runId?:string,at=Date.now()):void{this.db.prepare(`INSERT INTO lease(id,account_id,kind,run_id,started_at,heartbeat_at,ended_at) VALUES(?,?,?,?,?,?,NULL)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,kind=excluded.kind,run_id=excluded.run_id,started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,ended_at=NULL`).run(id,accountId,kind,runId??null,at,at);}
  heartbeatLease(id:string,at=Date.now()):void{this.db.prepare("UPDATE lease SET heartbeat_at=? WHERE id=? AND ended_at IS NULL").run(at,id);}
  endLease(id:string,at=Date.now()):void{this.db.prepare("UPDATE lease SET ended_at=? WHERE id=? AND ended_at IS NULL").run(at,id);}
  activeLeases(accountId?:string,maxAgeMs=120000,now=Date.now()):any[]{const cutoff=now-maxAgeMs;return (accountId?this.db.prepare("SELECT * FROM lease WHERE account_id=? AND ended_at IS NULL AND heartbeat_at>=?").all(accountId,cutoff):this.db.prepare("SELECT * FROM lease WHERE ended_at IS NULL AND heartbeat_at>=?").all(cutoff)) as any[];}

  activeSessionLeases(accountId?:string,maxAgeMs=120000,now=Date.now()):any[]{
    return this.db.prepare(`SELECT l.* FROM lease l WHERE l.ended_at IS NULL AND l.heartbeat_at>=? AND (? IS NULL OR l.account_id=?)
      AND NOT EXISTS (SELECT 1 FROM control c WHERE c.key='completion-run:'||l.run_id)`).all(now-maxAgeMs,accountId??null,accountId??null) as any[];
  }

  setLive(runId:string,input:{activity:RunActivity;text?:string;thinking?:string;tool?:string},at=Date.now()):void{this.db.prepare(`INSERT INTO live_state(run_id,activity,text,thinking,tool,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET activity=excluded.activity,text=excluded.text,thinking=excluded.thinking,tool=excluded.tool,updated_at=excluded.updated_at`).run(runId,input.activity,input.text??"",input.thinking??"",input.tool??null,at);}
  live():any[]{return this.db.prepare("SELECT * FROM live_state").all() as any[];}
}
