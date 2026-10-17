import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const {queueReferenceSql,toolSettlementSql,settledToolOperationIds}=await import(process.env.WORKSPACE_QUEUE_MODULE||'./cache-queue.mjs');
const literal=x=>"'"+x.replaceAll("'","''")+"'";
const json=x=>literal(JSON.stringify(x))+'::jsonb';
test('actual PostgreSQL classifier distinguishes retained uncertainty from live, missing-proof, child, and source-intent custody',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-queue-pg-')),data=path.join(root,'data');
 const bin=process.env.WORKSPACE_TEST_PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8',timeout:2000}).trim();
 const pg=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});let started=false;
 try{
  pg('initdb',['-D',data,'--username=fixture','--no-locale','--auth=trust','--no-sync']);
  pg('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${root} -c listen_addresses='' -c max_connections=10 -c shared_buffers=8MB`,'-w','start']);started=true;
  let sql=`CREATE TABLE job(id text,state text,spec jsonb,operation_id text,ownership_receipt jsonb,cessation_evidence jsonb);
CREATE TABLE operation(id text,state text,command_type text,request_body jsonb,origin jsonb,result jsonb);
CREATE TABLE tool_call(id text,run_id text,provider_call_id text,operation_id text,result jsonb,tool_name text,arguments jsonb);
CREATE TABLE input(id text,state text,run_id text,content text,attachments jsonb,source jsonb);\n`;
  const names=['settled-nochild','settled-projected','settled-known-applied','known-applied-wrong-content','unsettled','live-owner','missing-cessation','mismatched-owner','mismatched-proof','unknown-owner-state','unknown-proof','nonterminal-result','known-child','live-child','unknown-child','parent-linked-child','call-linked-child','source-intent'];
  for(const name of names){
   const id='operation-'+name,ownerId='owner-'+name,provider='call-'+name,ownership={unit:'fixture.service',invocationId:'a'.repeat(32),hostId:'fixture',bootId:'fixture',generation:1,release:'fixture'};
   const absence={at:1,kind:'absent',owner:ownership,proof:{kind:'service-invocation-ended',unit:ownership.unit,invocationId:ownership.invocationId}};
   const original={kind:'execution-interrupted',jobId:ownerId,observation:structuredClone(absence)};
   let cessation=structuredClone(absence),state='interrupted';
   const details={phase:'recovered-tool-terminal-observation',error:{retry:'never'},operationId:id,originalRunId:ownerId,originalOperation:original,children:[],replay:false};
   let result={isError:true,details};
   if(name==='unsettled')result=null;if(name==='live-owner')state='running';if(name==='missing-cessation')cessation=null;
   if(name==='mismatched-owner')cessation.owner={...ownership,invocationId:'b'.repeat(32)};
   if(name==='mismatched-proof')cessation.proof.invocationId='b'.repeat(32);
   if(name==='unknown-owner-state')state='unreachable';if(name==='unknown-proof')cessation.proof.kind='unknown';
   if(name==='nonterminal-result')result={isError:false,details:{phase:'in-progress'}};
   const body={name:'bash',arguments:{command:'git -C /fixture/source status'}};
   if(name==='settled-known-applied'||name==='known-applied-wrong-content'){
    body.name='write';body.arguments={path:'/fixture/source/file',content:'original requested bytes'};
    delete details.originalRunId;details.phase='recovered-known-applied-tool-terminal-observation';details.originalAgentRunId=ownerId;
    details.originalModelRun={kind:'unknown'};details.providerCallId=provider;details.cessationEvidence=structuredClone(absence);
    details.error={code:'outcome_uncertain',retry:'never',resourceId:id};result.terminate=false;
    details.knownEffect={kind:'known-applied-file',path:body.arguments.path,sha256:createHash('sha256').update(body.arguments.content).digest('hex'),exported:'/fixture/export',repository:'/fixture/repository',evidence:'/fixture/evidence',commit:'a'.repeat(40),originalCallCompletion:'not-established'};
    if(name==='known-applied-wrong-content')details.knownEffect.sha256='b'.repeat(64);
   }
   sql+=`INSERT INTO operation VALUES(${literal(id)},'uncertain',${literal(name==='source-intent'?'conversation.send':'agent.tool')},${json(body)},'{}',${json(name==='settled-projected'?result:original)});\n`;
   sql+=`INSERT INTO job VALUES(${literal(ownerId)},${literal(state)},'{"kind":"agent-run"}',NULL,${json(ownership)},${cessation===null?'NULL':json(cessation)});\n`;
   sql+=`INSERT INTO tool_call VALUES(${literal('tool-'+name)},${literal(ownerId)},${literal(provider)},${literal(id)},${result===null?'NULL':json(result)},'bash',${json(body.arguments)});\n`;
   if(['known-child','live-child','unknown-child','parent-linked-child','call-linked-child'].includes(name)){
    const spec=name==='parent-linked-child'?{admitted:{parentJobId:ownerId}}:name==='call-linked-child'?{admitted:{toolCallId:provider}}:{};
    sql+=`INSERT INTO job VALUES(${literal('child-'+name)},${literal(name==='live-child'?'running':name==='unknown-child'?'unreachable':'completed')},${json(spec)},${['parent-linked-child','call-linked-child'].includes(name)?'NULL':literal(id)},NULL,'{}');\n`;
   }
  }
  const query=sql=>pg('psql',['-X','-qAt','--host',root,'--username','fixture','--dbname','postgres','--set=ON_ERROR_STOP=1','--command',sql]);
  query(sql);
  const lines=['physical-checkout','source'].map(kind=>{const rows=JSON.parse(query(queueReferenceSql('/fixture/source',null,kind)));const ids=rows.filter(r=>r.kind==='operation'&&r.state==='uncertain'&&r.resourceClass==='execution').map(r=>r.id);const settled=settledToolOperationIds(JSON.parse(query(toolSettlementSql(ids))));return rows.filter(r=>!settled.has(r.id));});
  assert.equal(lines.length,2);const [physical,source]=lines;
  for(const [name,rows] of [['physical',physical],['source',source]]){
   const ids=new Set(rows.filter(x=>x.kind==='operation').map(x=>x.id));assert.equal(ids.has('operation-settled-nochild'),false,name);assert.equal(ids.has('operation-settled-projected'),false,name);assert.equal(ids.has('operation-settled-known-applied'),false,name);
   for(const key of names.filter(x=>x!=='settled-nochild'&&x!=='settled-projected'&&x!=='settled-known-applied'&&x!=='source-intent'))assert.equal(ids.has('operation-'+key),true,`${name}/${key}`);
   assert.equal(ids.has('operation-source-intent'),name==='source');
  }
  if(process.env.WORKSPACE_RELEASE_PROOF_DIR){fs.mkdirSync(process.env.WORKSPACE_RELEASE_PROOF_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.WORKSPACE_RELEASE_PROOF_DIR,'queue-fixture.json'),JSON.stringify({cases:names,physical,source,scope:'isolated disposable PostgreSQL; no application database or external effect'},null,2)+'\n');}
 }finally{if(started)pg('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});}
});
