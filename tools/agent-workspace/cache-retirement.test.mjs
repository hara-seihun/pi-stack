import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {retireWorkspaceCache} from './cache-retirement.mjs';
import {currentStackQueueReferences,queueReferenceSql,operatorJobFromCgroup,isSourceOnlyRead} from './cache-queue.mjs';
import {main,workspaceTesting} from './workspace.mjs';

function fixture(action){
 const base=fs.mkdtempSync(path.join(tmpdir(),'cache-retire-')),root=path.join(base,'source'),state=path.join(base,'state.sqlite3');fs.mkdirSync(root);
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 let db;
 try{
  git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\nignored-evidence/\n');fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(root,'package-lock.json'),'{}');fs.writeFileSync(path.join(root,'source.ts'),'original');git('add','.');git('commit','-m','unpublished');
  const run=args=>{const original=process.stdout.write,code=process.exitCode;let text='';process.stdout.write=x=>{text+=x;return true;};try{main(args,state);}finally{process.stdout.write=original;process.exitCode=code;}return JSON.parse(text);};
  const head=git('rev-parse','HEAD'),record=run(['register','--path',root,'--root',base,'--owner','fixture','--source-commit',head,'--json']);
  db=new DatabaseSync(state);db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(record.id);
  db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(record.id,String(fs.statSync(root).dev),JSON.stringify({historical:'capacity retained'}));
  fs.writeFileSync(path.join(root,'source.ts'),'dirty irreplaceable');fs.mkdirSync(path.join(root,'ignored-evidence'));fs.writeFileSync(path.join(root,'ignored-evidence','receipt'),'private receipt');
  const cache=path.join(root,'node_modules');fs.mkdirSync(cache);fs.writeFileSync(path.join(cache,'dependency'),'rebuildable');
  const binding=workspaceTesting.cacheBinding(db,record.id),r={kind:'retire-workspace-cache',operationId:'fixture-cache-36a4',binding,cachePath:'node_modules',classification:'node-dependencies',ownerEvidence:'original actor ended; no more dependency use'};
  const c={database:db,stateDirectory:base,deadline:Date.now()+10000,binding:()=>workspaceTesting.cacheBinding(db,record.id),classify:request=>workspaceTesting.classifyWorkspaceCache({...record,leaseExpiresAt:0},request),tracked:()=>false,original:()=>({record:db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id),plan:db.prepare('SELECT * FROM workspace_capacity WHERE workspace_id=?').get(record.id)}),invalidate:()=>{},safety:()=>({errors:[],references:[],retainedBorrowers:[],observedAt:Date.now()})};
  action({base,root,cache,db,r,c,run,git,record});
 }finally{db?.close();fs.rmSync(base,{recursive:true,force:true});}
}
const preserved=f=>({source:fs.readFileSync(path.join(f.root,'source.ts'),'utf8'),evidence:fs.readFileSync(path.join(f.root,'ignored-evidence','receipt'),'utf8'),head:f.git('rev-parse','HEAD'),row:f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id),capacity:f.db.prepare('SELECT * FROM workspace_capacity WHERE workspace_id=?').get(f.record.id)});

test('dirty unpublished source, unclassified ignored evidence and exact row/plan survive cache-only retirement and replay',()=>fixture(f=>{
 const before=preserved(f);const result=retireWorkspaceCache(f.c,f.r);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(fs.existsSync(f.cache),false);assert.deepEqual(preserved(f),before);assert.equal(retireWorkspaceCache(f.c,f.r).value.replayed,true);
}));
for(const kind of ['queued-tool','native-fd','thread','borrower','unknown-queue','active-lease','stale-head','tracked-cache','unclassified'])test('retirement refuses '+kind,()=>fixture(f=>{
 if(kind==='active-lease')f.db.prepare('UPDATE workspace SET lease_expires_at=? WHERE id=?').run(Date.now()+10000,f.record.id);
 else if(kind==='stale-head')f.r.binding.head='0'.repeat(40);
 else if(kind==='tracked-cache'){f.git('add','-f','node_modules/dependency');}
 else if(kind==='unclassified')f.r.cachePath='ignored-evidence';
 else f.c.safety=()=>({observedAt:Date.now(),errors:kind==='unknown-queue'?['queue unavailable']:[],references:['queued-tool','native-fd','thread'].includes(kind)?[{kind}]:[],retainedBorrowers:kind==='borrower'?[{id:'borrower'}]:[]});
 const before=preserved(f),result=retireWorkspaceCache(f.c,f.r);assert.equal(result.ok,false,JSON.stringify(result));assert.equal(fs.existsSync(path.join(f.cache,'dependency')),true);assert.deepEqual(preserved(f),before);
}));
test('symlinks unlink without following and shared hardlinks never claim physical gain',()=>fixture(f=>{
 const external=path.join(f.base,'external');fs.writeFileSync(external,'never remove');fs.symlinkSync(external,path.join(f.cache,'linked'));fs.linkSync(external,path.join(f.cache,'hard'));const before=fs.readFileSync(external,'utf8');const result=retireWorkspaceCache(f.c,f.r);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(fs.readFileSync(external,'utf8'),before);assert.match(result.value.measurement,/shared hardlinks excluded/);
}));
test('staged interruption resumes same operation without deleting recreated or source bytes',()=>fixture(f=>{
 f.c.afterRename=()=>{throw new Error('injected cessation');};assert.equal(retireWorkspaceCache(f.c,f.r).ok,false);assert.equal(fs.existsSync(f.cache),false);delete f.c.afterRename;assert.equal(retireWorkspaceCache(f.c,f.r).ok,true);assert.equal(fs.readFileSync(path.join(f.root,'source.ts'),'utf8'),'dirty irreplaceable');
}));
test('current canonical queue inventory includes reserved tools/escaped JSON/uncertain custody and fails honestly',()=>{
 const read=p=>p.endsWith('host.json')?{hostId:'host',installationId:'one'}:p.endsWith('registry.json')?{installationId:'one',domains:[{id:'hara',hostId:'host',unixUser:'pi2-hara'}]}:{domainId:'hara',database:'stack'};
 const result=currentStackQueueReferences(['/source'],{resourceKind:'source',read,execute:(_name,args)=>{const sql=args.at(-1);assert.match(sql,/tool_call/);assert.match(sql,/tc.result IS NULL/);assert.match(sql,/jsonb_path_query/);assert.match(sql,/cessation_evidence IS NULL/);assert.match(sql,/uncertain/);return {status:0,stdout:'[{"kind":"tool_call","id":"reserved","state":"unfinished"}]'};}});
 assert.equal(result.references[0].id,'reserved');assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',read,execute:()=>({status:2,stdout:''})}).errors.length,1);
 assert.equal(operatorJobFromCgroup('0::/pi-stack-next.slice/pi-stack-next-job-11111111-2222-3333-4444-555555555555-1.service'),'11111111-2222-3333-4444-555555555555');
 assert.match(queueReferenceSql("/source/'quoted",null,"source"),/''quoted/);
});

test('same current queued borrower protects ordinary release/reconcile/group paths before runtime reaping',()=>fixture(f=>{
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 try{
  const current={...f.record,leaseExpiresAt:0};const safety={processes:[],threads:[],docker:{containers:[],available:false},systemd:{units:[],available:false},currentStackQueue:{errors:[],references:[{kind:'tool_call',id:'reserved-native'}],observedAt:Date.now()}};
  const before=preserved(f),options={execute:true,reapExpired:true,preserveRuntime:false,ignoreLease:true,safety,statePath:path.join(f.base,'state.sqlite3')};
  assert.equal(workspaceTesting.reconcileRecord(f.db,current,options).action,'none');assert.equal(workspaceTesting.groupReconciliation(f.db,[current],options)[0].action,'none');assert.deepEqual(preserved(f),before);assert.equal(fs.existsSync(f.cache),true);
  safety.currentStackQueue={errors:['canonical query timeout'],references:[],observedAt:Date.now()};assert.equal(workspaceTesting.inspectRecord(current,{safety,ignoreLease:true}).classification,'blocked');
 }finally{if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;}
}));

test('terminal source transfer ignores only typed prose intent; dirty unpublished source and native consumers stay protected',()=>fixture(f=>{
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 try{
 const current={...f.record,leaseExpiresAt:0};const safety={threads:[],processes:[],docker:{containers:[],available:false},systemd:{units:[],available:false},currentStackQueue:{errors:[],references:[{kind:'input',resourceClass:'source-intent',id:'retained-prose'}],observedAt:Date.now()}};
 assert.equal(workspaceTesting.inspectRecord(current,{ignoreLease:true,safety}).currentStackQueueProtected,true);
 const inspected=workspaceTesting.inspectRecord(current,{ignoreLease:true,safety,terminalSourceTransfer:true});assert.notEqual(inspected.classification,'reclaimable');assert.equal(inspected.currentStackQueueProtected,undefined);assert.equal(fs.readFileSync(path.join(f.root,'source.ts'),'utf8'),'dirty irreplaceable');
 safety.currentStackQueue.references.push({kind:'tool_call',resourceClass:'reserved-tool-call',id:'real-native'});
 assert.equal(workspaceTesting.inspectRecord(current,{ignoreLease:true,safety,terminalSourceTransfer:true}).currentStackQueueProtected,true);
 const ended=workspaceTesting.leaseReleaseDisposition({record:current,inspection:{reason:'native deferred'},action:'none'});assert.equal(ended.leaseRelease.kind,'released');assert.equal(ended.physicalDisposition.kind,'retained');
 }finally{if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;}
}));

test('known source read differs from cache read, aliased target and unresolved Bash',()=>fixture(f=>{
 const roots=[f.cache];const source=path.join(f.root,'source.ts');assert.equal(isSourceOnlyRead({toolName:'read',targetPath:source},roots),true);
 assert.equal(isSourceOnlyRead({toolName:'read',targetPath:path.join(f.cache,'dependency')},roots),false);assert.equal(isSourceOnlyRead({toolName:'bash',targetPath:source},roots),false);assert.equal(isSourceOnlyRead({toolName:'read',targetPath:'source.ts'},roots),false);
 const alias=path.join(f.root,'aliased-source');fs.symlinkSync(path.join(f.cache,'dependency'),alias);assert.equal(isSourceOnlyRead({toolName:'read',targetPath:alias},roots),false);
}));

