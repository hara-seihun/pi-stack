import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { defaultSharedAuthPath, SharedOAuthAuth, sharedOAuthProvider } from "../auth/shared-oauth.js";
import { isRateLimitError, rateLimitCooldownMs } from "../provider-errors.js";
import { interruptedTurnPrompt } from "../host/continuations.js";

export function defaultLedgerPath():string{return process.env.PI_ORCHESTRATOR_LEDGER??join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");}
export function baseProvider(provider:string):string{return provider.replace(/-\d+$/u,"");}
export function failoverPrompt(failure:string,account:string):string{return interruptedTurnPrompt(failure,`This session moved to another account (${account}) and is ready to keep going.`);}

export default function routing(pi:ExtensionAPI):void{
  const ledgerPath=defaultLedgerPath(),store=Store.open(ledgerPath),families=new Map(builtinProviders().map((provider)=>[provider.id,provider]));
  const shared=new Map<string,SharedOAuthAuth>();
  for(const family of families.values()){
    const oauth=family.auth.oauth;if(!oauth)continue;
    shared.set(family.id,new SharedOAuthAuth({path:defaultSharedAuthPath(ledgerPath),providerId:family.id,refresh:(credential,signal)=>oauth.refresh(credential,signal),toAuth:(credential)=>oauth.toAuth(credential),identity:family.id==="openai-codex"?(credential)=>typeof (credential as any).accountId==="string"?(credential as any).accountId:undefined:undefined}));
  }
  for(const account of store.accounts()){
    const family=families.get(account.provider),auth=shared.get(account.provider);if(!family||!auth)continue;
    pi.registerProvider(sharedOAuthProvider(family,account.id,account.label,auth));
  }
  if(process.env.PI_ORCHESTRATOR_ASSIGNED==="1"){pi.on("session_shutdown",()=>store.close());return;}
  const familyOf=(provider:string)=>store.account(provider)?.provider??baseProvider(provider);
  const resolve=(accountId:string,family:string,modelId:string):Model<never>|undefined=>{const model=families.get(family)?.getModels().find((candidate)=>candidate.id===modelId);return model?(accountId===family?model:{...model,provider:accountId}) as Model<never>:undefined;};
  const choose=(family:string,exclude=new Set<string>())=>store.accounts().filter((account)=>account.provider===family&&account.enabled&&!exclude.has(account.id)&&(!account.cooldownUntil||account.cooldownUntil<=Date.now())&&shared.get(family)?.has(account.id)).sort((a,b)=>{
    const spent=(id:string)=>Math.max(0,...store.latestMeters(id).map((meter)=>Number(meter.used_percent)));
    return spent(a.id)-spent(b.id)||store.activeLeases(a.id).length-store.activeLeases(b.id).length||a.id.localeCompare(b.id);
  })[0];
  const bind=async(ctx:ExtensionContext,exclude?:Set<string>,requested?:{family:string;modelId:string}):Promise<string|undefined>=>{
    const current=ctx.model;if(!current&&!requested)return;
    const family=requested?.family??familyOf(current!.provider),modelId=requested?.modelId??current!.id,choice=choose(family,exclude);
    if(!choice)return;
    if(choice.id===current?.provider&&modelId===current.id)return;
    const next=resolve(choice.id,family,modelId);if(!next)return;
    await ctx.modelRegistry.refresh({providers:[choice.id],allowNetwork:false});
    return await pi.setModel(next)?choice.id:undefined;
  };
  let leaseId:string|undefined,timer:ReturnType<typeof setInterval>|undefined;
  pi.on("session_start",async(event,ctx)=>{
    const branch=ctx.sessionManager.getBranch(),history=branch.some((entry)=>entry.type==="message"&&entry.message.role==="assistant");
    if(history){let selected:{provider:string;modelId:string}|undefined;for(const entry of branch)if(entry.type==="model_change")selected={provider:entry.provider,modelId:entry.modelId};if(selected){const family=familyOf(selected.provider),saved=resolve(selected.provider,family,selected.modelId);await ctx.modelRegistry.refresh({providers:[selected.provider],allowNetwork:false});if(!(saved&&await pi.setModel(saved)))await bind(ctx,undefined,{family,modelId:selected.modelId});}}
    else if(event.reason==="startup"||event.reason==="new")await bind(ctx);
    const account=ctx.model?.provider;if(store.account(account??"")){leaseId=`interactive:${ctx.sessionManager.getSessionId()}`;store.createLease(leaseId!,account!,"interactive");timer=setInterval(()=>store.heartbeatLease(leaseId!),30_000);}
  });
  let unresolved:{failure:string;account:string}|undefined;
  pi.on("agent_end",async(event,ctx)=>{unresolved=undefined;const last=event.messages.at(-1) as any;if(last?.role!=="assistant"||last.stopReason!=="error"||!isRateLimitError(last.errorMessage??""))return;const failing=ctx.model?.provider;if(!failing)return;if(store.account(failing))store.setCooldown(failing,Date.now()+rateLimitCooldownMs(last.errorMessage));const moved=await bind(ctx,new Set([failing]));if(moved)unresolved={failure:last.errorMessage,account:moved};});
  pi.on("agent_settled",()=>{const notice=unresolved;unresolved=undefined;if(notice)pi.sendUserMessage(failoverPrompt(notice.failure,notice.account));});
  pi.on("session_shutdown",()=>{if(timer)clearInterval(timer);if(leaseId)store.endLease(leaseId);store.close();});
}
