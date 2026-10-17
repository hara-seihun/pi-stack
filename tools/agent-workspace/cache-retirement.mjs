import fs from 'node:fs';
import path from 'node:path';
import {retireGeneratedOnly} from './generated-retirement.mjs';
import {digest} from './growth-lifecycle.mjs';

export class CacheRetirementError extends Error {constructor(code,detail){super(detail);this.code=code;}}
const refuse=(code,detail)=>{throw new CacheRetirementError(code,detail);};
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify(keys.sort());
const bindingKeys=['id','path','owner','sourceCommit','durableSourceCommit','head','device','inode','updatedAt','leaseExpiresAt'];
export function validateCacheRequest(request){
 if(!exact(request,['kind','operationId','binding','cachePath','classification','ownerEvidence'])||request.kind!=='retire-workspace-cache'||!/^[a-zA-Z0-9_-]{8,80}$/.test(request.operationId)||!exact(request.binding,bindingKeys)||typeof request.ownerEvidence!=='string'||!request.ownerEvidence.trim())refuse('invalid-cache-request','exact bound cache request and owner evidence required');
 if(!['node-dependencies','declared-build-cache'].includes(request.classification))refuse('unclassified-cache','unknown cache class');
 const p=request.cachePath;
 if(typeof p!=='string'||!p||path.isAbsolute(p)||path.posix.normalize(p)!==p||p.includes('\\')||/[?*\[\x00]/.test(p)||p.split('/').some(x=>['.','..','.git','.converge','evidence','receipts','results','logs'].includes(x)))refuse('unclassified-cache','exact unaliased relative generated path required; evidence paths are protected');
 if(!bindingKeys.filter(x=>!['updatedAt','leaseExpiresAt'].includes(x)).every(x=>typeof request.binding[x]==='string'&&request.binding[x])||!Number.isSafeInteger(request.binding.updatedAt)||!Number.isSafeInteger(request.binding.leaseExpiresAt))refuse('invalid-cache-request','complete identity and lifecycle binding required');
 return request;
}
export function retireWorkspaceCache(context,request){
 try{
  validateCacheRequest(request);
  const current=()=>{
   const binding=context.binding();
   if(bindingKeys.some(k=>binding[k]!==request.binding[k]))refuse('cache-identity-changed','workspace/source/head/lifecycle binding changed');
   if(binding.leaseExpiresAt>Date.now())refuse('cache-writing-lease','writing lease remains active');
   context.classify(request);
  };
  current();
  const operation='cache-'+request.operationId;
  const inner={kind:'retire-generated-only',operationId:operation,ownerEvidence:request.ownerEvidence,binding:Object.fromEntries(['id','path','owner','sourceCommit','durableSourceCommit','head','device','inode'].map(k=>[k,request.binding[k]])),paths:[request.cachePath]};
  const db=context.database,sha=digest(JSON.stringify(request));
  db.exec('CREATE TABLE IF NOT EXISTS workspace_cache_retirement(operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, original_json TEXT NOT NULL)');
  const prior=db.prepare('SELECT request_sha256 FROM workspace_cache_retirement WHERE operation_id=?').get(operation);
  if(prior&&prior.request_sha256!==sha)refuse('cache-operation-conflict','operation identity already has different request bytes');
  if(!prior)db.prepare('INSERT INTO workspace_cache_retirement VALUES(?,?,?,?)').run(operation,request.binding.id,sha,JSON.stringify(context.original()));
  const result=retireGeneratedOnly({...context,journalKind:'workspace-cache-retirement',inventoryPolicy:'unlink-cache-links',binding:()=>{current();return inner.binding;},custody:current,declarations:()=>[request.cachePath],safety:stages=>{
   const safety=context.safety(stages);
   if(!Number.isSafeInteger(safety?.observedAt)||Date.now()-safety.observedAt>60000||safety.observedAt>Date.now())refuse('cache-safety-unknown','fresh complete native and queued-work observation required');
   return safety;
  }},inner);
  if(!result.ok)return result;
  return {ok:true,value:{...result.value,kind:'workspace-cache-retired',sourcePreserved:true,lifecycleAndPlanPreserved:true}};
 }catch(error){return {ok:false,error:{code:error instanceof CacheRetirementError?error.code:'cache-retirement-io-error',detail:String(error.message)}};}
}
