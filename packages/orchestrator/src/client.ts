import { ORCHESTRATOR_CATALOG, catalogAgentType, catalogMeter, type PlanDefinition, type PlanMetric } from "./catalog.js";
import { Store } from "./store.js";
import { type Account, type UsageTotal } from "./domain.js";

export const CACHE_WINDOW_MS=24*3_600_000;
export interface PlanAccountUsage{
  readonly accountId:string;
  readonly accountLabel:string;
  readonly state:"ready"|"stale"|"unavailable";
  readonly percentLeft:number|null;
  readonly usedPercent:number|null;
  readonly meterId:string|null;
  readonly windowHours:number|null;
  readonly readingAt:string|null;
  readonly resetAt:string|null;
  /** Rate-limit resets the account has banked, or null where none are reported. */
  readonly bankedResets:number|null;
  /** When that balance was read. */
  readonly bankedResetsAt:string|null;
  /** Expiry of the banked reset that perishes first, when the provider dates them. */
  readonly bankedResetExpiresAt:string|null;
}
export interface PlanMetricUsage{readonly percentLeft:number|null;readonly expectedPercentLeft:number|null;readonly paceDelta:number|null;readonly cachePercent:number|null;readonly accounts:readonly PlanAccountUsage[];}
export interface PlanUsage{readonly state:"ready"|"partial"|"unavailable";readonly metrics:Readonly<Record<string,PlanMetricUsage>>;readonly planCount:number;readonly checkedCount:number;}
export interface PlanUsageSnapshot{readonly plans:Readonly<Record<string,PlanUsage>>;readonly updatedAt:string;}
export interface OrchestratorClientOptions{readonly ledgerPath:string;}

const clamp=(value:number)=>Math.max(0,Math.min(100,value));
const mean=(values:number[]):number|null=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const rounded=(value:number|null)=>value===null?null:Math.round(value);
const iso=(value:number|undefined):string|null=>value===undefined?null:new Date(value).toISOString();

/**
 * The share of prompt tokens a model read from its cache instead of sending
 * again. Output tokens are not part of the prompt, so they stay out of it, and
 * a model nobody used in the window has no rate to report.
 */
export function cachePercent(totals:readonly UsageTotal[],modelId:string,accountIds:ReadonlySet<string>):number|null{
  const mine=totals.filter((total)=>accountIds.has(total.accountId)&&catalogAgentType(total.model).key===modelId);
  const tokens=(component:string)=>mine.filter((total)=>total.component===component).reduce((sum,total)=>sum+total.tokens,0);
  const cacheRead=tokens("cacheRead"),prompt=cacheRead+tokens("input")+tokens("cacheWrite");
  return prompt>0?clamp(cacheRead*100/prompt):null;
}

type AccountReading={left:number;expected:number|null;usage:PlanAccountUsage};

function accountReading(store:Store,account:Account,metric:PlanMetric,maxReadingAgeMs:number,now:number):AccountReading{
  // Banked resets belong to the account, not to one meter, so every reading
  // this account produces carries the same balance.
  const credits=store.resetCredits(account.id);
  const banked={
    bankedResets:credits?.available??null,
    bankedResetsAt:iso(credits?.at),
    bankedResetExpiresAt:iso(credits?.nextExpiresAt),
  };
  const readings=metric.meters.flatMap((meterId)=>{
    const declared=catalogMeter(meterId),reading=store.latestReading(account.id,meterId);
    if(!declared||!reading)return[];
    const left=clamp(100-reading.usedPercent);
    const expected=reading.resetAt&&reading.resetAt>now?clamp((reading.resetAt-now)*100/(declared.windowHours*3_600_000)):null;
    return[{left,expected,at:reading.at,usage:{
      accountId:account.id,
      accountLabel:account.label?.trim()||account.id,
      state:"ready" as const,
      percentLeft:left,
      usedPercent:clamp(reading.usedPercent),
      meterId,
      windowHours:declared.windowHours,
      readingAt:iso(reading.at),
      resetAt:iso(reading.resetAt),
      ...banked,
    }}];
  });
  const fresh=readings.filter((reading)=>reading.at<=now+60_000&&now-reading.at<=maxReadingAgeMs).sort((a,b)=>a.left-b.left)[0];
  if(fresh)return fresh;
  const stale=readings.filter((reading)=>reading.at<=now+60_000).sort((a,b)=>a.left-b.left)[0];
  if(stale)return{...stale,expected:null,usage:{...stale.usage,state:"stale"}};
  return{left:0,expected:null,usage:{accountId:account.id,accountLabel:account.label?.trim()||account.id,state:"unavailable",percentLeft:null,usedPercent:null,meterId:null,windowHours:null,readingAt:null,resetAt:null,...banked}};
}

function plan(store:Store,definition:PlanDefinition,totals:readonly UsageTotal[],now:number):PlanUsage{
  const accounts=store.accounts().filter((account)=>account.provider===definition.provider&&account.enabled),coverage:number[]=[];
  const accountIds=new Set(accounts.map((account)=>account.id));
  const metrics=Object.fromEntries(definition.metrics.map((metric)=>{
    const accountReadings=accounts.map((account)=>accountReading(store,account,metric,definition.maxReadingAgeMs,now));
    const values=accountReadings.filter((reading)=>reading.usage.state==="ready");
    coverage.push(values.length);
    const timed=values.filter((value):value is AccountReading&{expected:number}=>value.expected!==null),left=mean(values.map((value)=>value.left)),expected=mean(timed.map((value)=>value.expected));
    return[metric.id,{percentLeft:rounded(left),expectedPercentLeft:rounded(expected),paceDelta:left===null||expected===null?null:rounded(left-expected),cachePercent:rounded(cachePercent(totals,metric.model,accountIds)),accounts:accountReadings.map((reading)=>reading.usage)}];
  }));
  const checked=coverage.length?Math.min(...coverage):0;return{state:accounts.length>0&&checked===accounts.length?"ready":checked>0?"partial":"unavailable",metrics,planCount:accounts.length,checkedCount:checked};
}

export class OrchestratorClient{
  private readonly store:Store;
  constructor(options:OrchestratorClientOptions){this.store=Store.open(options.ledgerPath);}
  accounts(provider?:string){return this.store.accounts().filter((account)=>!provider||account.provider===provider);}
  boost(provider:string):number{return Number(this.store.control(`boost:${provider}`)??"1");}
  setBoost(provider:string,multiplier:number):void{this.store.setControl(`boost:${provider}`,String(multiplier));}
  plans(definitions:readonly PlanDefinition[]=ORCHESTRATOR_CATALOG.plans,now=Date.now()):PlanUsageSnapshot{const totals=this.store.usageSince(now-CACHE_WINDOW_MS);return{plans:Object.fromEntries(definitions.map((definition)=>[definition.id,plan(this.store,definition,totals,now)])),updatedAt:new Date(now).toISOString()};}
  async refreshPlanFacts(_agentDir:string):Promise<void>{}
  close():void{this.store.close();}
}
