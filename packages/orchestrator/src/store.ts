import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { admissionThinking, quotaScopeCovers, type ModelCandidate } from "./catalog.js";
import type { CompletionInput } from "./completion-contract.js";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Account, BudgetClass, FailureKind, LeaseKind, ResetCreditReading, Run, RunContext, RunSource, RunState, UsageEntry, UsageTotal } from "./domain.js";

import { openSqlite } from "./sqlite.js";

export const SCHEMA_VERSION = 3;
/** One broker principal's live spending grant, owned by the running model broker. */
export interface BrokerGrant { accounts: string[]; models: string[] }
const GRANT_PREFIX = "broker-grant:";
const GRANT_OWNER_PREFIX = "broker-grant-owner:";
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

/**
 * What the machine knew when it cooled an account: the cooldown it wrote, when
 * the refusal was observed, and the models refused while that hold stood. A
 * model-less refusal adds nothing to `models`, so any later success clears it.
 */
export interface CooldownEvidence { until: number; at: number; models: string[] }
/** A provider-accepted request that can reconcile an earlier cooldown. */
export interface ProviderSuccess { model: string; startedAt: number; source: string; now?: number }
const COOLDOWN_EVIDENCE = (id: string) => `cooldown-evidence:${id}`;
const COOLDOWN_RECOVERY = (id: string) => `cooldown-recovery:${id}`;

/**
 * Cooldowns written without evidence — by a release predating it, or by a
 * process still running one — have no known refusal time. Date them now, so
 * only a request that starts after this point can lift them.
 */
function adoptCooldownEvidence(db: DatabaseSync, now = Date.now()): void {
  const rows = db.prepare(`SELECT a.id,a.cooldown_until until,c.value evidence FROM account a
    LEFT JOIN control c ON c.key='cooldown-evidence:'||a.id WHERE a.cooldown_until>?`).all(now) as { id: string; until: number; evidence: string | null }[];
  for (const row of rows) {
    const evidence = row.evidence ? JSON.parse(row.evidence) as CooldownEvidence : undefined;
    if (evidence?.until === row.until) continue;
    db.prepare("INSERT INTO control(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(COOLDOWN_EVIDENCE(row.id), JSON.stringify({ until: row.until, at: now, models: evidence?.models ?? [] } satisfies CooldownEvidence));
  }
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
  private isClosed=false;
  get closed():boolean { return this.isClosed; }

  private constructor(db: DatabaseSync, readonly path: string) { this.db = db; }

  static open(path: string): Store {
    const db = openLedgerDatabase(path);
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!meta) db.exec(SCHEMA);
    const row = db.prepare("SELECT version FROM meta").get() as { version: number };
    if (row.version !== SCHEMA_VERSION) { db.close(); throw new Error(`unsupported orchestrator schema ${row.version}`); }
    db.exec("DROP TABLE IF EXISTS live_state");
    adoptCooldownEvidence(db);
    // Frozen subscription dollars per list-price dollar, one row per provider-hour. See person-usage.ts.
    db.exec("CREATE TABLE IF NOT EXISTS usage_rate (provider TEXT NOT NULL, hour INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY(provider,hour)) STRICT");
    // A reset weekly meter rounded to 0% used to freeze a zero rate despite
    // recorded usage. Restore those hours from the last valid provider rate;
    // with no earlier calibration, leave the hour unpriced until one exists.
    db.exec(`UPDATE usage_rate AS current SET rate = (
      SELECT previous.rate FROM usage_rate AS previous
      WHERE previous.provider = current.provider AND previous.hour < current.hour AND previous.rate > 0
      ORDER BY previous.hour DESC LIMIT 1
    ) WHERE current.rate = 0 AND EXISTS (
      SELECT 1 FROM usage_rate AS previous
      WHERE previous.provider = current.provider AND previous.hour < current.hour AND previous.rate > 0
    );
    DELETE FROM usage_rate WHERE rate = 0;`);
    return new Store(db, path === ":memory:" ? path : resolve(path));
  }

  close(): void { this.isClosed=true; this.db.close(); }
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
  publishBrokerGrants(grants: readonly (BrokerGrant&{principal:string})[], owner?: string): void {
    this.transaction(()=>{
      const keep=new Set(grants.map((grant)=>`${GRANT_PREFIX}${grant.principal}`));
      for(const grant of grants){
        const key=`${GRANT_PREFIX}${grant.principal}`,ownerKey=`${GRANT_OWNER_PREFIX}${grant.principal}`;
        const currentOwner=this.control(ownerKey);
        if(this.control(key)!==undefined&&currentOwner!==owner)
          throw new Error(`Broker principal ${grant.principal} belongs to another grant owner`);
        this.setControl(key,JSON.stringify({accounts:grant.accounts,models:grant.models} satisfies BrokerGrant));
        if(owner!==undefined)this.setControl(ownerKey,owner);
      }
      const stale=(this.db.prepare("SELECT key FROM control WHERE key>=? AND key<?").all(GRANT_PREFIX,`${GRANT_PREFIX}\uffff`) as {key:string}[])
        .filter((row)=>!keep.has(row.key)&&this.control(`${GRANT_OWNER_PREFIX}${row.key.slice(GRANT_PREFIX.length)}`)===owner);
      for(const row of stale){
        this.db.prepare("DELETE FROM control WHERE key=?").run(row.key);
        this.db.prepare("DELETE FROM control WHERE key=?").run(`${GRANT_OWNER_PREFIX}${row.key.slice(GRANT_PREFIX.length)}`);
      }
    });
  }

  accounts(): Account[] {
    return (this.db.prepare("SELECT * FROM account ORDER BY id").all() as any[]).map((r) => ({
      id:r.id, provider:r.provider, label:maybe(r.label), enabled:!!r.enabled,
      cooldownUntil:maybe(r.cooldown_until), concurrency:r.concurrency,
      use:this.control(`account-use:${r.id}`)==="voice"?"voice":"shared",
    }));
  }
  account(id: string): Account | undefined { return this.accounts().find((a) => a.id === id); }
  upsertAccount(input: Omit<Account,"enabled"|"concurrency"> & Partial<Pick<Account,"enabled"|"concurrency">>): void {
    this.db.prepare(`INSERT INTO account(id,provider,label,enabled,concurrency,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,label=COALESCE(excluded.label,account.label),enabled=excluded.enabled,concurrency=excluded.concurrency`)
      .run(input.id,input.provider,input.label??null,input.enabled===false?0:1,input.concurrency??1,Date.now());
  }
  /**
   * Cool an account after a refusal observed at `failure.at` (default now) for
   * `failure.model`, a model ID in the account's provider family. Refusals
   * while a hold stands accumulate their models and move the refusal time
   * forward, so an earlier success can never lift a later refusal.
   */
  setCooldown(id: string, until?: number, failure: { model?: string; at?: number } = {}): void {
    this.transaction(()=>{
      const at=failure.at??Date.now();
      const previous=this.db.prepare("SELECT cooldown_until FROM account WHERE id=?").get(id) as {cooldown_until:number|null}|undefined;
      this.db.prepare("UPDATE account SET cooldown_until=? WHERE id=?").run(until??null,id);
      if(until==null||until<=at){this.db.prepare("DELETE FROM control WHERE key=?").run(COOLDOWN_EVIDENCE(id));return;}
      const prior=this.cooldownEvidence(id),standing=(previous?.cooldown_until??0)>at;
      const models=[...new Set([...(standing?prior?.models??[]:[]),...(failure.model?[failure.model]:[])])];
      this.setControl(COOLDOWN_EVIDENCE(id),JSON.stringify({until,at:Math.max(at,standing?prior?.at??0:0),models} satisfies CooldownEvidence));
    });
  }
  cooldownEvidence(id: string): CooldownEvidence | undefined {
    const raw=this.control(COOLDOWN_EVIDENCE(id));return raw?JSON.parse(raw):undefined;
  }
  /**
   * A provider accepted a request on this account, so a cooldown inferred from
   * an earlier refusal no longer describes it. Lifts the hold only when the
   * request started after the latest recorded refusal and passed through every
   * quota the refused models draw on; the account row is compared-and-swapped
   * so a refusal recorded concurrently survives. Returns whether it cleared.
   *
   * September 29, 2026: three Anthropic accounts cooled for a day on monthly
   * spend refusals, an interactive Opus request then succeeded on `anthropic`
   * at 14:56, and fleet workers stayed refused until the next day.
   */
  recordProviderSuccess(id: string, success: ProviderSuccess): boolean {
    if(!Number.isFinite(success.startedAt)||!success.model)return false;
    return this.transaction(()=>{
      const now=success.now??Date.now();
      const row=this.db.prepare("SELECT provider,cooldown_until FROM account WHERE id=?").get(id) as {provider:string;cooldown_until:number|null}|undefined;
      if(!row||row.cooldown_until==null||row.cooldown_until<=now)return false;
      const evidence=this.cooldownEvidence(id);
      if(!evidence||evidence.until!==row.cooldown_until||success.startedAt<=evidence.at)return false;
      if(!evidence.models.every(model=>quotaScopeCovers(row.provider,success.model,model)))return false;
      const cleared=this.db.prepare("UPDATE account SET cooldown_until=NULL WHERE id=? AND cooldown_until=?").run(id,row.cooldown_until);
      if(Number(cleared.changes)!==1)return false;
      this.db.prepare("DELETE FROM control WHERE key=?").run(COOLDOWN_EVIDENCE(id));
      this.setControl(COOLDOWN_RECOVERY(id),JSON.stringify({clearedAt:now,cooldown:evidence,success:{model:success.model,startedAt:success.startedAt,source:success.source}}));
      return true;
    });
  }
  setAccountEnabled(id:string,enabled:boolean):void{this.db.prepare("UPDATE account SET enabled=? WHERE id=?").run(enabled?1:0,id);}
  removeAccount(id: string): void {
    this.db.prepare("DELETE FROM account WHERE id=?").run(id);
    this.db.prepare("DELETE FROM control WHERE key IN (?,?)").run(COOLDOWN_EVIDENCE(id),COOLDOWN_RECOVERY(id));
  }

  recordMeter(accountId:string,meterId:string,usedPercent:number,resetAt:number|undefined,observedAt=Date.now()): void {
    this.db.prepare(`INSERT INTO meter(account_id,meter_id,observed_at,used_percent,reset_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,meter_id,observed_at) DO UPDATE SET used_percent=excluded.used_percent,reset_at=excluded.reset_at`)
      .run(accountId,meterId,observedAt,usedPercent,resetAt??null);
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

  createRuns(input:{count:number;source:RunSource;sourceId?:string;prompt:string;cwd:string;profile:string;budget:BudgetClass;context?:RunContext}):string[]{
    const now=Date.now(),ids:string[]=[];
    this.transaction(()=>{for(let i=0;i<input.count;i++){const id=randomUUID();ids.push(id);this.db.prepare(`INSERT INTO run(id,source,source_id,prompt,cwd,profile,budget,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(id,input.source,input.sourceId??null,input.prompt,input.cwd,input.profile,input.budget,now,now);}});
    return ids;
  }
  run(id:string):Run|undefined{const r=this.db.prepare("SELECT * FROM run WHERE id=?").get(id) as any;return r?this.mapRuns([r])[0]:undefined;}
  runs(states?:readonly RunState[]):Run[]{const storedStates=states?.map(state=>state);const rows=storedStates?.length?this.db.prepare(`SELECT * FROM run WHERE state IN (${storedStates.map(()=>'?').join(',')}) ORDER BY created_at`).all(...storedStates):this.db.prepare("SELECT * FROM run ORDER BY created_at").all();return this.mapRuns(rows as any[]).filter(run=>!states?.length||states.includes(run.state));}
  admissionQueue():Run[]{
    const rows=this.db.prepare(`SELECT run.* FROM run JOIN control ON control.key='completion-run:'||run.id
      WHERE run.state='queued' AND run.account_id IS NULL ORDER BY run.created_at,run.id`).all();
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
