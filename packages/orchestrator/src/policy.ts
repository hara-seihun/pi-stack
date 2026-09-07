import { catalogMeter } from "./catalog.js";
import { allowsAccountUse, type BudgetClass, type OrchestratorConfig, type ProfileCandidate } from "./domain.js";
import type { Store } from "./store.js";

export type Assignment = ProfileCandidate & { readonly accountId:string; readonly meterAt?:number; };
export interface Refusal { readonly accountId:string; readonly reason:string; }
export interface Capacity { readonly sessions:number; readonly spent:number; readonly meterAt?:number; readonly reason:string; }

const HOUR=3_600_000;
const HISTORY=6*HOUR;

/** A ceiling for all consumers of one account, not a desired worker count. */
export function accountCapacity(store:Store,accountId:string,budget:BudgetClass,cfg:OrchestratorConfig,now=Date.now()):Capacity{
  const account=store.account(accountId)!;
  const multiplier=Number(store.control(`boost:${account.provider}`)??"1");
  const meters=store.latestMeters(accountId);
  const spent=Math.max(0,...meters.map((m)=>Number(m.used_percent)));
  const meterAt=meters.length?Math.max(...meters.map((m)=>Number(m.observed_at))):undefined;
  const stop=(reason:string):Capacity=>({sessions:0,spent,meterAt,reason});
  if(!allowsAccountUse(account,"fleet"))return stop(account.enabled?"reserved for voice":"disabled");
  if(account.cooldownUntil&&account.cooldownUntil>now)return stop("account cooling down");
  if(!Number.isFinite(multiplier)||multiplier<=0)return stop("provider halted");
  if(meters.some((m)=>m.used_percent>=100))return stop("provider quota exhausted");
  if(budget==="force")return{sessions:account.concurrency,spent,meterAt,reason:"urgent spend"};
  if(!meters.length){
    const probed=store.db.prepare("SELECT 1 FROM lease WHERE account_id=? AND kind='fleet' LIMIT 1").get(accountId);
    const activeProbe=store.activeLeases(accountId,120_000,now).some((lease)=>lease.kind==="fleet");
    return{sessions:!probed||activeProbe?1:0,spent,reason:"calibration probe awaiting meter evidence"};
  }
  if(meters.some((m)=>now-m.observed_at>cfg.meterMaxAgeMs||m.observed_at>now+60_000))return stop("meter is stale");
  const limit=Math.min(100,cfg.backgroundSpendFraction*100);
  if(meters.some((m)=>m.used_percent>=limit))return stop(`background reserve reached (${limit}%)`);
  let sessions=account.concurrency;
  let reason="within paced allowance";
  const history=store.meters(accountId);
  const leases=store.db.prepare("SELECT * FROM lease WHERE account_id=? AND (ended_at IS NULL OR ended_at>=?)").all(accountId,now-HISTORY) as any[];
  for(const latest of meters){
    const declared=catalogMeter(latest.meter_id);
    if(!declared)return stop(`unknown meter ${latest.meter_id}`);
    if(!latest.reset_at){
      if(latest.used_percent!==0)return stop(`missing reset for ${latest.meter_id}`);
      continue;
    }
    if(latest.reset_at<=now)return stop(`awaiting reset observation for ${latest.meter_id}`);
    const remainingHours=(latest.reset_at-now)/HOUR;
    const elapsedHours=Math.max(0,declared.windowHours-remainingHours);
    const allowance=limit*elapsedHours/declared.windowHours;
    // Boost deliberately spends ahead of the calendar; provider exhaustion still stops admission.
    if(multiplier<=1&&latest.used_percent>allowance+1)return stop(`${latest.meter_id}: spent ${latest.used_percent}% exceeds paced allowance ${allowance.toFixed(1)}%`);
    const previous=history.filter((m)=>m.meter_id===latest.meter_id&&m.observed_at<latest.observed_at&&m.observed_at>=now-HISTORY&&Math.abs((m.reset_at??0)-latest.reset_at)<60_000&&m.used_percent<=latest.used_percent).at(-1);
    if(!previous||latest.observed_at-previous.observed_at<15*60_000){
      sessions=Math.min(sessions,1);reason="calibrating consumption over at least 15 minutes";continue;
    }
    const exposure=leases.reduce((sum,lease)=>{
      const end=Math.min(latest.observed_at,lease.ended_at??lease.heartbeat_at);
      return sum+Math.max(0,end-Math.max(previous.observed_at,lease.started_at))/HOUR;
    },0);
    if(exposure<=0){sessions=Math.min(sessions,1);reason="calibrating session consumption";continue;}
    const cost=(latest.used_percent-previous.used_percent+1)/exposure;
    const permitted=(limit-latest.used_percent)/remainingHours;
    const ceiling=Math.max(0,Math.floor(permitted/cost));
    if(ceiling<sessions){sessions=ceiling;reason=`${latest.meter_id}: ${permitted.toFixed(2)}%/h available, ${cost.toFixed(2)}% per session-hour`;}
  }
  const boosted=Math.floor(sessions*multiplier);
  return{sessions:boosted,spent,meterAt,reason:multiplier===1?reason:`${sessions} base × ${multiplier} = ${boosted} sessions; ${reason}`};
}

export function assign(store:Store,profile:string,budget:BudgetClass,cfg:OrchestratorConfig,now=Date.now(),pinnedAccount?:string):{assignment?:Assignment;refusals:Refusal[]}{
  if(store.control("launches")==="paused")return{refusals:[{accountId:"*",reason:"emergency halt"}]};
  if(store.activeLeases(undefined,120_000,now).length>=cfg.maxConcurrentSessions)return{refusals:[{accountId:"*",reason:"machine session ceiling"}]};
  const candidates=cfg.profiles[profile];if(!candidates?.length)throw new Error(`unknown model profile ${profile}`);
  const refusals:Refusal[]=[];const choices:(Assignment&{spent:number})[]=[];
  for(const candidate of candidates){
    for(const account of store.accounts().filter((a)=>a.provider===candidate.provider&&(pinnedAccount===undefined||a.id===pinnedAccount))){
      const capacity=accountCapacity(store,account.id,budget,cfg,now);
      const active=store.activeLeases(account.id,120_000,now).length;
      if(active>=capacity.sessions){refusals.push({accountId:account.id,reason:`capacity ${active}/${capacity.sessions}: ${capacity.reason}`});continue;}
      const admitted=(store.db.prepare("SELECT last_admitted_meter_at FROM account WHERE id=?").get(account.id) as any)?.last_admitted_meter_at;
      if(budget!=="force"&&Number(store.control(`boost:${account.provider}`)??"1")<=1&&admitted!=null&&capacity.meterAt!==undefined&&Number(admitted)>=capacity.meterAt){refusals.push({accountId:account.id,reason:"already admitted from this meter observation"});continue;}
      choices.push({accountId:account.id,...candidate,meterAt:capacity.meterAt,spent:capacity.spent});
    }
    if(choices.length)break;
  }
  choices.sort((a,b)=>a.spent-b.spent||store.activeLeases(a.accountId,120_000,now).length-store.activeLeases(b.accountId,120_000,now).length||a.accountId.localeCompare(b.accountId));
  return{assignment:choices[0],refusals};
}

export function commitMeterAdmission(store:Store,assignment:Assignment):void{
  if(assignment.meterAt!==undefined)store.db.prepare("UPDATE account SET last_admitted_meter_at=? WHERE id=?").run(assignment.meterAt,assignment.accountId);
}
