import type { ModelCandidate } from "./catalog.js";
import type { BudgetClass, OrchestratorConfig } from "./domain.js";
import type { Store } from "./store.js";

export interface Assignment extends ModelCandidate { readonly accountId:string; readonly meterAt?:number; }
export interface Refusal { readonly accountId:string; readonly reason:string; }

function accountPace(store:Store,accountId:string,budget:BudgetClass,cfg:OrchestratorConfig,now:number):{ok:boolean;spent:number;meterAt?:number;reason?:string}{
  const provider=store.account(accountId)?.provider;
  const multiplier=Number(store.control(`boost:${provider}`)??"1");
  if(multiplier===0)return{ok:false,spent:0,reason:"provider halted"};
  const meters=store.latestMeters(accountId);
  if(meters.length===0){
    if(budget==="force")return{ok:true,spent:0};
    const probed=store.db.prepare("SELECT 1 FROM lease WHERE account_id=? AND kind='fleet' LIMIT 1").get(accountId);
    return probed?{ok:false,spent:0,reason:"awaiting a meter after the calibration probe"}:{ok:true,spent:0,reason:"probe"};
  }
  const freshest=Math.max(...meters.map((m)=>Number(m.observed_at)));
  const spent=Math.max(...meters.map((m)=>Number(m.used_percent)));
  if(meters.some((m)=>Number(m.used_percent)>=100))return{ok:false,spent,meterAt:freshest,reason:"provider quota exhausted"};
  if(budget==="force")return{ok:true,spent,meterAt:freshest};
  if(now-freshest>cfg.meterMaxAgeMs)return{ok:false,spent,meterAt:freshest,reason:"meter is stale"};
  const limit=Math.min(100,cfg.backgroundSpendFraction*100*multiplier);
  if(meters.some((m)=>Number(m.used_percent)>=limit))return{ok:false,spent,meterAt:freshest,reason:`background reserve reached (${limit}%)`};
  for(const latest of meters){
    const previous=(store.meters(accountId) as any[]).find((m)=>m.meter_id===latest.meter_id&&m.observed_at<latest.observed_at);
    if(!previous||!latest.reset_at)continue;
    const hours=(latest.observed_at-previous.observed_at)/3_600_000;
    const remainingHours=(latest.reset_at-now)/3_600_000;
    if(hours<=0||remainingHours<=0)continue;
    const slope=(latest.used_percent-previous.used_percent)/hours;
    const permitted=(limit-latest.used_percent)/remainingHours;
    if(slope>permitted&&latest.used_percent>0)return{ok:false,spent,meterAt:freshest,reason:`usage slope ${slope.toFixed(2)}%/h exceeds ${permitted.toFixed(2)}%/h pace`};
  }
  const admitted=(store.db.prepare("SELECT last_admitted_meter_at FROM account WHERE id=?").get(accountId) as any)?.last_admitted_meter_at;
  if(admitted!=null&&Number(admitted)>=freshest)return{ok:false,spent,meterAt:freshest,reason:"already admitted from this meter observation"};
  return{ok:true,spent,meterAt:freshest};
}

export function assign(store:Store,profile:string,budget:BudgetClass,cfg:OrchestratorConfig,now=Date.now(),pinnedAccount?:string):{assignment?:Assignment;refusals:Refusal[]}{
  if(store.control("launches")==="paused")return{refusals:[{accountId:"*",reason:"emergency halt"}]};
  if(store.activeLeases(undefined,120_000,now).length>=cfg.maxConcurrentSessions)return{refusals:[{accountId:"*",reason:"machine session ceiling"}]};
  const candidates=cfg.profiles[profile];if(!candidates?.length)throw new Error(`unknown model profile ${profile}`);
  const refusals:Refusal[]=[];const choices:Assignment[]=[];
  for(const candidate of candidates){
    for(const account of store.accounts().filter((a)=>a.provider===candidate.provider&&(pinnedAccount===undefined||a.id===pinnedAccount))){
      if(!account.enabled){refusals.push({accountId:account.id,reason:"disabled"});continue;}
      if(account.cooldownUntil&&account.cooldownUntil>now){refusals.push({accountId:account.id,reason:`cooling until ${new Date(account.cooldownUntil).toISOString()}`});continue;}
      const active=store.activeLeases(account.id,120_000,now).length;
      if(active>=account.concurrency){refusals.push({accountId:account.id,reason:`concurrency ${active}/${account.concurrency}`});continue;}
      const pace=accountPace(store,account.id,budget,cfg,now);
      if(!pace.ok){refusals.push({accountId:account.id,reason:pace.reason!});continue;}
      choices.push({accountId:account.id,...candidate,meterAt:pace.meterAt});
    }
    if(choices.length)break;
  }
  choices.sort((a,b)=>{
    const pa=accountPace(store,a.accountId,budget,cfg,now).spent,pb=accountPace(store,b.accountId,budget,cfg,now).spent;
    const la=store.activeLeases(a.accountId,120_000,now).length,lb=store.activeLeases(b.accountId,120_000,now).length;
    return pa-pb||la-lb||a.accountId.localeCompare(b.accountId);
  });
  return{assignment:choices[0],refusals};
}

export function commitMeterAdmission(store:Store,assignment:Assignment):void{
  if(assignment.meterAt!==undefined)store.db.prepare("UPDATE account SET last_admitted_meter_at=? WHERE id=?").run(assignment.meterAt,assignment.accountId);
}
