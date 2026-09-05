import { readFileSync } from "node:fs";
import { ORCHESTRATOR_CATALOG, catalogAgentType, catalogMeter, type PlanDefinition } from "./catalog.js";
import { Store } from "./store.js";
import type { Run, UsageTotal } from "./domain.js";

export const CACHE_WINDOW_MS=24*3_600_000;
export interface PlanMetricUsage{readonly percentLeft:number|null;readonly expectedPercentLeft:number|null;readonly paceDelta:number|null;readonly cachePercent:number|null;}
export interface PlanUsage{readonly state:"ready"|"partial"|"unavailable";readonly metrics:Readonly<Record<string,PlanMetricUsage>>;readonly planCount:number;readonly checkedCount:number;}
export interface PlanUsageSnapshot{readonly plans:Readonly<Record<string,PlanUsage>>;readonly updatedAt:string;}
export interface ObservedRun{
  readonly id:string;readonly taskId:string;readonly model:string;readonly thinking?:string;readonly provider?:string;
  readonly state:string;readonly startedAt:number;readonly endedAt?:number;readonly detail?:string;readonly observable:boolean;
  readonly live:{activity:string;liveText:string;liveThinking:string;activeTool:string|null}|null;
}
export interface RunListing{readonly runs:readonly ObservedRun[];readonly running:number;readonly models:readonly {model:string;count:number}[];}
export interface TranscriptTail{readonly run:ObservedRun|null;readonly size:number;readonly offset:number;readonly next:number;readonly chunk:string;}
export interface OrchestratorObserver{listRuns(limit:number):Promise<RunListing>;tailRun(runId:string,offset:number,maxBytes:number,watch:boolean):Promise<TranscriptTail>;close():void;}
export interface OrchestratorClientOptions{readonly ledgerPath:string;readonly runsRoot?:string;}

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

export function tailRange(size:number,offset:number,maxBytes:number):{start:number;end:number;fresh:boolean}{const fresh=offset<0||offset>size,start=fresh?Math.max(0,size-maxBytes):offset;return{start,end:Math.min(size,start+maxBytes),fresh};}
function transformedSession(path:string):string{
  let raw="";try{raw=readFileSync(path,"utf8");}catch{return"";}
  let seq=0;const lines:string[]=[];const add=(time:string,type:string,payload:Record<string,unknown>)=>lines.push(JSON.stringify({seq:++seq,time,type,payload}));
  for(const line of raw.split("\n")){if(!line)continue;let entry:any;try{entry=JSON.parse(line);}catch{continue;}if(entry.type!=="message")continue;const message=entry.message,time=entry.timestamp??new Date(message?.timestamp??Date.now()).toISOString();
    if(message?.role==="user"){const text=(message.content??[]).filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("");if(text)add(time,"user",{text});}
    else if(message?.role==="assistant")for(const part of message.content??[]){if(part.type==="thinking")add(time,"thinking",{text:part.thinking??part.text??""});else if(part.type==="text")add(time,"assistant",{text:part.text??""});else if(part.type==="toolCall")add(time,"tool_start",{toolCallId:part.id,name:part.name,args:part.arguments??{}});}
    else if(message?.role==="toolResult")add(time,"tool_end",{toolCallId:message.toolCallId,name:message.toolName,output:(message.content??[]).map((part:any)=>part.text??"").join("\n"),error:!!message.isError});
  }
  return lines.length?`${lines.join("\n")}\n`:"";
}

export class OrchestratorClient implements OrchestratorObserver{
  private readonly store:Store;
  constructor(private readonly options:OrchestratorClientOptions){this.store=Store.open(options.ledgerPath);}
  accounts(provider?:string){return this.store.accounts().filter((account)=>!provider||account.provider===provider);}
  boost(provider:string):number{return Number(this.store.control(`boost:${provider}`)??"1");}
  setBoost(provider:string,multiplier:number):void{this.store.setControl(`boost:${provider}`,String(multiplier));}
  beginVoiceLease(accountId:string):string{
    const account=this.store.account(accountId);if(!account||!account.enabled)throw new Error(`voice account ${accountId} is unavailable`);
    if(this.store.activeLeases(accountId).length>=account.concurrency)throw new Error(`voice account ${accountId} reached its concurrency limit`);
    const id=`voice:${crypto.randomUUID()}`;this.store.createLease(id,accountId,"voice");return id;
  }
  heartbeatLease(id:string):void{this.store.heartbeatLease(id);}
  endLease(id:string):void{this.store.endLease(id);}
  plans(definitions:readonly PlanDefinition[]=ORCHESTRATOR_CATALOG.plans,now=Date.now()):PlanUsageSnapshot{const totals=this.store.usageSince(now-CACHE_WINDOW_MS);return{plans:Object.fromEntries(definitions.map((definition)=>[definition.id,plan(this.store,definition,totals,now)])),updatedAt:new Date(now).toISOString()};}
  async refreshPlanFacts(_agentDir:string):Promise<void>{}
  async listRuns(limit:number):Promise<RunListing>{const active=this.store.runs(["starting","running"]).sort((a,b)=>(b.startedAt??b.createdAt)-(a.startedAt??a.createdAt)),models=new Map<string,number>();for(const run of active)models.set(run.model??"unknown",(models.get(run.model??"unknown")??0)+1);return{runs:active.slice(0,limit).map((run)=>this.decorate(run)),running:active.length,models:[...models].sort().map(([model,count])=>({model,count}))};}
  async tailRun(runId:string,offset:number,maxBytes:number,_watch:boolean):Promise<TranscriptTail>{const run=this.store.run(runId);if(!run)return{run:null,size:0,offset:0,next:0,chunk:""};const text=run.sessionFile?transformedSession(run.sessionFile):"",bytes=Buffer.from(text),range=tailRange(bytes.length,offset,maxBytes);let start=range.start,end=range.end;if(range.fresh&&start>0){const newline=bytes.indexOf(10,start);start=newline<0?end:newline+1;}if(end<bytes.length){const newline=bytes.lastIndexOf(10,end-1);if(newline>=start)end=newline+1;}return{run:this.decorate(run),size:bytes.length,offset:start,next:end,chunk:bytes.subarray(start,end).toString("utf8")};}
  close():void{this.store.close();}
  private decorate(run:Run):ObservedRun{const live=this.store.db.prepare("SELECT * FROM live_state WHERE run_id=?").get(run.id) as any;return{id:run.id,taskId:run.sourceId??run.source,model:run.model??run.profile,thinking:run.thinking,provider:run.provider,state:run.state==="failed"?"error":run.state,startedAt:run.startedAt??run.createdAt,endedAt:run.endedAt,detail:run.result,observable:!!run.sessionFile,live:live?{activity:live.activity,liveText:live.text,liveThinking:live.thinking,activeTool:live.tool??null}:null};}
}
