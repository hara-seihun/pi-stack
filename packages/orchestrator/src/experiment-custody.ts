import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';

type Result<T> = {ok:true; value:T} | {ok:false; error:{code:string; message:string}};
const fail = (code:string): Result<never> => ({ok:false,error:{code,message:code}});
const id = (v:unknown):v is string => typeof v==='string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
const digest = (v:unknown):v is string => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
export interface ExperimentPolicy { principal:string; experimentId:string; approvalId:string; maxForwards:144; maxRequestBytes:32768; stopAfterUsd:14 }
export interface ExperimentBinding { approvalId:string; sourceSha256:string; publicSha256:string; maxForwards:144; maxRequestBytes:32768; stopAfterUsd:14; costBasis:'observed-usage-catalog-list-usd' }
export interface ExperimentResponse {status:number; headers:Record<string,string>; bodyBase64:string}
export interface ExperimentAttempt { logicalId:string; requestSha256:string; physicalId:string; at:number; phase:'reserved'|'forwarded'|'settled'; charge:{kind:'unknown'}|{kind:'observed'; usd:number; usage:unknown}; response:{kind:'unset'}|{kind:'saved'; value:ExperimentResponse} }
export interface ExperimentRecord { version:1; experimentId:string; binding:ExperimentBinding; state:'active'|'stopped'; attempts:ExperimentAttempt[] }
export function validExperimentPolicy(v:unknown):v is ExperimentPolicy {
  if (!v || typeof v!=='object') return false;
  const p=v as ExperimentPolicy;
  return typeof p.principal==='string' && /^[a-z_][a-z0-9_-]*$/.test(p.principal) && id(p.experimentId) && id(p.approvalId) && p.maxForwards===144 && p.maxRequestBytes===32768 && p.stopAfterUsd===14;
}
export class ExperimentCustody {
  private store:Pick<Store,'transaction'|'control'|'setControl'>;
  readonly policy:ExperimentPolicy;
  constructor(store:Pick<Store,'transaction'|'control'|'setControl'>,policy:ExperimentPolicy){this.store=store;this.policy=policy;}
  private key(){return `experiment-v1:${this.policy.principal}:${this.policy.experimentId}`;}
  get():ExperimentRecord|undefined {const value=this.store.control(this.key());return value?JSON.parse(value) as ExperimentRecord:undefined;}
  private save(value:ExperimentRecord){this.store.setControl(this.key(),JSON.stringify(value));}
  register(input:unknown):Result<ExperimentRecord> {
    if (!input || typeof input!=='object')return fail('experiment_binding_invalid');
    const b=input as ExperimentBinding,p=this.policy;
    if(b.approvalId!==p.approvalId || !digest(b.sourceSha256) || !digest(b.publicSha256) || b.maxForwards!==p.maxForwards || b.maxRequestBytes!==p.maxRequestBytes || b.stopAfterUsd!==p.stopAfterUsd || b.costBasis!=='observed-usage-catalog-list-usd')return fail('experiment_binding_invalid');
    const binding:ExperimentBinding={approvalId:b.approvalId,sourceSha256:b.sourceSha256,publicSha256:b.publicSha256,maxForwards:144,maxRequestBytes:32768,stopAfterUsd:14,costBasis:b.costBasis};
    return this.store.transaction(()=>{const old=this.get();if(old)return JSON.stringify(old.binding)===JSON.stringify(binding)?{ok:true,value:old}:fail('experiment_binding_conflict');const record:ExperimentRecord={version:1,experimentId:p.experimentId,binding,state:'active',attempts:[]};this.save(record);return {ok:true,value:record};});
  }
  reserve(logicalId:string,bytes:Buffer):Result<{kind:'new';attempt:ExperimentAttempt}|{kind:'saved';attempt:ExperimentAttempt;response:ExperimentResponse}> {
    if(!id(logicalId))return fail('experiment_logical_id_invalid');
    if(bytes.byteLength>this.policy.maxRequestBytes)return fail('experiment_request_bytes_exceeded');
    const requestSha256=createHash('sha256').update(bytes).digest('hex');
    return this.store.transaction(()=>{
      const r=this.get();if(!r)return fail('experiment_not_registered');
      const old=r.attempts.find(a=>a.logicalId===logicalId);
      if(old){if(old.requestSha256!==requestSha256)return fail('experiment_request_conflict');if(old.response.kind==='saved')return {ok:true,value:{kind:'saved',attempt:old,response:old.response.value}};return fail('experiment_original_outcome_unknown_no_replay');}
      if(r.state==='stopped')return fail('experiment_stopped');
      if(r.attempts.some(a=>a.charge.kind==='unknown'))return fail('experiment_unknown_exposure');
      if(r.attempts.length>=this.policy.maxForwards)return fail('experiment_forward_cap');
      const spent=r.attempts.reduce((n,a)=>n+(a.charge.kind==='observed'?a.charge.usd:0),0);
      if(spent>=this.policy.stopAfterUsd)return fail('experiment_postcharge_stop');
      const attempt:ExperimentAttempt={logicalId,requestSha256,physicalId:randomUUID(),at:Date.now(),phase:'reserved',charge:{kind:'unknown'},response:{kind:'unset'}};
      r.attempts.push(attempt);this.save(r);return {ok:true,value:{kind:'new',attempt}};
    });
  }
  forwarded(physicalId:string):Result<void>{return this.change(physicalId,a=>{if(a.phase!=='reserved')return fail('experiment_attempt_already_forwarded');a.phase='forwarded';return {ok:true,value:undefined};});}
  settle(physicalId:string,response:ExperimentResponse,charge:ExperimentAttempt['charge']):Result<void>{return this.change(physicalId,a=>{if(a.phase==='settled')return fail('experiment_already_settled');a.phase='settled';a.response={kind:'saved',value:response};a.charge=charge;return {ok:true,value:undefined};});}
  private change(physicalId:string,update:(a:ExperimentAttempt)=>Result<void>):Result<void>{return this.store.transaction(()=>{const r=this.get();if(!r)return fail('experiment_not_registered');const a=r.attempts.find(a=>a.physicalId===physicalId);if(!a)return fail('experiment_attempt_unset');const result=update(a);if(result.ok)this.save(r);return result;});}
  stop():Result<ExperimentRecord>{return this.store.transaction(()=>{const r=this.get();if(!r)return fail('experiment_not_registered');r.state='stopped';this.save(r);return {ok:true,value:r};});}
  summary(){const r=this.get();if(!r)return undefined;return {...r,forwardsReserved:r.attempts.length,knownTransportInvocations:r.attempts.filter(a=>a.phase!=='reserved').length,unknownExposure:r.attempts.filter(a=>a.charge.kind==='unknown').map(a=>a.physicalId),observedUsd:r.attempts.reduce((n,a)=>n+(a.charge.kind==='observed'?a.charge.usd:0),0)};}
}
