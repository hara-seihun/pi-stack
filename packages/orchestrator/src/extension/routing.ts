import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { allowsAccountUse } from "../domain.js";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import { defaultSharedAuthPath, SharedOAuthAuth, providerOAuth, sharedOAuthProvider } from "../auth/shared-oauth.js";
import { pooledOnlyProvider } from "../auth/pooled-only.js";
import { isRateLimitError, isRejectedTokenError, providerAccepted, rateLimitCooldownMs } from "../provider-errors.js";
import { isCodexNotFoundError, repairProviderCredential, quarantineProviderCredential, type CredentialRepair } from "../auth/provider-rejection.js";
import { withAnthropicFiles } from "../auth/anthropic-files-provider.js";
import { chooseInteractiveAccount, interactiveQuotaExhausted, interactiveRetryAvailability } from "../auth/account-selection.js";
import { installImageGeneration } from "./image-generation.js";
import { installProviderOperations } from "./provider-operation.js";
import { interruptedTurnPrompt } from "../host/continuations.js";
import { withCustomModels } from "../models.js";
import { BROKER_ROUTES, modelBrokerUrl } from "../model-broker-contract.js";
import { installBrokerRouting } from "./broker-routing.js";
import { codexTierExclusions, requireCodexTier } from "../auth/codex-capabilities.js";
import { withCodexTierGuard } from "../auth/codex-tier-provider.js";
import { requestedSpeedError } from "../threads/speed.js";
import { accountModelExcluded, accountModelUnsupported, noEntitledAccountError, recordAccountModelUnsupported } from "../auth/model-entitlement.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** Families whose credentials live in shared custody rather than with a person. */
const POOLED_FAMILIES=new Set(["openai-codex","anthropic"]);
export const EXPLICIT_THREAD_MODEL_ENV="PI_THREAD_EXPLICIT_MODEL";
export const POOLED_ACCOUNT_WAIT = "Pooled account round finished; awaiting account recovery";

export function pooledRetryAvailability(model:string,env:NodeJS.ProcessEnv=process.env):{available:boolean;retryAt:number}{
  const slash=model.indexOf("/"),family=baseProvider(model.slice(0,slash)),modelId=model.slice(slash+1);
  const provider=builtinProviders().find(provider=>provider.id===family&&provider.auth.oauth);
  if(!provider||!POOLED_FAMILIES.has(family))return {available:true,retryAt:Date.now()};
  const store=Store.open(defaultLedgerPath(env));
  try{
    const auth=providerOAuth(provider,env.PI_ORCHESTRATOR_AUTH??defaultSharedAuthPath(defaultLedgerPath(env)));
    return interactiveRetryAvailability(store,auth,family,modelId);
  }finally{store.close();}
}

export function defaultLedgerPath(env:NodeJS.ProcessEnv=process.env):string{return env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");}

export async function resolveSessionModel(models:readonly Model<any>[],provider:string,modelId:string,env:NodeJS.ProcessEnv=process.env):
  Promise<{ok:true;model:Model<any>}|{ok:false;error:string}> {
  const speedError=requestedSpeedError({provider,id:modelId},env.PI_THREAD_SPEED??"standard");
  if(speedError)return {ok:false,error:speedError};
  if(modelBrokerUrl(env) && baseProvider(provider) in BROKER_ROUTES){
    const model=models.find(model=>model.id===modelId&&model.provider===baseProvider(provider));
    return model?{ok:true,model}:{ok:false,error:`Model not found through model broker: ${provider}/${modelId}`};
  }
  const candidates=models.filter(model=>model.id===modelId);
  const family=builtinProviders().find(family=>family.id===baseProvider(provider)&&family.auth.oauth);
  // Pooled families answer only through an account, even when the family id is
  // the one the caller named: the family provider itself holds no credential.
  if(!family||!candidates.length){
    const model=candidates.find(model=>model.provider===provider);
    return model?{ok:true,model}:{ok:false,error:`Model not found: ${provider}/${modelId}`};
  }
  const store=Store.open(defaultLedgerPath(env));
  try{
    const shared=providerOAuth(family,env.PI_ORCHESTRATOR_AUTH??defaultSharedAuthPath(defaultLedgerPath(env)));
    const available=new Set(candidates.map(model=>model.provider));
    let exclude=new Set(store.accounts().filter(account=>!available.has(account.id)).map(account=>account.id));
    if(family.id==="openai-codex")exclude=await codexTierExclusions(store,shared,modelId,env.PI_THREAD_SPEED,exclude);
    const assigned=env.PI_ORCHESTRATOR_ASSIGNED==="1"&&env.PI_ORCHESTRATOR_RUN_ID?store.run(env.PI_ORCHESTRATOR_RUN_ID):undefined;
    const pinned=env.PI_ORCHESTRATOR_ASSIGNED==="1"?(env.PI_ORCHESTRATOR_ACCOUNT_ID??assigned?.accountId):provider!==family.id?provider:undefined;
    const account=pinned?store.account(pinned):chooseInteractiveAccount(store,shared,family.id,exclude,{includeCooling:true,model:modelId,live:env.PI_THREAD_MODE==="live"});
    if(account&&!exclude.has(account.id)&&account.provider===family.id&&available.has(account.id)&&shared.has(account.id)&&!accountModelExcluded(store,account.id,modelId)){
      const model=candidates.find(model=>model.provider===account.id)!;
      return {ok:true,model};
    }
    const usable=store.accounts().filter(account=>account.provider===family.id&&available.has(account.id)&&!exclude.has(account.id)&&allowsAccountUse(account,"interactive")&&shared.has(account.id));
    if(usable.length&&usable.every(account=>accountModelExcluded(store,account.id,modelId)))return {ok:false,error:noEntitledAccountError(family.id,modelId)};
    // Cooling accounts are admitted above, so reaching here means the pool has
    // nothing this session could use at all. Name the wait anyway when an
    // assigned run is pinned to an account that is cooling.
    const cooling=store.accounts().filter(account=>account.provider===provider&&allowsAccountUse(account,"interactive")&&shared.has(account.id)&&account.cooldownUntil&&account.cooldownUntil>Date.now());
    const resume=cooling.length?` Earliest cooldown ends at ${new Date(Math.min(...cooling.map(account=>account.cooldownUntil!))).toISOString()}.`:"";
    return {ok:false,error:`No eligible pooled account for ${provider}/${modelId}${env.PI_THREAD_SPEED==="ultrafast"?" advertising ultrafast":""}.${resume}`};
  }finally{store.close();}
}
export function baseProvider(provider:string):string{
  const family=provider.replace(/-\d+$/u,"");
  return builtinProviders().some(candidate=>candidate.id===family&&candidate.auth.oauth)?family:provider;
}
export function failoverPrompt(failure:string,account:string):string{return interruptedTurnPrompt(failure,`This session moved to another account (${account}) and is ready to keep going.`);}
export function credentialRepairPrompt(failure:string,account:string):string{return interruptedTurnPrompt(failure,`The credential for ${account} was refreshed and this session is ready to keep going on the same account.`);}

export default function routing(pi:ExtensionAPI):void{
  let closed=false;
  const lifecycle=new AbortController();
  const environment:NodeJS.ProcessEnv=(globalThis as any)[Symbol.for("pi-stack.session-environment")]?.getStore()??process.env;
  const brokerUrl=modelBrokerUrl(environment);
  if(brokerUrl){installBrokerRouting(pi,brokerUrl,builtinProviders().map(withCustomModels),defaultLedgerPath(environment),environment);return;}
  const ledgerPath=defaultLedgerPath(environment),store=Store.open(ledgerPath),families=new Map(builtinProviders().map((raw)=>{const provider=withAnthropicFiles(withCustomModels(raw));return[provider.id,provider] as const;}));
  // Pooled families answer only through their numbered aliases. Registering the
  // family id with pool-only auth keeps the model catalog intact while removing
  // the ambient API-key and per-person credential routes upstream provides.
  for(const family of families.values())if(family.auth.oauth&&POOLED_FAMILIES.has(family.id))pi.registerProvider(pooledOnlyProvider(family));
  const shared=new Map<string,SharedOAuthAuth>();
  const requestTokens=new Map<string,string>();
  pi.on("session_shutdown",()=>requestTokens.clear());
  for(const family of families.values()){
    const oauth=family.auth.oauth;if(!oauth)continue;
    shared.set(family.id,providerOAuth(family,environment.PI_ORCHESTRATOR_AUTH??defaultSharedAuthPath(ledgerPath)));
  }
  const assigned=environment.PI_ORCHESTRATOR_ASSIGNED==="1"&&environment.PI_ORCHESTRATOR_RUN_ID?store.run(environment.PI_ORCHESTRATOR_RUN_ID):undefined;
  for(const account of store.accounts()){
    const family=families.get(account.provider),auth=shared.get(account.provider);if(!family||!auth||(!allowsAccountUse(account,"interactive")&&assigned?.accountId!==account.id))continue;
    const pooled=sharedOAuthProvider(family,account.id,account.label,auth,token=>requestTokens.set(account.id,token));
    pi.registerProvider(family.id==="openai-codex"?withCodexTierGuard(pooled,store,auth,account.id):pooled);
  }
  installImageGeneration(pi, store, shared.get("openai-codex"));
  installProviderOperations(pi, store, shared, environment);
  // The bundled CLI and extension providers have separate pi-ai resource registries.
  pi.on("session_shutdown",(_event,ctx)=>cleanupSessionResources(ctx.sessionManager.getSessionId()));
  const familyOf=(provider:string)=>store.account(provider)?.provider??baseProvider(provider);
  const resolve=(accountId:string,family:string,modelId:string):Model<never>|undefined=>{const model=families.get(family)?.getModels().find((candidate)=>candidate.id===modelId);return model?(accountId===family?model:{...model,provider:accountId}) as Model<never>:undefined;};
  const choose=async(family:string,model:string,exclude=new Set<string>(),includeCooling=false)=>{
    if(family==="openai-codex")exclude=await codexTierExclusions(store,shared.get(family),model,environment.PI_THREAD_SPEED,exclude,lifecycle.signal);
    if(closed)return;
    return chooseInteractiveAccount(store,shared.get(family),family,exclude,{includeCooling,model,live:environment.PI_THREAD_MODE==="live"});
  };
  const select=async(ctx:ExtensionContext,model:Model<never>,thinking:ThinkingLevel):Promise<boolean>=>{
    if(closed)return false;
    await ctx.modelRegistry.refresh({providers:[model.provider],allowNetwork:false,signal:lifecycle.signal});
    if(closed||!await pi.setModel(model)||closed)return false;
    pi.setThinkingLevel(thinking);
    return true;
  };
  // Admission may probe inferred holds. Failover excludes every account refused
  // in this round, even if it can probe an untried cooling sibling.
  const bind=async(ctx:ExtensionContext,exclude?:Set<string>,requested?:{family:string;modelId:string;thinking:ThinkingLevel},includeCooling=!exclude?.size):Promise<string|undefined>=>{
    const current=ctx.model,thinking=requested?.thinking??pi.getThinkingLevel();if(!current&&!requested)return;
    const family=requested?.family??familyOf(current!.provider),modelId=requested?.modelId??current!.id,choice=await choose(family,modelId,exclude,includeCooling);
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
    return !!account&&!!shared.get(pinned.provider)?.has(account.id)&&!!(assigned||allowsAccountUse(account,"interactive")&&!accountModelExcluded(store,account.id,pinned.model));
  };
  const enforcePin=async(ctx:ExtensionContext)=>{
    if(matchesPin(ctx))return;
    if(!pinned){void ctx.abort();throw new Error(`Unknown subagent model pin ${requestedPin}`);}
    const current=store.account(ctx.model?.provider??"");
    const accountId=environment.PI_ORCHESTRATOR_ACCOUNT_ID??assigned?.accountId??(current?.provider===pinned.provider&&allowsAccountUse(current,"interactive")&&shared.get(pinned.provider)?.has(current.id)&&!accountModelExcluded(store,current.id,pinned.model)?current.id:(await choose(pinned.provider,pinned.model,undefined,true))?.id);
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
  // Every consumer shares the ledger's cooldowns, so an answer on a pooled account
  // here is evidence for the fleet and brokers too, not just for this session.
  pi.on("message_end",event=>{
    if(closed)return;
    const message=event.message as any;
    if(providerAccepted(message)&&store.account(message.provider))
      store.recordProviderSuccess(message.provider,{model:message.model,startedAt:message.timestamp,source:environment.PI_ORCHESTRATOR_ASSIGNED==="1"?"assigned":"interactive"});
  });
  const fleetAssigned=environment.PI_ORCHESTRATOR_ASSIGNED==="1";
  let leaseId:string|undefined,leasedAccount:string|undefined,timer:ReturnType<typeof setInterval>|undefined;
  let running=false,turnActive=false,compacting=false;
  const releaseLease=()=>{
    if(timer)clearInterval(timer);
    if(leaseId)store.endLease(leaseId);
    timer=undefined;leaseId=undefined;leasedAccount=undefined;
  };
  const reconcileLease=(ctx:ExtensionContext)=>{
    if(closed||fleetAssigned)return;
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
  const requireSpeed=(ctx:ExtensionContext)=>{
    const error=requestedSpeedError(ctx.model,environment.PI_THREAD_SPEED??"standard");
    if(error)throw new Error(error);
  };
  /** Every usable account of the family refuses this model: report it, never wait on it as capacity. */
  const entitlementExhausted=(family:string,modelId:string)=>{
    const usable=store.accounts().filter(account=>account.provider===family&&allowsAccountUse(account,"interactive")&&shared.get(family)?.has(account.id));
    return usable.length>0&&usable.every(account=>accountModelExcluded(store,account.id,modelId));
  };
  const bindCurrent=async(ctx:ExtensionContext)=>{
    requireSpeed(ctx);
    if(!ctx.model||!POOLED_FAMILIES.has(familyOf(ctx.model.provider)))return;
    const explicit=ctx.model?.provider&&/-\d+$/.test(ctx.model.provider)?store.account(ctx.model.provider):undefined;
    const retain=explicit&&allowsAccountUse(explicit,"interactive")
      &&(!explicit.cooldownUntil||explicit.cooldownUntil<=Date.now())&&shared.get(explicit.provider)?.has(explicit.id)
      &&!accountModelExcluded(store,explicit.id,ctx.model.id)
      &&!interactiveQuotaExhausted(store,explicit.id,explicit.provider,ctx.model.id);
    const tierAllowed=retain&&environment.PI_THREAD_SPEED==="ultrafast"?(await requireCodexTier(store,shared.get(explicit.provider),explicit.id,ctx.model!.id,"ultrafast",lifecycle.signal)).ok:true;
    if(!retain||!tierAllowed){
      const bound=await bind(ctx);
      const family=familyOf(ctx.model.provider);
      if(!bound&&entitlementExhausted(family,ctx.model.id))throw new Error(noEntitledAccountError(family,ctx.model.id));
      if(!bound)throw new Error(`No eligible pooled account for ${ctx.model.provider}/${ctx.model.id}${environment.PI_THREAD_SPEED==="ultrafast"?" advertising ultrafast":""}`);
    }
  };
  pi.on("session_start",async(_event,ctx)=>{
    const branch=ctx.sessionManager.getBranch(),history=branch.some((entry)=>entry.type==="message"&&entry.message.role==="assistant");
    if(hasPin){await enforcePin(ctx);}
    else if(fleetAssigned)return;
    else if(environment[EXPLICIT_THREAD_MODEL_ENV]==="1")await bindCurrent(ctx);
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
        if(!(saved&&account&&allowsAccountUse(account,"interactive")&&!accountModelExcluded(store,account.id,selected.modelId)&&await select(ctx,saved,thinking))){
          if(!POOLED_FAMILIES.has(family))await bindCurrent(ctx);
          else if(!await bind(ctx,undefined,{family,modelId:selected.modelId,thinking}))throw new Error(`Saved model ${family}/${selected.modelId} has no eligible pooled account`);
        }
      }
    }
    else await bindCurrent(ctx);
    requireSpeed(ctx);
    reconcileLease(ctx);
  });
  pi.on("before_agent_start",async(_event,ctx)=>{
    requireSpeed(ctx);
    const current=store.account(ctx.model?.provider??"");
    const tierAllowed=current&&environment.PI_THREAD_SPEED==="ultrafast"?(await requireCodexTier(store,shared.get(current.provider),current.id,ctx.model!.id,"ultrafast",lifecycle.signal)).ok:true;
    if(current&&(!shared.get(current.provider)?.has(current.id)||!fleetAssigned&&(!allowsAccountUse(current,"interactive")||interactiveQuotaExhausted(store,current.id,current.provider,ctx.model!.id)||accountModelExcluded(store,current.id,ctx.model!.id))||!tierAllowed)){
      if(fleetAssigned)throw new Error(tierAllowed?`Account ${current.id} shared OAuth credential requires recovery before this assigned run can continue`:`Assigned account ${current.id} no longer advertises ${ctx.model!.id} ultrafast; refusing to downgrade`);
      const moved=await bind(ctx,new Set([current.id]),undefined,true);
      if(!moved){
        if(interactiveQuotaExhausted(store,current.id,current.provider,ctx.model!.id))return;
        if(entitlementExhausted(current.provider,ctx.model!.id))throw new Error(noEntitledAccountError(current.provider,ctx.model!.id));
        throw new Error(`Account ${current.id} is unavailable for interactive agents; no shared account is available`);
      }
      reconcileLease(ctx);
    }
  });
  let unresolved:{failure:string;account:string;prompt:(failure:string,account:string)=>string}|undefined;
  const refused=new Set<string>();
  let refusalModel:string|undefined;
  const round=(family:string,model:string)=>{
    const key=`${family}/${model}`;
    if(refusalModel!==key){refused.clear();refusalModel=key;}
    return refused;
  };
  pi.on("before_agent_start",()=>{refused.clear();refusalModel=undefined;});
  pi.on("message_end",event=>{
    const message=event.message as any;
    if(providerAccepted(message)){round(familyOf(message.provider),message.model).clear();unresolved=undefined;}
  });
  pi.on("before_provider_request",(_event,ctx)=>{
    if(ctx.model&&(round(familyOf(ctx.model.provider),ctx.model.id).has(ctx.model.provider)
      ||interactiveQuotaExhausted(store,ctx.model.provider,familyOf(ctx.model.provider),ctx.model.id)))
      throw new Error(POOLED_ACCOUNT_WAIT);
  });
  /**
   * Accounts repaired since their last successful request. A provider
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
  const repairCredential=async(account:string,failure:string,codexNotFound:boolean):Promise<CredentialRepair|undefined>=>{
    const auth=shared.get(familyOf(account));if(!auth||!store.account(account)||repaired.has(account))return;
    repaired.add(account);
    const signal=AbortSignal.any([lifecycle.signal,AbortSignal.timeout(30_000)]);
    return repairProviderCredential(auth,account,failure,codexNotFound,signal,requestTokens.get(account));
  };
  pi.on("agent_end",async(event,ctx)=>{
    if(closed)return;
    turnActive=false;
    unresolved=undefined;
    const last=event.messages.at(-1) as any;
    if(last?.role!=="assistant")return;
    if(last.stopReason!=="error"){
      if(last.stopReason!=="aborted")repaired.delete(last.provider);
      return;
    }
    const failure:string=last.errorMessage??"";
    const failing:string|undefined=last.provider;if(!failing)return;
    // A user-selected replacement must not be blamed or overwritten by the prior request.
    if(failing!==ctx.model?.provider)return;
    const codexNotFound=familyOf(failing)==="openai-codex"&&last.usage?.totalTokens===0
      &&isCodexNotFoundError(failure,ctx.model);
    if(isRejectedTokenError(failure)||codexNotFound){
      if(repaired.has(failing)){
        const auth=shared.get(familyOf(failing));
        if(auth)await quarantineProviderCredential(auth,failing,failure,codexNotFound,
          AbortSignal.any([lifecycle.signal,AbortSignal.timeout(30_000)]),requestTokens.get(failing));
      }
      const result=await repairCredential(failing,failure,codexNotFound);
      if(closed||ctx.model?.provider!==failing)return;
      if(result){
        pi.appendEntry("credential-repair",{account:failing,...result});
        if(result.outcome!=="repaired")ctx.ui.notify(result.detail,"warning");
        if(result.outcome==="repaired"){unresolved={failure:result.detail,account:failing,prompt:credentialRepairPrompt};return;}
      }
    }
    // An account that refuses the model itself is excluded for that model and the session moves to an entitled
    // sibling on the same model. It is never a capacity wait, a cooldown, or a reason to switch models.
    const refusedModel=last.model??ctx.model.id;
    if(accountModelUnsupported(failure)&&recordAccountModelUnsupported(store,failing,refusedModel,failure)){
      if(fleetAssigned)return;
      const moved=await bind(ctx,new Set([failing]),undefined,true);
      if(moved&&!closed){unresolved={failure,account:moved,prompt:failoverPrompt};return;}
      if(closed)return;
      const family=familyOf(failing);
      pi.appendEntry("model-unsupported",{model:`${family}/${refusedModel}`,account:failing,failure});
      ctx.ui.notify(noEntitledAccountError(family,refusedModel),"error");
      return;
    }
    const credentialUnavailable=!!shared.get(familyOf(failing))?.rejection(failing);
    if(!credentialUnavailable&&!isRateLimitError(failure))return;
    const excluded=round(familyOf(failing),last.model??ctx.model.id);
    excluded.add(failing);
    if(!credentialUnavailable&&store.account(failing))store.transaction(()=>store.setCooldown(failing,
      Math.max(store.account(failing)?.cooldownUntil??0,Date.now()+rateLimitCooldownMs(failure)),{model:last.model}));
    if(fleetAssigned)return;
    const moved=await bind(ctx,excluded,undefined,true);
    if(!moved)pi.appendEntry("pooled-account-wait",{model:refusalModel,accounts:[...excluded],failure});
    if(moved&&!closed)unresolved={failure,account:moved,prompt:failoverPrompt};
  });
  pi.on("agent_before_settle",()=>{
    if(closed)return;
    const notice=unresolved;unresolved=undefined;
    if(notice)return {entries:[{type:"custom_message",customType:"account-recovery",
      content:notice.prompt(notice.failure,notice.account),display:true}],continue:true};
  });
  pi.on("agent_settled",(_event,ctx)=>{
    if(closed)return;
    running=false;turnActive=false;reconcileLease(ctx);
  });
  pi.on("session_shutdown",()=>{if(closed)return;closed=true;lifecycle.abort();unresolved=undefined;releaseLease();store.close();});
}
