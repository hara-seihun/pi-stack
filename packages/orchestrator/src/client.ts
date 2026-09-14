import { ORCHESTRATOR_CATALOG, catalogAgentType, catalogMeter, type PlanDefinition } from "./catalog.js";
import { Store } from "./store.js";
import { type UsageTotal } from "./domain.js";

export const CACHE_WINDOW_MS=24*3_600_000;
export interface PlanMetricUsage{readonly percentLeft:number|null;readonly expectedPercentLeft:number|null;readonly paceDelta:number|null;readonly cachePercent:number|null;}
export interface PlanUsage{readonly state:"ready"|"partial"|"unavailable";readonly metrics:Readonly<Record<string,PlanMetricUsage>>;readonly planCount:number;readonly checkedCount:number;}
export interface PlanUsageSnapshot{readonly plans:Readonly<Record<string,PlanUsage>>;readonly updatedAt:string;}
export interface OrchestratorClientOptions{readonly ledgerPath:string;}

const clamp=(value:number)=>Math.max(0,Math.min(100,value));
const mean=(values:number[]):number|null=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const rounded=(value:number|null)=>value===null?null:Math.round(value);

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

function plan(store:Store,definition:PlanDefinition,totals:readonly UsageTotal[],now:number):PlanUsage{
  const accounts=store.accounts().filter((account)=>account.provider===definition.provider&&account.enabled),coverage:number[]=[];
  const accountIds=new Set(accounts.map((account)=>account.id));
  const metrics=Object.fromEntries(definition.metrics.map((metric)=>{
    const values=accounts.flatMap((account)=>{
      const available=metric.meters.flatMap((meterId)=>{const declared=catalogMeter(meterId),reading=store.latestReading(account.id,meterId);if(!declared||!reading||reading.at>now+60_000||now-reading.at>definition.maxReadingAgeMs)return[];const expected=reading.resetAt&&reading.resetAt>now?clamp((reading.resetAt-now)*100/(declared.windowHours*3_600_000)):null;return[{left:clamp(100-reading.usedPercent),expected}];}).sort((a,b)=>a.left-b.left)[0];return available?[available]:[];
    });
    coverage.push(values.length);const timed=values.filter((value):value is {left:number;expected:number}=>value.expected!==null),left=mean(values.map((value)=>value.left)),expected=mean(timed.map((value)=>value.expected));
    return[metric.id,{percentLeft:rounded(left),expectedPercentLeft:rounded(expected),paceDelta:left===null||expected===null?null:rounded(left-expected),cachePercent:rounded(cachePercent(totals,metric.model,accountIds))}];
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
