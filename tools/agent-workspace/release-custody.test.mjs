import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';import{DatabaseSync}from'node:sqlite';
const{main,workspaceTesting}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-custody-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'.gitignore'),'node_modules/\nprivate-evidence/\n');fs.writeFileSync(path.join(source,'proof'),'initial');git('-C',source,'add','.');git('-C',source,'commit','-m','initial');git('-C',source,'push','origin','main');const initial=git('-C',source,'rev-parse','HEAD');
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',initial,'--json']);fs.mkdirSync(path.join(source,'node_modules'));fs.writeFileSync(path.join(source,'node_modules','receipt'),'generated cache');db=new DatabaseSync(state);
  const commit=()=>{fs.writeFileSync(path.join(source,'proof'),'new unique work');git('-C',source,'commit','-am','unique');return git('-C',source,'rev-parse','HEAD');};const release=()=>run(['release','--id',record.id,'--preserve-runtime','--json']);
  action({root,source,remote,state,record,db,git,run,commit,release});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}
for(const kind of ['unpublished','dirty'])test('ordinary release preserves generated cache with '+kind+' source custody',()=>fixture(f=>{
 if(kind==='unpublished')f.commit();else fs.writeFileSync(path.join(f.source,'proof'),'dirty unique work');
 const result=f.release();assert.equal(result.record.state,'repair-required');assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.leaseRelease.kind,'released');assert.equal(result.cacheDisposition.kind,'none-selected');assert.equal(result.action,'none');assert.equal(fs.readFileSync(path.join(f.source,'node_modules','receipt'),'utf8'),'generated cache');assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),kind==='unpublished'?'new unique work':'dirty unique work');
}));
test('published exact branch with stale tracking refs is verified read-only before source/cache disposal',()=>fixture(f=>{
 const head=f.commit();f.git('-C',f.source,'push',f.remote,'HEAD:refs/heads/main');assert.notEqual(f.git('-C',f.source,'rev-parse','refs/remotes/origin/main'),head);
 const result=f.release();assert.equal(result.record.state,'released',JSON.stringify(result));assert.equal(result.physicalDisposition.kind,'removed');assert.equal(result.cacheDisposition.kind,'detached-for-retirement');assert.deepEqual(result.cacheDisposition.paths,['node_modules']);assert.equal(result.cacheDisposition.physicalReclaim,'not-measured');
}));
test('a different unpublished local branch still protects all cache/source even when current HEAD is published',()=>fixture(f=>{
 const unique=f.commit();f.git('-C',f.source,'branch','private-work',unique);f.git('-C',f.source,'checkout','main');f.git('-C',f.source,'reset','--hard','refs/remotes/origin/main');const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.cacheDisposition.kind,'none-selected');assert.equal(f.git('-C',f.source,'rev-parse','private-work'),unique);assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
}));
test('unknown remote custody retains source and cache instead of performing speculative cleanup',()=>fixture(f=>{
 f.commit();f.git('-C',f.source,'remote','set-url','origin',path.join(f.root,'missing.git'));const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.cacheDisposition.kind,'none-selected');assert.match(result.inspection.reason,/remote custody observation unavailable/);assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
}));
test('retained unclassified evidence and actual declared-cache detachment have separate typed effects',()=>fixture(f=>{
 fs.mkdirSync(path.join(f.source,'private-evidence'));fs.writeFileSync(path.join(f.source,'private-evidence','proof'),'preserve evidence');const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.record.state,'repair-required');assert.equal(result.cacheDisposition.kind,'detached-for-retirement');assert.deepEqual(result.cacheDisposition.paths,['node_modules']);assert.equal(fs.readFileSync(path.join(f.source,'private-evidence','proof'),'utf8'),'preserve evidence');
}));
test('group reconciliation also retains cache when unique source prevents release',()=>fixture(f=>{
 f.commit();f.db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(f.record.id);
 const safety={processes:[],threads:[],docker:{available:false,containers:[]},systemd:{available:false,units:[]},gitAlternates:[],linkedWorktrees:[],currentStackQueue:{errors:[],references:[],observedAt:Date.now()}};
 const result=workspaceTesting.groupReconciliation(f.db,[{...f.record,leaseExpiresAt:0}],{execute:true,ignoreLease:true,reapExpired:false,preserveRuntime:true,safety,statePath:f.state,terminalSourceTransfer:true,deadline:Date.now()+5000});assert.equal(result[0].action,'none');assert.deepEqual(result[0].removedCaches,[]);assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
}));
