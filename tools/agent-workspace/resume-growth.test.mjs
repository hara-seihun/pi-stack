import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{execFileSync,spawnSync}from'node:child_process';import{DatabaseSync}from'node:sqlite';import{fileURLToPath}from'node:url';import{digest}from'./growth-lifecycle.mjs';
const moduleFile=process.env.WORKSPACE_RESUME_MODULE||fileURLToPath(new URL('./workspace.mjs',import.meta.url));const{main}=await import(moduleFile);
function fixture(action,oldIntent='source-only'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'resume-contract-')),source=path.join(root,'source'),state=path.join(root,'registry.sqlite3');fs.mkdirSync(source);let db;const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...a)=>execFileSync('git',['-C',source,...a],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{const write=process.stdout.write,exit=process.exitCode;let text='';process.stdout.write=x=>{text+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(text);};
 try{
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'proof'),'preserved source');git('add','.');git('commit','-m','source');const head=git('rev-parse','HEAD');
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',head,'--json']);db=new DatabaseSync(state);
  db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(record.id,String(fs.statSync(source).dev),JSON.stringify({intent:oldIntent,estimate:'whole-tree-upper-bound',constructionBytes:4096,completedAllocationBytes:4096,growthBytes:512*1024**2,headroomBytes:8*1024**3}));
  run(['measure-capacity','--id',record.id,'--json']);const get=()=>run(['growth-status','--id',record.id,'--path',source,'--json']);
  const disposition={kind:'retire-future-growth',retainedUse:'source',remainingGrowthBytes:0,growthWriters:'none',writingLease:'retire',reason:'fixture work ended',ownerEvidence:'disposable fixture owner',observedAt:Date.now(),binding:get().binding};const bytes=JSON.stringify(disposition),file=path.join(root,'disposition.json');fs.writeFileSync(file,bytes);
  run(['retire-growth','--id',record.id,'--path',source,'--owner','fixture','--disposition',file,'--disposition-sha256',digest(bytes),'--json']);
  const argv=(selector,intent='source-only',owner='fixture',sha=get().binding.planSha256,growth='512',headroom='8')=>['resume-growth',...selector,'--owner',owner,'--expected-plan-sha256',sha,'--intent',intent,'--headroom-gib',headroom,'--growth-mib',growth,'--json'];
  const snapshot=()=>({record:db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id),plan:db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(record.id).plan_json,retirement:db.prepare('SELECT * FROM workspace_growth_retirement WHERE workspace_id=?').get(record.id),sample:db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(record.id).measurement_json,source:fs.readFileSync(path.join(source,'proof'),'utf8')});
  action({root,source,state,db,record,run,get,argv,snapshot});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}
for(const form of ['id','path','both'])test('retired source-only resumes source-only with '+form+' selector and actual fresh capacity admission',()=>fixture(f=>{
 const selector=form==='id'?['--id',f.record.id]:form==='path'?['--path',f.source]:['--id',f.record.id,'--path',f.source],before=f.snapshot();const result=f.run(f.argv(selector));assert.equal(result.capacity.intent,'source-only');assert.equal(result.capacity.growthLifecycle,undefined);assert.equal(result.capacity.headroomBytes,8*1024**3);assert.ok(result.capacity.admission);assert.equal(f.snapshot().record.lease_expires_at,0);assert.deepEqual(f.snapshot().retirement,before.retirement);assert.equal(f.snapshot().source,before.source);
}));
test('resume selector errors name resume-growth and mismatched pair preserves all custody',()=>fixture(f=>{
 const before=f.snapshot();assert.throws(()=>f.run(f.argv([])),e=>e.code==='invalid-workspace-selector'&&e.message.startsWith('resume-growth requires')&&e.nextAction.command==='resume-growth');assert.deepEqual(f.snapshot(),before);
 assert.throws(()=>f.run(f.argv(['--id',f.record.id,'--path',f.root])),e=>e.code==='growth-identity-changed'&&e.message.includes('resume-growth'));assert.deepEqual(f.snapshot(),before);
}));
test('source-only budgeted expansion remains a fresh admitted transition',()=>fixture(f=>{
 const result=f.run(f.argv(['--id',f.record.id],'budgeted','fixture',f.get().binding.planSha256,'1024'));assert.equal(result.capacity.intent,'budgeted');assert.equal(result.capacity.repricing.remainingGrowthBytes,1024*1024**2);assert.equal(result.capacity.growthLifecycle,undefined);
}));
test('budgeted cannot silently downgrade to source-only; explicit budgeted resume works',()=>fixture(f=>{
 const before=f.snapshot();assert.throws(()=>f.run(f.argv(['--id',f.record.id])),{code:'invalid-capacity-transition'});assert.deepEqual(f.snapshot(),before);assert.equal(f.run(f.argv(['--id',f.record.id],'budgeted')).capacity.intent,'budgeted');
},'budgeted'));
test('stale owner, stale plan, reduced headroom and impossible capacity preserve retired state',()=>fixture(f=>{
 const before=f.snapshot();for(const args of [f.argv(['--id',f.record.id],'source-only','wrong'),f.argv(['--id',f.record.id],'source-only','fixture','0'.repeat(64)),f.argv(['--id',f.record.id],'source-only','fixture',f.get().binding.planSha256,'512','7'),f.argv(['--id',f.record.id],'source-only','fixture',f.get().binding.planSha256,'100000000')]){assert.throws(()=>f.run(args));assert.deepEqual(f.snapshot(),before);}
}));
test('stale actual allocation sample refuses source-only resume without plan or source changes',()=>fixture(f=>{
 const sample=JSON.parse(f.snapshot().sample);f.db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify({...sample,startedAt:0}),f.record.id);const before=f.snapshot();assert.throws(()=>f.run(f.argv(['--id',f.record.id])),/fresh allocated-block sample/);assert.deepEqual(f.snapshot(),before);
}));
test('installed executable help and typed selector error share the command-specific contract',()=>fixture(f=>{
 const help=spawnSync(process.execPath,[moduleFile,'--help'],{encoding:'utf8',timeout:5000});assert.equal(help.status,0);assert.match(help.stdout,/resume-growth \(--id ID \[--path PATH\]\|--path PATH\).*--intent source-only\|budgeted/);
 const bad=spawnSync(process.execPath,[moduleFile,...f.argv([])],{encoding:'utf8',timeout:5000,env:{...process.env,PI_WORKSPACE_STATE:f.state}});assert.equal(bad.status,2);const body=JSON.parse(bad.stdout);assert.equal(body.error.code,'invalid-workspace-selector');assert.match(body.error.detail,/^resume-growth requires/);assert.equal(body.error.nextAction.command,'resume-growth');
}));
