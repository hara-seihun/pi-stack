import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Store } from "../store.js";

const COMPONENTS=["input","output","cacheRead","cacheWrite"] as const;
const SOURCE=process.env.PI_ORCHESTRATOR_ASSIGNED==="1"?"fleet":"interactive";
export function defaultLedgerPath():string{return process.env.PI_ORCHESTRATOR_LEDGER??join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");}
export function baseProvider(provider:string):string{return provider.replace(/-\d+$/u,"");}
export interface MeterReading{readonly at:number;readonly usedPercent:number;readonly resetAt?:number;}
export function anthropicMeterReadings(headers:Record<string,string>,at:number):{meterId:string;reading:MeterReading}[]{const values=[];for(const window of ["5h","7d","7d_oi"]){const utilization=headers[`anthropic-ratelimit-unified-${window}-utilization`];if(utilization===undefined)continue;const reset=Number(headers[`anthropic-ratelimit-unified-${window}-reset`]);values.push({meterId:`anthropic-${window}`,reading:{at,usedPercent:Number(utilization)*100,resetAt:Number.isFinite(reset)?reset*1000:undefined}});}return values;}

export default function usageLogger(pi:ExtensionAPI):void{
  let store:Store|undefined,lastLog=0;const open=()=>store??=Store.open(defaultLedgerPath());
  const guard=(action:()=>void)=>{try{action();}catch(error){if(Date.now()-lastLog>60_000){lastLog=Date.now();console.error(`pi-orchestrator usage: ${String(error)}`);}}};
  pi.on("message_end",async(event,ctx)=>{
    const message=event.message as any;
    if(message.role!=="assistant"||!message.usage)return;
    guard(()=>{const account=message.provider,known=open().account(account);if(!known)return;const hour=Math.floor(Date.now()/3_600_000)*3_600_000,runId=process.env.PI_ORCHESTRATOR_RUN_ID??null,model=message.model,sessionId=ctx.sessionManager.getSessionId();for(const component of COMPONENTS){const tokens=message.usage[component];if(tokens<=0)continue;open().db.prepare(`INSERT INTO usage_hour(account_id,hour,source,run_id,model,tokens) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,hour,source,run_id,model) DO UPDATE SET tokens=tokens+excluded.tokens`).run(account,hour,SOURCE,runId??sessionId,model,tokens);}});
  });
  pi.on("after_provider_response",async(event,ctx)=>{const account=ctx.model?.provider;if(!account||baseProvider(account)!=="anthropic")return;guard(()=>{if(!open().account(account))return;for(const {meterId,reading} of anthropicMeterReadings(event.headers,Date.now()))open().recordMeter(account,meterId,reading.usedPercent,reading.resetAt,reading.at);});});
  pi.on("session_shutdown",()=>{store?.close();store=undefined;});
}
