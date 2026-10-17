import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const literal=value=>"'"+value.replaceAll("'","''")+"'";
export function operatorJobFromCgroup(text){return text.match(/pi-stack-next-job-([a-f0-9-]{36})-\d+\.service(?:\/|$)/m)?.[1]??null;}
export function queueReferenceSql(root,selfJobId,resourceKind){
 if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
 const roots=Array.isArray(root)?root:[root];
 if(selfJobId!==null&&!/^[a-f0-9-]{36}$/.test(selfJobId))throw new Error('invalid physical operator identity');
 const self=selfJobId===null?'NULL':literal(selfJobId),needles='ARRAY['+roots.map(literal).join(',')+']';
 const physical=resourceKind!=='source';
 const sourceOperations="'conversation.send','conversation.create','agent.continue','conversation.rename','conversation.cancel','conversation.close','delegation.track','delegation.update','delegation.review','delegation.close','delegation.setDoneCondition','delegation.sweep','input.deliveryFailure','manager.check','manager.response.remind','provider.resume'";
 const sourceOperationPredicate=`command_type IN (${sourceOperations})`;
 const filter=physical?"resource_class!='source-intent'":'TRUE';
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 WITH operator AS MATERIALIZED (SELECT j.id,j.operation_id,o.origin->>'jobId' AS run_id FROM job j JOIN operation o ON o.id=j.operation_id WHERE j.id=${self}), pending AS MATERIALIZED (
 SELECT 'job' AS kind,id,state,CASE WHEN spec->>'kind'='agent-run' THEN 'source-intent' ELSE 'execution' END AS resource_class,NULL::text AS tool_name,NULL::text AS target_path FROM job WHERE (state IN ('queued','starting','running','waiting','cancelling','unreachable') OR (ownership_receipt IS NOT NULL AND cessation_evidence IS NULL)) AND id IS DISTINCT FROM ${self} ${physical?"AND spec->>'kind' IS DISTINCT FROM 'agent-run'":''}
 UNION ALL SELECT 'input',id,state,'source-intent',NULL::text,NULL::text FROM input WHERE ${physical?'FALSE':'TRUE'} AND state IN ('queued','landed') AND NOT (state='landed' AND run_id IN (SELECT run_id FROM operator WHERE run_id IS NOT NULL))
 UNION ALL SELECT 'tool_call',tc.id,CASE WHEN tc.result IS NULL THEN 'reserved' ELSE 'completed-history' END,CASE WHEN tc.result IS NULL THEN 'reserved-tool-call' ELSE 'source-intent' END,tc.tool_name,tc.arguments->>'path' FROM tool_call tc JOIN job j ON j.id=tc.run_id WHERE (${physical?'tc.result IS NULL':'TRUE'}) AND (tc.result IS NULL OR j.state IN ('queued','starting','running','waiting','cancelling','unreachable')) AND (tc.operation_id IS NULL OR tc.operation_id IS DISTINCT FROM (SELECT operation_id FROM operator LIMIT 1)) AND NOT (tc.result IS NOT NULL AND tc.run_id IN (SELECT run_id FROM operator WHERE run_id IS NOT NULL))
 UNION ALL SELECT 'operation',id,state,CASE WHEN command_type='agent.tool' THEN 'execution' WHEN ${sourceOperationPredicate} THEN 'source-intent' ELSE 'unclassified-operation' END,request_body->>'name',request_body->'arguments'->>'path' FROM operation WHERE ${physical?'NOT ('+sourceOperationPredicate+')':'TRUE'} AND state IN ('accepted','running','cancelling','uncertain') AND id IS DISTINCT FROM (SELECT operation_id FROM operator LIMIT 1)
 ) SELECT coalesce(json_agg(r),'[]'::json) FROM (
 SELECT p.kind,p.id,p.state,p.resource_class AS "resourceClass",p.tool_name AS "toolName",p.target_path AS "targetPath" FROM pending p
 CROSS JOIN LATERAL (
 SELECT spec AS body FROM job WHERE p.kind='job' AND id=p.id
 UNION ALL SELECT jsonb_build_object('content',content,'attachments',attachments,'source',source) FROM input WHERE p.kind='input' AND id=p.id
 UNION ALL SELECT arguments FROM tool_call WHERE p.kind='tool_call' AND id=p.id
 UNION ALL SELECT request_body FROM operation WHERE p.kind='operation' AND id=p.id OFFSET 0
 ) b
 CROSS JOIN LATERAL (SELECT b.body WHERE EXISTS (SELECT 1 FROM unnest(${needles}) n(needle) WHERE position(substring(to_jsonb(needle)::text FROM 2 FOR length(to_jsonb(needle)::text)-2) IN b.body::text)>0) OFFSET 0) matching
 WHERE ${filter} AND EXISTS (SELECT 1 FROM jsonb_path_query(matching.body,'strict $.** ? (@.type() == "string")') s(value),unnest(${needles}) n(needle) WHERE position(needle IN (s.value #>> '{}'))>0) LIMIT 65
 ) r; ROLLBACK;`;
}
export function currentStackQueueReferences(roots,{resourceKind,cacheRoots,read=p=>JSON.parse(fs.readFileSync(p,'utf8')),execute=(name,args,options)=>spawnSync(name,args,options)}={}){
 try{
  if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
  if(resourceKind==='generated-cache'&&(!Array.isArray(cacheRoots)||!cacheRoots.length||cacheRoots.some(p=>!path.isAbsolute(p))))throw new Error('exact generated cache resource roots required');
  if(!Array.isArray(roots)||!roots.length||roots.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('exact absolute reference roots required');
  const host=read('/etc/pi-stack-next/host.json'),registry=read('/var/lib/pi-stack-next/registry/registry.json');
  if(!host.hostId||host.installationId!==registry.installationId||!Array.isArray(registry.domains))throw new Error('canonical host/registry identity mismatch');
  const domains=registry.domains.filter(d=>d.hostId===host.hostId);
  if(!domains.length||domains.length>32)throw new Error('bounded canonical domain inventory missing');
  const selfJobId=operatorJobFromCgroup(fs.readFileSync('/proc/self/cgroup','utf8'));
  const references=[],observations=[];
  for(const domain of domains){
   const config=read('/etc/pi-stack-next/domains/'+domain.id+'.json');
   if(!/^[a-z][a-z0-9-]{0,23}$/.test(domain.id)||domain.unixUser!=='pi2-'+domain.id||config.domainId!==domain.id||!/^[a-z][a-z0-9_]{0,62}$/.test(config.database))throw new Error('canonical queue configuration invalid');
   const result=execute('sudo',['-n','-u',domain.unixUser,'psql','-X','-qAt','--no-password','--host','/run/pi-stack-next/'+domain.id+'/pg','--username',domain.unixUser,'--dbname',config.database,'--set=ON_ERROR_STOP=1','--command',queueReferenceSql(roots,selfJobId,resourceKind)],{encoding:'utf8',timeout:6000,maxBuffer:262144,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
   if(result.status!==0||result.error)throw new Error('canonical queue unavailable: '+domain.id+': '+String(result.error?.code??result.stderr??result.status).slice(0,1500));
   const rows=JSON.parse(result.stdout);if(!Array.isArray(rows)||rows.length>=65||rows.some(r=>!r||typeof r.id!=='string'||!['job','input','operation','tool_call'].includes(r.kind)||typeof r.state!=='string'))throw new Error('canonical queue observation incomplete: '+domain.id);
   references.push(...rows.filter(r=>resourceKind!=='generated-cache'||!isSourceOnlyRead(r,cacheRoots)).map(r=>({...r,domainId:domain.id,roots}))); observations.push({domainId:domain.id,roots,count:rows.length});
  }
  return {errors:[],references,observations,resourceKind,observedAt:Date.now()};
 }catch(error){return {errors:[String(error.message)],references:[],observations:[],observedAt:Date.now()};}
}

export function isSourceOnlyRead(reference,cacheRoots) {
 if(reference.toolName!=='read'||typeof reference.targetPath!=='string'||!path.isAbsolute(reference.targetPath))return false;
 try{const target=reference.targetPath;if(fs.realpathSync(target)!==target||!fs.statSync(target).isFile())return false;return cacheRoots.every(root=>target!==root&&!target.startsWith(root+path.sep)&&!root.startsWith(target+path.sep));}catch{return false;}
}
