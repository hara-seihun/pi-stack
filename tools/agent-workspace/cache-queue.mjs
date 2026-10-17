import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {boundedCommand} from './bounded-command.mjs';

const literal=value=>"'"+value.replaceAll("'","''")+"'";
export function operatorJobFromCgroup(text){return text.match(/pi-stack-next-job-([a-f0-9-]{36})-\d+\.service(?:\/|$)/m)?.[1]??null;}
export function queueReferenceSql(root,selfJobId,resourceKind){
 if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
 const roots=Array.isArray(root)?root:[root];
 if(selfJobId!==null&&!/^[a-f0-9-]{36}$/.test(selfJobId))throw new Error('invalid physical operator identity');
 const self=selfJobId===null?'NULL':literal(selfJobId);
 const pathPredicate=roots.map(root=>`jsonb_path_exists(b.body,${literal('strict $.** ? (@.type() == "string" && @ like_regex '+JSON.stringify(root)+' flag "q")')}::jsonpath)`).join(' OR ');
 const serializedMatch=body=>roots.map(root=>`strpos((${body})::text,${literal(JSON.stringify(root).slice(1,-1))})>0`).join(' OR ');
 const physical=resourceKind!=='source';
 const sourceOperations="'conversation.send','conversation.create','agent.continue','conversation.rename','conversation.cancel','conversation.close','delegation.track','delegation.update','delegation.review','delegation.close','delegation.setDoneCondition','delegation.sweep','input.deliveryFailure','manager.check','manager.response.remind','provider.resume'";
 const sourceOperationPredicate=`command_type IN (${sourceOperations})`;
 const filter=physical?"resource_class!='source-intent'":'TRUE';
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 WITH operator AS MATERIALIZED (SELECT j.id,j.operation_id,o.origin->>'jobId' AS run_id FROM job j JOIN operation o ON o.id=j.operation_id WHERE j.id=${self}), eligible_jobs AS MATERIALIZED (SELECT id,state,kind FROM job WHERE (state IN ('queued','starting','running','waiting','cancelling','unreachable') OR (ownership_receipt IS NOT NULL AND cessation_evidence IS NULL)) ${physical?"AND kind IS DISTINCT FROM 'agent-run'":''}), eligible_tool_ids AS MATERIALIZED (SELECT id FROM tool_call WHERE result IS NULL ${physical?'':"UNION ALL SELECT tc.id FROM job j JOIN tool_call tc ON tc.run_id=j.id WHERE j.state IN ('queued','starting','running','waiting','cancelling','unreachable') AND tc.result IS NOT NULL"}), pending AS MATERIALIZED (
 SELECT 'job' AS kind,e.id,e.state,CASE WHEN e.kind='agent-run' THEN 'source-intent' ELSE 'execution' END AS resource_class,NULL::text AS tool_name,NULL::text AS target_path FROM eligible_jobs e WHERE e.id IS DISTINCT FROM ${self}
 UNION ALL SELECT 'input',id,state,'source-intent',NULL::text,NULL::text FROM input WHERE ${physical?'FALSE':'TRUE'} AND state IN ('queued','landed') AND NOT (state='landed' AND run_id IN (SELECT run_id FROM operator WHERE run_id IS NOT NULL))
 UNION ALL SELECT 'tool_call',tc.id,CASE WHEN tc.result IS NULL THEN 'reserved' ELSE 'completed-history' END,CASE WHEN tc.result IS NULL THEN 'reserved-tool-call' ELSE 'source-intent' END,tc.tool_name,NULL::text FROM eligible_tool_ids e CROSS JOIN LATERAL (SELECT * FROM tool_call WHERE id=e.id OFFSET 0) tc JOIN job j ON j.id=tc.run_id WHERE (${physical?'tc.result IS NULL':'TRUE'}) AND (tc.result IS NULL OR j.state IN ('queued','starting','running','waiting','cancelling','unreachable')) AND (tc.operation_id IS NULL OR tc.operation_id IS DISTINCT FROM (SELECT operation_id FROM operator LIMIT 1)) AND NOT (tc.result IS NOT NULL AND tc.run_id IN (SELECT run_id FROM operator WHERE run_id IS NOT NULL))
 UNION ALL SELECT 'operation',id,state,CASE WHEN command_type='agent.tool' THEN 'execution' WHEN ${sourceOperationPredicate} THEN 'source-intent' ELSE 'unclassified-operation' END,NULL::text,NULL::text FROM operation WHERE ${physical?'NOT ('+sourceOperationPredicate+')':'TRUE'} AND state IN ('accepted','running','cancelling','uncertain') AND id IS DISTINCT FROM (SELECT operation_id FROM operator LIMIT 1)
 ), matching AS MATERIALIZED (
 SELECT p.*,b.body FROM pending p
 CROSS JOIN LATERAL (
 SELECT spec AS body FROM job WHERE p.kind='job' AND id=p.id
 UNION ALL SELECT jsonb_build_object('content',content,'attachments',attachments,'source',source) FROM input WHERE p.kind='input' AND id=p.id
 UNION ALL SELECT arguments FROM tool_call WHERE p.kind='tool_call' AND id=p.id
 UNION ALL SELECT request_body FROM operation WHERE p.kind='operation' AND id=p.id OFFSET 0
 ) b WHERE ${filter} AND (${serializedMatch('b.body')})
 ) SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT b.kind,b.id,b.state,b.resource_class AS "resourceClass",CASE WHEN b.kind='operation' THEN b.body->>'name' ELSE b.tool_name END AS "toolName",CASE WHEN b.kind='operation' THEN b.body->'arguments'->>'path' WHEN b.kind='tool_call' THEN b.body->>'path' ELSE b.target_path END AS "targetPath" FROM matching b WHERE (${pathPredicate}) LIMIT 65) r; ROLLBACK;`;
}
export function toolSettlementSql(ids) {
 if(!Array.isArray(ids)||!ids.length||ids.length>64||ids.some(id=>typeof id!=='string'||id.length>200))throw new Error('bounded exact operation IDs required');
 const selected=ids.map(literal).join(',');
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 WITH candidates AS MATERIALIZED (
 SELECT o.id,o.state,o.command_type,o.result AS operation_result,o.request_body,tc.run_id,tc.provider_call_id,tc.result AS tool_result,
 j.state AS owner_state,j.ownership_receipt,j.cessation_evidence
 FROM operation o JOIN tool_call tc ON tc.operation_id=o.id JOIN job j ON j.id=tc.run_id WHERE o.id IN (${selected})),
 relation_keys AS MATERIALIZED (SELECT jsonb_build_object('runs',coalesce(jsonb_agg(run_id),'[]'::jsonb),'calls',coalesce(jsonb_agg(provider_call_id),'[]'::jsonb)) AS vars FROM candidates),
 matching_child_ids AS MATERIALIZED (SELECT id FROM job WHERE operation_id IN (${selected})
 OR jsonb_path_exists(spec,'$ ? (@.admitted.parentJobId == $runs[*] || @.parentJobId == $runs[*] || @.admitted.toolCallId == $calls[*])',(SELECT vars FROM relation_keys)) LIMIT 65),
 children AS MATERIALIZED (SELECT j.id,j.state,j.kind,j.operation_id,j.result,j.ownership_receipt,j.cessation_evidence,
 j.spec#>>'{admitted,parentJobId}' AS parent_run,j.spec->>'parentJobId' AS parent_job,j.spec#>>'{admitted,toolCallId}' AS provider_call
 FROM matching_child_ids m CROSS JOIN LATERAL (SELECT * FROM job WHERE id=m.id OFFSET 0) j)
 SELECT json_build_object('candidates',coalesce((SELECT json_agg(c) FROM candidates c),'[]'::json),'children',coalesce((SELECT json_agg(c) FROM children c),'[]'::json)); ROLLBACK;`;
}
function terminalProjectionMatches(c,details) {
 switch(details?.phase) {
 case 'recovered-tool-terminal-observation':return details.originalRunId===c.run_id;
 case 'recovered-known-applied-tool-terminal-observation': {
  const effect=details.knownEffect,request=c.request_body;
  return details.originalAgentRunId===c.run_id&&isDeepStrictEqual(details.originalModelRun,{kind:'unknown'})
   &&details.providerCallId===c.provider_call_id&&c.tool_result.terminate===false
   &&details.error?.code==='outcome_uncertain'&&details.error.resourceId===c.id
   &&isDeepStrictEqual(details.cessationEvidence,c.cessation_evidence)
   &&effect?.kind==='known-applied-file'&&effect.originalCallCompletion==='not-established'
   &&request?.name==='write'&&typeof request.arguments?.content==='string'&&effect.path===request.arguments.path
   &&[effect.path,effect.exported,effect.repository,effect.evidence].every(p=>typeof p==='string'&&path.isAbsolute(p))
   &&typeof effect.commit==='string'&&/^[a-f0-9]{40}$/.test(effect.commit)
   &&effect.sha256===createHash('sha256').update(request.arguments.content,'utf8').digest('hex');
 }
 default:return false;
 }
}
function terminalDistinctSibling(child,c) {
 if(typeof child.operation_id!=='string'||!child.operation_id||child.operation_id===c.id||child.provider_call===c.provider_call_id||typeof child.provider_call!=='string'||!child.provider_call)return false;
 if(!['completed','failed','cancelled','interrupted'].includes(child.state)||!['tool-bash','tool-browser','editor'].includes(child.kind))return false;
 const owner=child.ownership_receipt,absence=child.cessation_evidence;
 return owner&&typeof owner.invocationId==='string'&&owner.invocationId.length>0&&typeof owner.unit==='string'&&owner.unit.length>0
  &&absence?.kind==='cgroup-empty'&&isDeepStrictEqual(absence.owner,owner);
}
function terminalDeclaredChildren(c,details,evidence) {
 if(!Array.isArray(details.children))return null;
 if(details.children.length===0)return new Set();
 if(details.phase!=='recovered-tool-terminal-observation'||details.children.length!==1
  ||c.request_body?.name!=='bash'||c.tool_result.terminate!==false
  ||details.error?.code!=='outcome_uncertain'||details.error.resourceId!==c.id)return null;
 const declared=details.children[0],child=evidence.children.find(x=>x.id===declared.jobId),material=details.knownMaterial;
 if(!child||child.operation_id!==c.id||child.provider_call!==c.provider_call_id
  ||child.parent_run!==c.run_id||child.kind!=='tool-bash'||declared.kind!==child.kind
  ||child.state!=='completed'||declared.state!==child.state||child.result?.exitCode!==0
  ||!isDeepStrictEqual(declared.result,child.result)||!isDeepStrictEqual(declared.ownershipReceipt,child.ownership_receipt)
  ||!isDeepStrictEqual(declared.cessationEvidence,child.cessation_evidence))return null;
 const owner=child.ownership_receipt,absence=child.cessation_evidence,process=child.result.processOutcome;
 if(!owner||typeof owner.unit!=='string'||!owner.unit||typeof owner.invocationId!=='string'||!owner.invocationId
  ||absence?.kind!=='cgroup-empty'||!isDeepStrictEqual(absence.owner,owner)||absence.result!=='success'||absence.exitCode!==0
  ||process?.state!=='recorded'||process.cause!=='exit'||process.exit?.kind!=='exited'||process.exit.code!==0
  ||!Number.isSafeInteger(process.startedAt)||!Number.isSafeInteger(process.exitedAt)||process.exitedAt<process.startedAt
  ||material?.kind!=='completed-original-bash-child'||material.jobId!==child.id||material.exitCode!==0
  ||!isDeepStrictEqual(material.result,child.result))return null;
 return new Set([child.id]);
}
export function settledToolOperationIds(evidence) {
 if(!evidence||!Array.isArray(evidence.candidates)||!Array.isArray(evidence.children)||evidence.children.length>=65)throw new Error('tool settlement observation incomplete');
 if(evidence.children.some(child=>!evidence.candidates.some(c=>child.id===c.run_id||child.operation_id===c.id||child.parent_run===c.run_id||child.parent_job===c.run_id||child.provider_call===c.provider_call_id)))throw new Error('tool child relationship projection incomplete');
 const settled=new Set();
 for(const c of evidence.candidates){
  const result=c.tool_result,details=result?.details,original=details?.originalOperation,absence=c.cessation_evidence,owner=c.ownership_receipt;
  if(c.state!=='uncertain'||c.command_type!=='agent.tool'||result?.isError!==true||details?.error?.retry!=='never'
   ||!terminalProjectionMatches(c,details)||details.operationId!==c.id
   ||details.replay!==false||!Array.isArray(details.children)
   ||(!isDeepStrictEqual(c.operation_result,result)&&!isDeepStrictEqual(c.operation_result,original))
   ||original?.kind!=='execution-interrupted'||original.jobId!==c.run_id
   ||!['interrupted','failed','cancelled','completed'].includes(c.owner_state)
   ||absence?.kind!=='absent'||!owner||typeof owner.invocationId!=='string'||!owner.invocationId||typeof owner.unit!=='string'||!owner.unit
   ||!isDeepStrictEqual(absence.owner,owner)||!isDeepStrictEqual(original.observation,absence)
   ||absence.proof?.kind!=='service-invocation-ended'||absence.proof.invocationId!==owner.invocationId||absence.proof.unit!==owner.unit)continue;
  const completedChildren=terminalDeclaredChildren(c,details,evidence);if(completedChildren===null)continue;
  if(evidence.children.some(child=>!completedChildren.has(child.id)&&child.id!==c.run_id&&(child.operation_id===c.id||child.parent_run===c.run_id||child.parent_job===c.run_id||child.provider_call===c.provider_call_id)&&!terminalDistinctSibling(child,c)))continue;
  settled.add(c.id);
 }
 return settled;
}
export function currentStackQueueReferences(roots,{resourceKind,cacheRoots,deadline,read=p=>JSON.parse(fs.readFileSync(p,'utf8')),execute=boundedCommand}={}){
 try{
  if(!Number.isSafeInteger(deadline))throw new Error('explicit absolute queue observation deadline required');
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
   const remaining=deadline-Date.now();if(remaining<=0)throw new Error('canonical queue operation deadline exhausted before '+domain.id);
   const result=execute('sudo',['-n','-u',domain.unixUser,'psql','-X','-qAt','--no-password','--host','/run/pi-stack-next/'+domain.id+'/pg','--username',domain.unixUser,'--dbname',config.database,'--set=ON_ERROR_STOP=1','--command',queueReferenceSql(roots,selfJobId,resourceKind)],{encoding:'utf8',timeout:Math.min(6000,remaining),maxBuffer:262144,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
   if(result.status!==0||result.error)throw new Error('canonical queue unavailable: '+domain.id+': '+String(result.error?.code??result.stderr??result.status).slice(0,1500));
   if(Date.now()>=deadline)throw new Error('canonical queue operation deadline exhausted after '+domain.id);
   const rows=JSON.parse(result.stdout);if(!Array.isArray(rows)||rows.length>=65||rows.some(r=>!r||typeof r.id!=='string'||!['job','input','operation','tool_call'].includes(r.kind)||typeof r.state!=='string'))throw new Error('canonical queue observation incomplete: '+domain.id);
   const uncertain=rows.filter(r=>r.kind==='operation'&&r.state==='uncertain'&&r.resourceClass==='execution').map(r=>r.id);
   let settled=new Set();
   if(uncertain.length){
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('tool settlement observation deadline exhausted');
    const proof=execute('sudo',['-n','-u',domain.unixUser,'psql','-X','-qAt','--no-password','--host','/run/pi-stack-next/'+domain.id+'/pg','--username',domain.unixUser,'--dbname',config.database,'--set=ON_ERROR_STOP=1','--command',toolSettlementSql(uncertain)],{encoding:'utf8',timeout:Math.min(6000,remaining),maxBuffer:262144,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
    if(proof.status!==0||proof.error)throw new Error('canonical tool settlement unavailable: '+domain.id+': '+String(proof.error?.code??proof.stderr??proof.status).slice(0,1500));
    if(Date.now()>=deadline)throw new Error('tool settlement observation deadline exhausted');
    settled=settledToolOperationIds(JSON.parse(proof.stdout));
   }
   references.push(...rows.filter(r=>!settled.has(r.id)&&(resourceKind!=='generated-cache'||!isSourceOnlyRead(r,cacheRoots))).map(r=>({...r,domainId:domain.id,roots}))); observations.push({domainId:domain.id,roots,count:rows.length,settledUncertainTools:[...settled]});
  }
  return {errors:[],references,observations,resourceKind,observedAt:Date.now()};
 }catch(error){return {errors:[String(error.message)],references:[],observations:[],observedAt:Date.now()};}
}

export function isSourceOnlyRead(reference,cacheRoots) {
 if(reference.toolName!=='read'||typeof reference.targetPath!=='string'||!path.isAbsolute(reference.targetPath))return false;
 try{const target=reference.targetPath;if(fs.realpathSync(target)!==target||!fs.statSync(target).isFile())return false;return cacheRoots.every(root=>target!==root&&!target.startsWith(root+path.sep)&&!root.startsWith(target+path.sep));}catch{return false;}
}
