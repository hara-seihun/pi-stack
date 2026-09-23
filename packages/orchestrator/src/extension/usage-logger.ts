import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Store } from "../store.js";

const COMPONENTS=["input","output","cacheRead","cacheWrite"] as const;
const environment=():NodeJS.ProcessEnv=>(globalThis as any)[Symbol.for("pi-stack.session-environment")]?.getStore()??process.env;
export function defaultLedgerPath():string{return process.env.PI_ORCHESTRATOR_LEDGER??join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");}
export function baseProvider(provider:string):string{return provider.replace(/-\d+$/u,"");}
export interface MeterReading{readonly at:number;readonly usedPercent:number;readonly resetAt?:number;}
export function anthropicMeterReadings(headers:Record<string,string>,at:number):{meterId:string;reading:MeterReading}[]{const values:ReturnType<typeof anthropicMeterReadings>=[];for(const window of ["5h","7d","7d_oi"]){const utilization=headers[`anthropic-ratelimit-unified-${window}-utilization`];if(utilization===undefined)continue;const reset=Number(headers[`anthropic-ratelimit-unified-${window}-reset`]);values.push({meterId:`anthropic-${window}`,reading:{at,usedPercent:Number(utilization)*100,resetAt:Number.isFinite(reset)?reset*1000:undefined}});}return values;}

export function recordModelUsage(store:Store,account:string,model:string,usage:Usage,sessionId:string):void{
  if(!store.account(account))return;
  const env=environment(),source=env.PI_ORCHESTRATOR_ASSIGNED==="1"||env.PI_ORCHESTRATOR_CORE_USAGE==="worker"?"fleet":"interactive";
  const hour=Math.floor(Date.now()/3_600_000)*3_600_000,runId=env.PI_ORCHESTRATOR_RUN_ID??sessionId;
  for(const component of COMPONENTS){const tokens=usage[component];if(tokens>0)store.recordUsage({accountId:account,hour,source,runId,model,component,tokens});}
}

export default function usageLogger(pi:ExtensionAPI):void{
  let store:Store|undefined,lastLog=0;const open=()=>store??=Store.open(defaultLedgerPath());
  const guard=(action:()=>void)=>{try{action();}catch(error){if(Date.now()-lastLog>60_000){lastLog=Date.now();console.error(`pi-orchestrator usage: ${String(error)}`);}}};
  if(environment().PI_ORCHESTRATOR_CORE_USAGE!=="worker")pi.on("message_end",async(event,ctx)=>{
    const message=event.message as any;
    if(message.role!=="assistant"||!message.usage)return;
    guard(()=>recordModelUsage(open(),message.provider,message.model,message.usage,ctx.sessionManager.getSessionId()));
  });
  pi.on("after_provider_response",async(event,ctx)=>{const account=ctx.model?.provider;if(!account||baseProvider(account)!=="anthropic")return;guard(()=>{if(!open().account(account))return;for(const {meterId,reading} of anthropicMeterReadings(event.headers,Date.now()))open().recordMeter(account,meterId,reading.usedPercent,reading.resetAt,reading.at);});});
  pi.on("session_shutdown",()=>{store?.close();store=undefined;});
}
