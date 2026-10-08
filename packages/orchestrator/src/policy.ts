import { completionFeedbackRefusal } from "./completion-feedback.js";
import { admissionThinking, modelDrainsMeter, type ModelCandidate } from "./catalog.js";
import { reservationMatchesRun } from "./admission-reservation.js";
import { allowsAccountUse, type BudgetClass, type OrchestratorConfig } from "./domain.js";
import type { Store } from "./store.js";
import { sharedCredentialRejection } from "./auth/shared-oauth.js";
import { modelUnsupportedEvidence, modelUnsupportedReason } from "./auth/model-entitlement.js";

function credentialRefusal(cfg: OrchestratorConfig, alias: string): string | undefined {
  const state = sharedCredentialRejection(cfg.authPath, alias);
  return state?.state === "login-required" ? "shared OAuth credential requires login" : state ? "shared OAuth credential awaiting refresh" : undefined;
}

export type Assignment = ModelCandidate & { readonly accountId:string; };
export interface Refusal { readonly accountId:string; readonly reason:string; }
export interface Capacity { readonly state:"available"|"unavailable"; readonly spent:number; readonly reason:string; }

/** Provider availability; the global execution authority owns agent capacity. */
export function accountCapacity(store:Store,accountId:string,_budget:BudgetClass,cfg:OrchestratorConfig,now=Date.now(),runId?:string,model?:string):Capacity{
  const account=store.account(accountId)!;
  const meters=store.latestMeters(accountId).filter(meter=>!model||modelDrainsMeter(account.provider,model,meter.meter_id));
  const spent=Math.max(0,...meters.map((m)=>Number(m.used_percent)));
  const stop=(reason:string):Capacity=>({state:"unavailable",spent,reason});
  if(!allowsAccountUse(account,"fleet"))return stop(account.enabled?"reserved for voice":"disabled");
  const credential = credentialRefusal(cfg, accountId);
  if(credential)return stop(credential);
  if(account.reservation&&!reservationMatchesRun(store,account.reservation,runId))return stop(`reserved capacity: ${account.reservation.reason}`);
  if(account.cooldownUntil&&account.cooldownUntil>now)return stop("account cooling down");
  if(meters.some((m)=>m.used_percent>=100))return stop("provider quota exhausted");
  return{state:"available",spent,reason:"provider capacity available"};
}

export function assign(store:Store,profile:string,budget:BudgetClass,cfg:OrchestratorConfig,now=Date.now(),pinnedAccount?:string,runId?:string,execution:"user"|"root-repair"="user",excludedAccounts:ReadonlySet<string>=new Set()):{assignment?:Assignment;refusals:Refusal[]}{
  if(store.control("launches")==="paused")return{refusals:[{accountId:"*",reason:"emergency halt"}]};
  const repair=execution==="root-repair";
  if(!repair&&store.control("ordinary-launches")==="paused")return{refusals:[{accountId:"*",reason:"ordinary work paused"}]};
  if(repair&&store.control("repair-owner")&&store.control("repair-owner")!==runId)return{refusals:[{accountId:"*",reason:"repair already owned"}]};
  const candidates=cfg.profiles[profile];if(!candidates?.length)throw new Error(`unknown model profile ${profile}`);
  const refusals:Refusal[]=[];const choices:(Assignment&{spent:number})[]=[];
  for(const candidate of candidates){
    for(const account of store.accounts().filter((a)=>a.provider===candidate.provider&&(pinnedAccount===undefined||a.id===pinnedAccount))){
      if(excludedAccounts.has(account.id)){refusals.push({accountId:account.id,reason:"requested service tier unavailable"});continue;}
      const unsupported=modelUnsupportedEvidence(store,account.id,candidate.model,now);
      if(unsupported){refusals.push({accountId:account.id,reason:modelUnsupportedReason(unsupported)});continue;}
      const capacity=accountCapacity(store,account.id,budget,cfg,now,runId,candidate.model);
      if(capacity.state==="unavailable"){refusals.push({accountId:account.id,reason:capacity.reason});continue;}
      choices.push({accountId:account.id,...candidate,spent:capacity.spent});
    }
    if(choices.length)break;
  }
  const load=(accountId:string)=>store.activeSessionLeases(accountId,120_000,now).length;
  choices.sort((a,b)=>load(a.accountId)-load(b.accountId)||a.spent-b.spent||a.accountId.localeCompare(b.accountId));
  const candidate=choices[0];
  const affinityKey=profile==="thread"&&runId&&candidate
    ? `thread-account-affinity:${JSON.stringify([runId,candidate.provider,candidate.model])}` : undefined;
  const retained=affinityKey?store.control(affinityKey):undefined;
  // Account-bound thinking and prompt caches survive an idle thread, not a move to a less busy sibling.
  // Only already-admissible choices can retain affinity; explicit pins and all capacity checks still win.
  const assignment=choices.find(choice=>choice.accountId===retained)??candidate;
  if(affinityKey&&assignment)store.setControl(affinityKey,assignment.accountId);
  return{assignment,refusals};
}

export function assignCompletion(store:Store,runId:string,profile:string,cfg:OrchestratorConfig,now=Date.now()):{assignment?:Assignment;refusals:Refusal[]}{
  if(store.control("launches")==="paused")return{refusals:[{accountId:"*",reason:"emergency halt"}]};
  if(store.control("ordinary-launches")==="paused")return{refusals:[{accountId:"*",reason:"ordinary work paused"}]};
  const requestId=store.control(`completion-run:${runId}`);
  const saved=requestId?store.control(`completion:${requestId}`):undefined;
  const completion=saved?JSON.parse(saved):undefined;
  const retryAt=completion?.record.retryAt;
  // The stored account list is provenance: it records what the principal held when the request
  // arrived. Admission asks the ledger what that principal holds now, so grants that move while a
  // request waits admit or refuse it on today's terms.
  const principal=(completion?.access as {principal?:string}|undefined)?.principal;
  const grant=principal===undefined?undefined:store.brokerGrant(principal);
  if(retryAt>now)return{refusals:[{accountId:"*",reason:`provider retry scheduled at ${retryAt}`} ]};
  const run=store.run(runId);
  const candidates=run?.provider&&run.model?[{provider:run.provider,model:run.model,thinking:run.thinking}]
    :cfg.profiles[profile]?.map(candidate=>({...candidate,thinking:completion?.input.thinkingLevel??admissionThinking(candidate)}));
  if(!candidates?.length)throw new Error(`unknown completion profile ${profile}`);
  const refusals:Refusal[]=[],choices:(Assignment&{spent:number;reserved:boolean})[]=[];
  for(const candidate of candidates){
    for(const account of store.accounts().filter(account=>account.provider===candidate.provider)){
      const meters=store.latestMeters(account.id),credential=credentialRefusal(cfg,account.id),unsupported=modelUnsupportedEvidence(store,account.id,candidate.model,now);
      const reason=principal!==undefined&&!grant?`no live model broker grant for ${principal}`
        :grant&&(!grant.accounts.includes(account.id)||!grant.models.includes(`${candidate.provider}/${candidate.model}`))?"account or model not shared with completion owner"
        :!allowsAccountUse(account,"fleet")?"account unavailable"
        :credential?credential
        :unsupported?modelUnsupportedReason(unsupported)
        :account.reservation&&!reservationMatchesRun(store,account.reservation,runId)?"reserved for another completion queue"
        :account.cooldownUntil&&account.cooldownUntil>now?"account cooling down"
        :!meters.length||meters.some(meter=>now-meter.observed_at>cfg.meterMaxAgeMs||meter.observed_at>now+60_000)?"missing or stale provider quota"
        :meters.some(meter=>meter.used_percent>=100)?"provider quota exhausted":completionFeedbackRefusal(store,account.id,now);
      if(reason){refusals.push({accountId:account.id,reason});continue;}
      choices.push({...candidate,accountId:account.id,spent:Math.max(...meters.map(meter=>meter.used_percent)),reserved:!!account.reservation});
    }
    if(choices.length)break;
  }
  choices.sort((a,b)=>Number(b.reserved)-Number(a.reserved)||a.spent-b.spent||a.accountId.localeCompare(b.accountId));
  return{assignment:choices[0],refusals};
}
