import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {main,workspaceTesting} from './workspace.mjs';
import {digest,validateReduction} from './growth-lifecycle.mjs';
const M=1024**2;
const binding={borrowersSha256:digest('[]'),id:'id',path:'/source',owner:'owner',sourceCommit:'a'.repeat(40),durableSourceCommit:'b'.repeat(40),head:'c'.repeat(40),state:'active',updatedAt:1,leaseExpiresAt:Date.now()+3600000,device:'1',inode:'2',planSha256:'d'.repeat(64),sampleSha256:'e'.repeat(64)};
const disposition=b=>({kind:'reduce-active-future-growth',remainingGrowthBytes:64*M,reason:'bounded remaining work',ownerEvidence:'original owner remaining writes <=64 MiB',observedAt:Date.now(),binding:b});
for(const key of Object.keys(binding)) test(`active reduction refuses stale ${key}`,()=>{
 const d=disposition({...binding,[key]:'stale'});
 assert.throws(()=>validateReduction(d,binding,'owner',64*M),{code:'stale-growth-reduction'});
});
test('active reduction refuses missing, invalid, expired, foreign and unbounded declarations',()=>{
 for(const d of [null,{}, {...disposition(binding),remainingGrowthBytes:0},{...disposition(binding),ownerEvidence:''}]) assert.throws(()=>validateReduction(d,binding,'owner',64*M),{code:'invalid-growth-reduction'});
 for(const [d,b,owner] of [[{...disposition(binding),observedAt:0},binding,'owner'],[{...disposition(binding),observedAt:Date.now()+100000},binding,'owner'],[disposition(binding),binding,'foreign'],[disposition({...binding,leaseExpiresAt:0}),{...binding,leaseExpiresAt:0},'owner']]) assert.throws(()=>validateReduction(d,b,owner,64*M),{code:'stale-growth-reduction'});
 assert.doesNotThrow(()=>validateReduction(disposition(binding),binding,'owner',64*M));
});

for (const [priorIntent, nextIntent] of [['source-only','budgeted'],['source-only','source-only'],['budgeted','budgeted']]) test(`active reduction ${priorIntent} to ${nextIntent} real CLI preserves baseline/custody/lease/other reservations and refuses stale or unsafe changes atomically`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'active-reduction-'));let db;
 const source=path.join(root,'source'),state=path.join(root,'registry.sqlite3'),file=path.join(root,'reduction.json');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
 const run=args=>{let text='';const prior=process.stdout.write;const exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};try{main(args,state);}finally{process.stdout.write=prior;process.exitCode=exit;}return JSON.parse(text);};
 try {
 mkdirSync(source);git('init','-b','main',source);git('-C',source,'config','user.email','fixture@example.invalid');git('-C',source,'config','user.name','Fixture');writeFileSync(path.join(source,'proof'),'preserve unpublished source');git('-C',source,'add','.');git('-C',source,'commit','-m','source');const head=git('-C',source,'rev-parse','HEAD');
 const rec=run(['register','--path',source,'--root',root,'--owner','owner','--source-commit',head,'--json']);
 db=new DatabaseSync(state); const stats=statSync(source),device=String(stats.dev);
 // Original3357 numeric accounting shape; fixture sample is not a live measurement.
 const plan={intent:priorIntent,constructionBytes:328032984,sourceImportBytes:265006712,completedAllocationBytes:10416128,growthBytes:512*M,headroomBytes:8*1024**3,sourceCommit:head,estimate:'git-sparse-upper-bound'};
 db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(rec.id,device,JSON.stringify(plan));
 const sample={ok:true,bytes:61612032,allocatedBytes:61612032,device,inode:String(stats.ino),startedAt:Date.now(),completedAt:Date.now()};
 db.prepare('INSERT INTO workspace_capacity_measurement VALUES(?,?)').run(rec.id,JSON.stringify(sample));
 const get=()=>run(['growth-status','--id',rec.id,'--path',source,'--json']);
 const args=['reprice-capacity','--id',rec.id,'--path',source,'--intent',nextIntent,'--headroom-gib','8','--growth-mib','64','--json'];
 assert.throws(()=>run(args.filter((_,i)=>i!==3 && i!==4)),/cannot reduce headroom or total growth|to budgeted expansion/); // retained refusal, before explicit reduction
 const beforeRecord=db.prepare('SELECT * FROM workspace WHERE id=?').get(rec.id);
 const beforePlan=JSON.stringify(plan),beforeSample=JSON.stringify(sample);
 let d=disposition(get().binding);
 const reduce=(value,overrides=[])=>{const bytes=JSON.stringify(value);writeFileSync(file,bytes);return run([...args,...overrides,'--owner','owner','--reduction',file,'--reduction-sha256',digest(bytes)]);};
 const untouched=()=>{assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(rec.id).plan_json,beforePlan);assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing').get().n,0);};
 for(const key of Object.keys(d.binding)) {assert.throws(()=>reduce({...d,binding:{...d.binding,[key]:'stale'}}),{code:'stale-growth-reduction'});untouched();}
 const staleSample={...sample,startedAt:0};db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify(staleSample),rec.id);assert.throws(()=>reduce(d),/fresh allocated-block sample/);untouched();db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(beforeSample,rec.id);
 const unsafeArgs=[...args];unsafeArgs[unsafeArgs.indexOf('8')]='7';const bytes=JSON.stringify(d);writeFileSync(file,bytes);assert.throws(()=>run([...unsafeArgs,'--owner','owner','--reduction',file,'--reduction-sha256',digest(bytes)]),{code:'unsafe-growth-reduction'});untouched();
 assert.throws(()=>run([...args,'--owner','foreign','--reduction',file,'--reduction-sha256',digest(bytes)]),{code:'stale-growth-reduction'});untouched();
 // Another independent row's bill cannot be discounted to admit this reduction.
 const other=path.join(root,'other');mkdirSync(other);git('clone','--no-hardlinks',source,other);const r2=run(['register','--path',other,'--root',root,'--owner','foreign','--source-commit',head,'--json']);
 const otherPlan={...plan,growthBytes:1000000*M};db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(r2.id,device,JSON.stringify(otherPlan));
 // Expanded writes still require full admission even while a reduction can repair oversubscription.
 const expansion=args.filter((_,i)=>i!==3 && i!==4);expansion[expansion.indexOf('64')]='1024';expansion[expansion.indexOf(nextIntent)]='budgeted';
 assert.throws(()=>run(expansion),{code:'workspace-capacity-refused'});untouched();
 // Raising operating headroom enough to worsen the host deficit is not a monotone repair.
 const worse=[...args];worse[worse.indexOf('8')]='9';writeFileSync(file,bytes);
 assert.throws(()=>run([...worse,'--owner','owner','--reduction',file,'--reduction-sha256',digest(bytes)]),error=>['unsafe-growth-reduction','workspace-capacity-refused'].includes(error.code));untouched();
 const nondecrease={...d,remainingGrowthBytes:512*M};const sameArgs=[...args];sameArgs[sameArgs.indexOf('64')]='512';const same=JSON.stringify(nondecrease);writeFileSync(file,same);
 assert.throws(()=>run([...sameArgs,'--owner','owner','--reduction',file,'--reduction-sha256',digest(same)]),{code:'unsafe-growth-reduction'});untouched();
 // A newly unestimated allocation cannot use the monotone replacement lane.
 const fresh=path.join(root,'fresh');git('clone','--no-hardlinks',source,fresh);
 const r3=run(['register','--path',fresh,'--root',root,'--owner','new-owner','--source-commit',head,'--json']);
 const freshPlan={intent:'unestimated',estimate:'unknown',constructionBytes:0,growthBytes:0,headroomBytes:8*1024**3};
 db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(r3.id,device,JSON.stringify(freshPlan));
 const fstats=statSync(fresh);db.prepare('INSERT INTO workspace_capacity_measurement VALUES(?,?)').run(r3.id,JSON.stringify({...sample,inode:String(fstats.ino)}));
 assert.throws(()=>run(['reprice-capacity','--id',r3.id,'--intent','budgeted','--growth-mib','64','--headroom-gib','8','--json']),{code:'workspace-capacity-refused'});
 assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(r3.id).plan_json,JSON.stringify(freshPlan));untouched();
 const otherBefore=db.prepare('SELECT * FROM workspace WHERE id=?').get(r2.id);
 assert.throws(()=>reduce(d,['--budget-ms','500']),{code:'growth-sample-required'});untouched();
 for(let i=0;i<80;i++)writeFileSync(path.join(source,'clock-leaf-'+i),'all allocated entries counted');
 const realNow=Date.now;let clock=realNow(),result;
 try{Date.now=()=>clock+=20;result=reduce(d);}finally{Date.now=realNow;}
 const next=result.capacity;
 assert.ok(next.repricing.currentMeasurement.completedAt-next.repricing.currentMeasurement.startedAt>500);

 assert.equal(next.growthBytes,61612032-10416128+64*M);assert.equal(next.repricing.currentMeasurement.ok,true);assert.ok(next.repricing.currentMeasurement.bytes>0);assert.equal(next.repricing.currentMeasurement.inode,String(stats.ino));assert.equal(next.completedAllocationBytes,plan.completedAllocationBytes);assert.equal(next.sourceImportBytes,plan.sourceImportBytes);assert.equal(next.constructionBytes,plan.constructionBytes);assert.equal(next.sourceCommit,plan.sourceCommit);assert.equal(next.headroomBytes,plan.headroomBytes);assert.equal(next.growthLifecycle,undefined);
 assert.equal(next.admission.reservedBytes,1000000*M);assert.ok(next.admission.requiredBytes>=8*1024**3+1000000*M+64*M);
 assert.equal(next.admission.kind,'monotone-reduction');assert.equal(next.admission.newWritesAuthorized,false);
 assert.ok(next.admission.requiredBytes>next.admission.freeBytes);
 assert.ok(next.admission.previousRequiredBytes>next.admission.requiredBytes);
 assert.ok(next.admission.deficitBytesAfter<next.admission.deficitBytesBefore);
 assert.equal(next.admission.previousRequiredBytes-next.admission.requiredBytes,plan.growthBytes-next.growthBytes);
 assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(rec.id),beforeRecord);assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(r2.id),otherBefore);
 assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(r2.id).plan_json,JSON.stringify(otherPlan));assert.equal(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(rec.id).measurement_json,beforeSample);
 assert.equal(git('-C',source,'rev-parse','HEAD'),head);assert.equal(readFileSync(path.join(source,'proof'),'utf8'),'preserve unpublished source');
 const journal=db.prepare('SELECT * FROM workspace_capacity_repricing WHERE workspace_id=?').get(rec.id);assert.equal(journal.old_plan_json,beforePlan);assert.equal(journal.measurement_json,beforeSample);assert.deepEqual(JSON.parse(journal.new_plan_json).repricing.reduction,{...d,sha256:digest(bytes)});
 const measured=workspaceTesting.cachedWorkspaceAllocation(db,rec.id,source,device);assert.ok(workspaceTesting.remainingCapacityBytes(next,'active',measured)>=64*M);
 assert.throws(()=>reduce(d),{code:'stale-growth-reduction'});assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing').get().n,1);
 // Current under-lock measurement must prevent credit from an undercounted old cache.
 const low={...sample,bytes:0,allocatedBytes:0,startedAt:Date.now(),completedAt:Date.now()};
 db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify(low),rec.id);
 writeFileSync(path.join(source,'remaining-work'),Buffer.alloc(12*M,1));
 const d2={...disposition(get().binding),remainingGrowthBytes:32*M};const b2=JSON.stringify(d2);writeFileSync(file,b2);
 const a2=[...args];a2[a2.indexOf('64')]='32';
 const next2=run([...a2,'--owner','owner','--reduction',file,'--reduction-sha256',digest(b2)]).capacity;
 assert.ok(next2.repricing.currentMeasurement.bytes>plan.completedAllocationBytes);
 assert.equal(next2.growthBytes,next2.repricing.currentMeasurement.bytes-plan.completedAllocationBytes+32*M);
 assert.equal(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(rec.id).measurement_json,JSON.stringify(low));
 assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(rec.id),beforeRecord);

 } finally {db?.close();rmSync(root,{recursive:true,force:true});}
});
