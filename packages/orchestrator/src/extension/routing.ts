import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources, getSupportedThinkingLevels, type Model, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { allowsAccountUse } from "../domain.js";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import { defaultSharedAuthPath, SharedOAuthAuth, providerOAuth, sharedOAuthProvider } from "../auth/shared-oauth.js";
import { isRateLimitError, isRejectedTokenError, rateLimitCooldownMs } from "../provider-errors.js";
import { withAnthropicFiles } from "../auth/anthropic-files-provider.js";
import { chooseInteractiveAccount } from "../auth/account-selection.js";
import { installImageGeneration } from "./image-generation.js";
import { installProviderOperations } from "./provider-operation.js";
import { interruptedTurnPrompt } from "../host/continuations.js";
import customModelConfig from "../models.json" with { type: "json" };
import { modelBrokerUrl } from "../model-broker-contract.js";
import { installBrokerRouting } from "./broker-routing.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export function defaultLedgerPath(env:NodeJS.ProcessEnv=process.env):string{return env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");}

export function resolveSessionModel(models:readonly Model<any>[],provider:string,modelId:string,env:NodeJS.ProcessEnv=process.env):
  {ok:true;model:Model<any>}|{ok:false;error:string} {
  if(modelBrokerUrl(env)){
    const model=models.find(model=>model.id===modelId&&model.provider===baseProvider(provider));
    return model?{ok:true,model}:{ok:false,error:`Model not found through model broker: ${provider}/${modelId}`};
  }
  const candidates=models.filter(model=>model.id===modelId);
  const aliases=candidates.filter(model=>baseProvider(model.provider)===provider&&model.provider!==provider);
  const family=builtinProviders().find(family=>family.id===provider&&family.auth.oauth);
  if(!aliases.length||!family){
    const model=candidates.find(model=>model.provider===provider);
    return model?{ok:true,model}:{ok:false,error:`Model not found: ${provider}/${modelId}`};
  }
  const store=Store.open(defaultLedgerPath(env));
  try{
    const shared=providerOAuth(family,env.PI_ORCHESTRATOR_AUTH??defaultSharedAuthPath(defaultLedgerPath(env)));
    const available=new Set(candidates.map(model=>model.provider));
    const exclude=new Set(store.accounts().filter(account=>!available.has(account.id)).map(account=>account.id));
    const assigned=env.PI_ORCHESTRATOR_ASSIGNED==="1"&&env.PI_ORCHESTRATOR_RUN_ID?store.run(env.PI_ORCHESTRATOR_RUN_ID):undefined;
    const account=assigned?.accountId?store.account(assigned.accountId):chooseInteractiveAccount(store,shared,provider,exclude);
    if(account&&account.provider===provider&&available.has(account.id)&&shared.has(account.id)){
      const model=candidates.find(model=>model.provider===account.id)!;
      return {ok:true,model};
    }
    const cooling=store.accounts().filter(account=>account.provider===provider&&allowsAccountUse(account,"interactive")&&shared.has(account.id)&&account.cooldownUntil&&account.cooldownUntil>Date.now());
    const resume=cooling.length?` Earliest cooldown ends at ${new Date(Math.min(...cooling.map(account=>account.cooldownUntil!))).toISOString()}.`:"";
    return {ok:false,error:`No eligible pooled account for ${provider}/${modelId}.${resume}`};
  }finally{store.close();}
}
export function baseProvider(provider:string):string{return provider.replace(/-\d+$/u,"");}
export function failoverPrompt(failure:string,account:string):string{return interruptedTurnPrompt(failure,`This session moved to another account (${account}) and is ready to keep going.`);}
export function credentialRepairPrompt(failure:string,account:string):string{return interruptedTurnPrompt(failure,`The credential for ${account} was refreshed and this session is ready to keep going on the same account.`);}
export function withCustomModels(provider:Provider):Provider{
  if(provider.id!=="anthropic")return provider;
  const custom=customModelConfig.providers.anthropic.models as unknown as Model<"anthropic-messages">[];
  return{...provider,getModels:()=>{const replacements=new Map(custom.map((model)=>[model.id,model]));return[...provider.getModels().filter((model)=>!replacements.has(model.id)),...custom];}};
}

export default function routing(pi:ExtensionAPI):void{
  let closed=false;
  const lifecycle=new AbortController();
  const environment:NodeJS.ProcessEnv=(globalThis as any)[Symbol.for("pi-stack.session-environment")]?.getStore()??process.env;
  const brokerUrl=modelBrokerUrl(environment);
  if(brokerUrl){installBrokerRouting(pi,brokerUrl,builtinProviders().map(withCustomModels),defaultLedgerPath(environment),environment);return;}
  const ledgerPath=defaultLedgerPath(environment),store=Store.open(ledgerPath),families=new Map(builtinProviders().map((raw)=>{const provider=withAnthropicFiles(withCustomModels(raw));return[provider.id,provider] as const;}));
  pi.registerProvider(families.get("anthropic")!);
  const shared=new Map<string,SharedOAuthAuth>();
  for(const family of families.values()){
    const oauth=family.auth.oauth;if(!oauth)continue;
    shared.set(family.id,providerOAuth(family,environment.PI_ORCHESTRATOR_AUTH??defaultSharedAuthPath(ledgerPath)));
  }
  const assigned=environment.PI_ORCHESTRATOR_ASSIGNED==="1"&&environment.PI_ORCHESTRATOR_RUN_ID?store.run(environment.PI_ORCHESTRATOR_RUN_ID):undefined;
  for(const account of store.accounts()){
    const family=families.get(account.provider),auth=shared.get(account.provider);if(!family||!auth||(!allowsAccountUse(account,"interactive")&&assigned?.accountId!==account.id))continue;
    pi.registerProvider(sharedOAuthProvider(family,account.id,account.label,auth));
  }
  installImageGeneration(pi, store, shared.get("openai-codex"));
  installProviderOperations(pi, store, shared);
  // The bundled CLI and extension providers have separate pi-ai resource registries.
  pi.on("session_shutdown",(_event,ctx)=>cleanupSessionResources(ctx.sessionManager.getSessionId()));
  const familyOf=(provider:string)=>store.account(provider)?.provider??baseProvider(provider);
  const resolve=(accountId:string,family:string,modelId:string):Model<never>|undefined=>{const model=families.get(family)?.getModels().find((candidate)=>candidate.id===modelId);return model?(accountId===family?model:{...model,provider:accountId}) as Model<never>:undefined;};
  const choose=(family:string,exclude=new Set<string>())=>chooseInteractiveAccount(store,shared.get(family),family,exclude);
  const select=async(ctx:ExtensionContext,model:Model<never>,thinking:ThinkingLevel):Promise<boolean>=>{
    if(closed)return false;
    await ctx.modelRegistry.refresh({providers:[model.provider],allowNetwork:false,signal:lifecycle.signal});
    if(closed||!await pi.setModel(model)||closed)return false;
    pi.setThinkingLevel(thinking);
    return true;
  };
  const bind=async(ctx:ExtensionContext,exclude?:Set<string>,requested?:{family:string;modelId:string;thinking:ThinkingLevel}):Promise<string|undefined>=>{
    const current=ctx.model,thinking=requested?.thinking??pi.getThinkingLevel();if(!current&&!requested)return;
    const family=requested?.family??familyOf(current!.provider),modelId=requested?.modelId??current!.id,choice=choose(family,exclude);
    if(!choice)return;
    if(!requested&&choice.id===current?.provider&&modelId===current.id)return choice.id;
    const next=resolve(choice.id,family,modelId);if(!next)return;
    return await select(ctx,next,thinking)?choice.id:undefined;
  };
  const requestedPin=environment.PI_SUBAGENT_MODEL;
  const pinned=assigned?.provider&&assigned.model?{provider:assigned.provider,model:assigned.model,thinking:assigned.thinking}:ORCHESTRATOR_CATALOG.models.find(model=>model.id===requestedPin||model.model===requestedPin);
  const hasPin=!!pinned||!!requestedPin;
  const matchesPin=(ctx:ExtensionContext)=>{
    if(!hasPin)return true;
    if(!pinned||ctx.model?.id!==pinned.model||familyOf(ctx.model.provider)!==pinned.provider)return false;
    const account=store.account(ctx.model.provider);
    return !!account&&!!shared.get(pinned.provider)?.has(account.id)&&!!(assigned||allowsAccountUse(account,"interactive"));
  };
  const enforcePin=async(ctx:ExtensionContext)=>{
    if(matchesPin(ctx))return;
    if(!pinned){void ctx.abort();throw new Error(`Unknown subagent model pin ${requestedPin}`);}
    const current=store.account(ctx.model?.provider??"");
    const accountId=assigned?.accountId??(current?.provider===pinned.provider&&allowsAccountUse(current,"interactive")?current.id:choose(pinned.provider)?.id);
    const model=accountId?resolve(accountId,pinned.provider,pinned.model):undefined;
    if(!model||!await select(ctx,model,assigned?.thinking as ThinkingLevel??(pi.getThinkingLevel()==="off"?pinned.thinking as ThinkingLevel:pi.getThinkingLevel()))){
      void ctx.abort();throw new Error(`Pinned model ${pinned.provider}/${pinned.model} has no available account`);
    }
  };
  if(hasPin){
    pi.on("session_start",async(_event,ctx)=>enforcePin(ctx));
    pi.on("model_select",async(_event,ctx)=>enforcePin(ctx));
    pi.on("before_agent_start",async(_event,ctx)=>enforcePin(ctx));
    pi.on("before_provider_request",(_event,ctx)=>{
      if(!matchesPin(ctx)){void ctx.abort();throw new Error(`Model change refused: this run is pinned to ${pinned?.model??requestedPin}`);}
    });
  }
  if(environment.PI_ORCHESTRATOR_ASSIGNED==="1"){pi.on("session_shutdown",()=>{if(closed)return;closed=true;lifecycle.abort();store.close();});return;}
  let leaseId:string|undefined,leasedAccount:string|undefined,timer:ReturnType<typeof setInterval>|undefined;
  let running=false,turnActive=false,compacting=false;
  const releaseLease=()=>{
    if(timer)clearInterval(timer);
    if(leaseId)store.endLease(leaseId);
    timer=undefined;leaseId=undefined;leasedAccount=undefined;
  };
  const reconcileLease=(ctx:ExtensionContext)=>{
    if(closed)return;
    const account=ctx.model?.provider;
    if((running||compacting)&&store.account(account??"")){
      if(leasedAccount===account)return;
      releaseLease();
      leaseId=`interactive:${ctx.sessionManager.getSessionId()}`;
      store.createLease(leaseId,account!,"interactive");
      leasedAccount=account;
      const id=leaseId;
      timer=setInterval(()=>store.heartbeatLease(id),30_000);
      timer.unref?.();
    }else releaseLease();
  };
  // A model selection does not move the request already in flight.
  pi.on("model_select",(_event,ctx)=>{if(!turnActive&&!compacting)reconcileLease(ctx);});
  pi.on("agent_start",(_event,ctx)=>{running=true;reconcileLease(ctx);});
  pi.on("turn_start",(_event,ctx)=>{turnActive=true;reconcileLease(ctx);});
  pi.on("turn_end",(_event,ctx)=>{turnActive=false;reconcileLease(ctx);});
  pi.on("session_before_compact",(_event,ctx)=>{compacting=true;reconcileLease(ctx);});
  const compactEnded=(_event:unknown,ctx:ExtensionContext)=>{compacting=false;reconcileLease(ctx);};
  pi.on("session_compact",compactEnded);
  pi.on("session_compact_failed",compactEnded);
  pi.on("session_start",async(event,ctx)=>{
    const branch=ctx.sessionManager.getBranch(),history=branch.some((entry)=>entry.type==="message"&&entry.message.role==="assistant");
    if(hasPin){await enforcePin(ctx);}
    else if(history){
      let selected:{provider:string;modelId:string}|undefined;
      let thinking=pi.getThinkingLevel();
      for(const entry of branch){
        if(entry.type==="model_change")selected={provider:entry.provider,modelId:entry.modelId};
        else if(entry.type==="thinking_level_change")thinking=entry.thinkingLevel as ThinkingLevel;
      }
      if(selected){
        const family=familyOf(selected.provider),saved=resolve(selected.provider,family,selected.modelId),account=store.account(selected.provider);
        if(saved&&ctx.model?.provider===selected.provider&&ctx.model.id===selected.modelId&&getSupportedThinkingLevels(saved).includes(pi.getThinkingLevel())){
          thinking=pi.getThinkingLevel();
        }
        if(!(saved&&account&&allowsAccountUse(account,"interactive")&&await select(ctx,saved,thinking))){
          await bind(ctx,undefined,{family,modelId:selected.modelId,thinking});
        }
      }
    }
    else{
      const explicit=ctx.model?.provider&&/-\d+$/.test(ctx.model.provider)?store.account(ctx.model.provider):undefined;
      const retain=explicit&&allowsAccountUse(explicit,"interactive")
        &&(!explicit.cooldownUntil||explicit.cooldownUntil<=Date.now())&&shared.get(explicit.provider)?.has(explicit.id);
      if(!retain)await bind(ctx);
    }
    reconcileLease(ctx);
  });
  pi.on("before_agent_start",async(_event,ctx)=>{
    const current=store.account(ctx.model?.provider??"");
    if(current&&!allowsAccountUse(current,"interactive")){
      const moved=await bind(ctx,new Set([current.id]));
      if(!moved)throw new Error(`Account ${current.id} is unavailable for interactive agents; no shared account is available`);
      reconcileLease(ctx);
    }
  });
  let unresolved:{failure:string;account:string;prompt:(failure:string,account:string)=>string}|undefined;
  /**
   * Accounts this session has already had a token refreshed for. A provider
   * that keeps refusing a freshly issued token is not going to be talked
   * round by a third one, and retrying would spin the session between the
   * same two states forever, so the second rejection falls through to
   * ordinary failover.
   */
  const repaired=new Set<string>();
  /**
   * A rejected access token is the account's problem, not the session's, and
   * it is usually one refresh away from fixed: providers invalidate issued
   * tokens when an auth session rotates, well before the expiry the store
   * knows about. Repairing it in place keeps the session on the account it
   * has context and quota on, instead of failing the turn or migrating it
   * away over a token.
   */
  const repairCredential=async(account:string):Promise<boolean>=>{
    const auth=shared.get(familyOf(account));if(!auth||!store.account(account)||repaired.has(account))return false;
    repaired.add(account);
    try{
      const signal=AbortSignal.any([lifecycle.signal,AbortSignal.timeout(30_000)]);
      const current=await auth.credential(account,signal);
      await auth.refreshRejected(account,current.access,signal);
      return true;
    }catch{return false;}
  };
  pi.on("agent_end",async(event,ctx)=>{
    if(closed)return;
    turnActive=false;
    unresolved=undefined;
    const last=event.messages.at(-1) as any;
    if(last?.role!=="assistant"||last.stopReason!=="error")return;
    const failure:string=last.errorMessage??"";
    const failing:string|undefined=last.provider;if(!failing)return;
    // A user-selected replacement must not be blamed or overwritten by the prior request.
    if(failing!==ctx.model?.provider)return;
    if(isRejectedTokenError(failure)){
      const repairedCredential=await repairCredential(failing);
      if(closed||ctx.model?.provider!==failing)return;
      if(repairedCredential){unresolved={failure,account:failing,prompt:credentialRepairPrompt};return;}
    }
    if(!isRateLimitError(failure))return;
    if(store.account(failing))store.setCooldown(failing,Date.now()+rateLimitCooldownMs(failure));
    const moved=await bind(ctx,new Set([failing]));
    if(moved&&!closed)unresolved={failure,account:moved,prompt:failoverPrompt};
  });
  pi.on("agent_settled",(_event,ctx)=>{
    if(closed)return;
    if(ctx.isIdle()){running=false;turnActive=false;reconcileLease(ctx);}
    const notice=unresolved;unresolved=undefined;
    if(notice)pi.sendUserMessage(notice.prompt(notice.failure,notice.account));
  });
  pi.on("session_shutdown",()=>{if(closed)return;closed=true;lifecycle.abort();unresolved=undefined;releaseLease();store.close();});
}
