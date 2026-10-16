import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const journalRecord=(db,id)=>db.prepare('SELECT record_json FROM workspace_growth_retirement WHERE workspace_id=?').get(id).record_json;
import {main,workspaceTesting} from './workspace.mjs';
import {digest,validateRetirement,retainedGrowth} from './growth-lifecycle.mjs';
const binding={borrowersSha256:'f'.repeat(64),id:'id',path:'/source',owner:'current-owner',sourceCommit:'a'.repeat(40),durableSourceCommit:'b'.repeat(40),head:'c'.repeat(40),state:'referenced',updatedAt:1,leaseExpiresAt:0,device:'1',inode:'2',planSha256:'d'.repeat(64),sampleSha256:'e'.repeat(64)};
const disposition=()=>({kind:'retire-future-growth',retainedUse:'source',remainingGrowthBytes:0,growthWriters:'none',writingLease:'retire',reason:'completed build',ownerEvidence:'owner terminal receipt',observedAt:Date.now(),binding:{...binding}});
const empty={references:[],errors:[]};
for(const key of Object.keys(binding)) test(`retained growth rejects stale ${key}`,()=>{
 const d=disposition();d.binding[key]=key==='leaseExpiresAt'?1:'stale';
 assert.throws(()=>validateRetirement(d,binding,empty),{code:'stale-growth-disposition'});
});
for(const [name,change,code] of [
 ['missing disposition',()=>null,'invalid-growth-disposition'],['negative remaining',d=>({...d,remainingGrowthBytes:-1}),'invalid-growth-disposition'],
 ['unknown writers',d=>({...d,growthWriters:'unknown'}),'invalid-growth-disposition'],['missing evidence',d=>({...d,ownerEvidence:''}),'invalid-growth-disposition'],
 ['stale observation',d=>({...d,observedAt:0}),'stale-growth-disposition'],['future observation',d=>({...d,observedAt:Date.now()+60000}),'stale-growth-disposition']]) test(`retained growth rejects ${name}`,()=>assert.throws(()=>validateRetirement(change(disposition()),binding,empty),{code}));
test('retained growth rejects active and unknown runtime writers',()=>{
 assert.throws(()=>validateRetirement(disposition(),binding,{references:[{pid:1}],errors:[]}),{code:'growth-writer-active'});
 assert.throws(()=>validateRetirement(disposition(),binding,{references:[],errors:['foreign cwd EACCES']}),{code:'growth-writer-unknown'});
 const active={...binding,leaseExpiresAt:1};const d=disposition();d.binding=active;
 assert.doesNotThrow(()=>validateRetirement(d,active,empty));
 assert.throws(()=>validateRetirement(d,active,{references:[{pid:2}],errors:[]}),{code:'growth-writer-active'});
 assert.throws(()=>validateRetirement({...d,writingLease:undefined},active,empty),{code:'invalid-growth-disposition'});
 assert.throws(()=>validateRetirement(disposition(),binding,{}),{code:'growth-writer-unknown'});
});
test('retained growth validates lifecycle and preserves numeric budget validation',()=>{
 const plan={intent:'budgeted',constructionBytes:10,growthBytes:100,headroomBytes:200,growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'runtime',dispositionSha256:'a'.repeat(64),retiredAt:0}};
 assert.equal(retainedGrowth(plan),true);
 assert.equal(workspaceTesting.remainingCapacityBytes(plan,'referenced',{ok:false}),0);
 assert.equal(workspaceTesting.capacityRequirement({...plan,constructionBytes:0,growthBytes:0},[]),200);
 assert.throws(()=>workspaceTesting.remainingCapacityBytes({...plan,growthBytes:-1},'referenced',{ok:false}));
 assert.throws(()=>workspaceTesting.remainingCapacityBytes({...plan,growthLifecycle:{kind:'unknown'}},'referenced',{ok:false}),{code:'invalid-growth-lifecycle'});
});

// Real Git + real SQLite, private test registry. No live transition or application effect.
for (const lease of ['valid','expired']) test(`retained growth CLI ${lease} lease preserves unpublished source and linked borrower, history/sample/headroom; fresh admission required`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'retained-growth-'));
 const source=path.join(root,'source'),borrower=path.join(root,'borrower'),state=path.join(root,'registry.sqlite3');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
 const beforeEnv={...process.env};
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 try {
 mkdirSync(source);git('init','-b','main',source);git('-C',source,'config','user.email','fixture@example.invalid');git('-C',source,'config','user.name','Fixture');
 mkdirSync(path.join(source,'node_modules'));writeFileSync(path.join(source,'node_modules','keep.txt'),'retained runtime');
 writeFileSync(path.join(source,'.gitignore'),'node_modules/\n');
 writeFileSync(path.join(source,'proof.txt'),'irreplaceable unpublished proof');git('-C',source,'add','.');git('-C',source,'commit','-m','unpublished proof');
 const head=git('-C',source,'rev-parse','HEAD');git('-C',source,'worktree','add','--detach',borrower,head);
 const run=args=>{let text='';const priorExit=process.exitCode;const original=process.stdout.write;process.stdout.write=chunk=>{text+=chunk;return true;};try {main(args,state);} finally {process.stdout.write=original;process.exitCode=priorExit;} return JSON.parse(text);};
 const register=p=>run(['register','--path',p,'--root',root,'--owner','current-owner','--source-commit',head,'--json']);
 const record=register(source);const child=register(borrower);
 const db=new DatabaseSync(state);db.prepare("UPDATE workspace SET state='referenced' WHERE id=?").run(record.id);
 const stats=statSync(source),device=String(stats.dev);
 const plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:4096,growthBytes:26159738880,headroomBytes:8589934592,completedAllocationBytes:4096};
 const planText=JSON.stringify(plan);db.prepare('INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,device,planText);
 const sample={ok:true,bytes:4096,allocatedBytes:4096,device,inode:String(stats.ino),startedAt:Date.now(),completedAt:Date.now()};
 const sampleText=JSON.stringify(sample);db.prepare('INSERT INTO workspace_capacity_measurement VALUES(?,?)').run(record.id,sampleText);
 if(lease==='expired') db.prepare('UPDATE workspace SET lease_expires_at=1 WHERE id=?').run(record.id);
 const originalRecord=db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id);
 const get=()=>run(['growth-status','--id',record.id,'--path',source,'--json']);
 const d={...disposition(),binding:get().binding};const file=path.join(root,'disposition.json');
 const retire=value=>{const bytes=JSON.stringify(value);writeFileSync(file,bytes);return run(['retire-growth','--id',record.id,'--path',source,'--owner','current-owner','--disposition',file,'--disposition-sha256',digest(bytes),'--json']);};
 const wrong={...d,binding:{...d.binding,planSha256:'0'.repeat(64)}};
 assert.throws(()=>retire(wrong),{code:'stale-growth-disposition'});
 db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify({...sample,startedAt:0}),record.id);
 assert.throws(()=>retire(d),{code:'growth-sample-required'});
 db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(sampleText,record.id);
 assert.throws(()=>retire(d),{code:'growth-writer-active'});
 db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(child.id);
 d.binding=get().binding;
 const result=retire(d);assert.equal(result.kind,'retired-future-growth');assert.equal(result.safety.retainedBorrowers.length,1);
 const afterRecord=db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id);
 assert.equal(afterRecord.lease_expires_at,0);
 assert.deepEqual({...afterRecord,updated_at:originalRecord.updated_at,lease_expires_at:originalRecord.lease_expires_at},{...originalRecord});
 const recordedHistory=JSON.parse(journalRecord(db,record.id));
 assert.equal(recordedHistory.leaseExpiresAt,originalRecord.lease_expires_at);
 assert.equal(recordedHistory.owner,originalRecord.owner);
 assert.equal(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(record.id).measurement_json,sampleText);
 const journal=db.prepare('SELECT * FROM workspace_growth_retirement WHERE workspace_id=?').get(record.id);
 assert.equal(journal.old_plan_json,planText);assert.equal(journal.measurement_json,sampleText);assert.equal(journal.disposition_json,JSON.stringify(d));
 const reservation=workspaceTesting.capacityReservations(db,device,'unrelated');
 assert.equal(reservation.priced.length,0);assert.equal(reservation.headroomBytes,8589934592);
 assert.equal(reservation.measurementFailures,undefined);
 assert.equal(get().plan.growthBytes,26159738880);assert.equal(get().plan.headroomBytes,8589934592);
 assert.equal(readFileSync(path.join(source,'proof.txt'),'utf8'),'irreplaceable unpublished proof');assert.equal(git('-C',borrower,'rev-parse','HEAD'),head);
 assert.equal(readFileSync(path.join(source,'node_modules','keep.txt'),'utf8'),'retained runtime');
 assert.ok(existsSync(path.join(borrower,'.git')));assert.equal(db.prepare('SELECT state FROM workspace WHERE id=?').get(child.id).state,'active');
 assert.throws(()=>run(['heartbeat','--id',record.id,'--json']),{code:'growth-admission-required'});
 assert.throws(()=>run(['reprice-capacity','--id',record.id,'--intent','budgeted','--headroom-gib','8','--growth-mib','512','--json']),{code:'growth-admission-required'});
 assert.throws(()=>retire(d),{code:'growth-already-retired'});
 assert.throws(()=>run(['heartbeat','--id',child.id,'--json']),{code:'growth-admission-required'});
 assert.equal(run(['release','--id',record.id,'--json']).action,'none');
 const reconciliation=run(['reconcile','--id',record.id,'--execute','--reap-expired','--json']);
 assert.equal(reconciliation[0].action,'none');
 assert.equal(readFileSync(path.join(source,'node_modules','keep.txt'),'utf8'),'retained runtime');
 assert.throws(()=>register(source),{code:'growth-admission-required'});
 const reassigned=run(['reassign','--id',record.id,'--path',source,'--from-owner','current-owner','--from-source-commit',head,'--from-state','referenced','--owner','next-owner','--source-commit',head,'--authorization','test','--json']);
 assert.equal(reassigned.ok,false);assert.equal(reassigned.error.code,'growth-admission-required');
 const retiredPlan=get().plan;
 assert.throws(()=>run(['resume-growth','--id',record.id,'--owner','old-owner','--expected-plan-sha256',get().binding.planSha256,'--intent','budgeted','--headroom-gib','8','--growth-mib','512','--json']),{code:'stale-growth-disposition'});
 // Deliberately impossible fresh budget: refusal must preserve retirement and old journal.
 assert.throws(()=>run(['resume-growth','--id',record.id,'--owner','current-owner','--expected-plan-sha256',get().binding.planSha256,'--intent','budgeted','--headroom-gib','8','--growth-mib','100000000','--json']),/GiB is free/);
 assert.deepEqual(get().plan,retiredPlan);
 const resumed=run(['resume-growth','--id',record.id,'--owner','current-owner','--expected-plan-sha256',get().binding.planSha256,'--intent','budgeted','--headroom-gib','8','--growth-mib','512','--json']);
 assert.equal(resumed.capacity.growthLifecycle,undefined);assert.equal(resumed.capacity.growthBytes,512*1024**2);assert.equal(resumed.capacity.headroomBytes,8589934592);
 assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_growth_retirement').get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_capacity_repricing').get().n,1);
 db.close();
 } finally {for(const key of Object.keys(process.env)) if(!(key in beforeEnv)) delete process.env[key];Object.assign(process.env,beforeEnv);rmSync(root,{recursive:true,force:true});}
});

test('dependency topology streams identities without reading unrelated registry payloads',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE workspace(id TEXT,path TEXT,checkout_type TEXT,cache_paths TEXT,creation_request TEXT)');
 db.prepare('INSERT INTO workspace VALUES(?,?,?,?,?)').run('missing','/nonexistent-topology-test-record','clone','malformed cache JSON','malformed request JSON');
 let iterated=false;
 const bounded={prepare(sql){
   assert.match(sql,/^SELECT id,path,checkout_type AS checkoutType FROM workspace /);
   assert.doesNotMatch(sql,/cache_paths|creation_request|SELECT \*/);
   const statement=db.prepare(sql);
   return {iterate(){iterated=true;return statement.iterate();},all(){assert.fail('topology must stream rows');}};
 }};
 assert.deepEqual(workspaceTesting.gitDependencySnapshot(bounded),{alternates:[],linkedWorktrees:[]});
 assert.equal(iterated,true);db.close();
});
