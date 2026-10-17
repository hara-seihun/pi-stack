import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const modulePath=process.env.WORKSPACE_RELEASE_MODULE||fileURLToPath(new URL('./workspace.mjs',import.meta.url));
const {main}=await import(modulePath);
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-interruption-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const git=(...args)=>execFileSync('/usr/bin/git',args,{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let text='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{text+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(text);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'proof'),'preserved');git('-C',source,'add','.');git('-C',source,'commit','-m','fixture');git('-C',source,'push','origin','HEAD:refs/heads/main');const head=git('-C',source,'rev-parse','HEAD');
  const record=run(['register','--path',source,'--owner','release-fixture','--source-commit',head,'--json']);db=new DatabaseSync(state);
  const bin=path.join(root,'bin'),marker=path.join(root,'entered');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\ncase " $* " in *" status "*) echo entered > "$FAULT_MARKER"; sleep 5;; esac\nexec /usr/bin/git "$@"\n',{mode:0o755});
  const fault=(signal='TERM')=>spawnSync('timeout',[`--signal=${signal}`,'--kill-after=.1s','.6s',process.execPath,modulePath,'release','--id',record.id,'--preserve-runtime','--json'],{env:{...process.env,NODE_TEST_CONTEXT:'child-v8',PI_WORKSPACE_STATE:state,FAULT_MARKER:marker,PATH:`${bin}:${process.env.PATH}`},encoding:'utf8',timeout:2000});
  const status=()=>run(['status','--id',record.id,'--json']).records[0];const release=()=>run(['release','--id',record.id,'--preserve-runtime','--json']);
  action({root,source,remote,state,record,db,head,git,run,fault,marker,status,release});
 }finally{db?.close();if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;fs.rmSync(root,{recursive:true,force:true});}
}
for(const signal of ['TERM','KILL'])test(`actual ${signal} during release retains original identity and settles through supported CLI`,()=>fixture(f=>{
 const killed=f.fault(signal);assert.notEqual(killed.status,0);assert.equal(fs.existsSync(f.marker),true,JSON.stringify(killed));assert.equal(killed.stdout,'');
 const first=f.status();assert.equal(first.state,'repair-required');assert.equal(first.leaseExpiresAt,0);assert.equal(first.releaseSettlement.kind,'owned-retention');assert.equal(first.releaseSettlement.workspaceId,f.record.id);assert.equal(first.releaseSettlement.owner,'release-fixture');assert.equal(first.releaseSettlement.physicalDisposition.kind,'unsettled');assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'preserved');assert.equal(f.git('-C',f.source,'rev-parse','HEAD'),f.head);
 const repeated=f.status();assert.deepEqual(repeated.releaseSettlement,first.releaseSettlement);
 const result=f.release();assert.equal(result.action,'released');assert.equal(result.physicalDisposition.kind,'removed');assert.equal(result.releaseSettlement.kind,'completed');assert.equal(result.releaseSettlement.requestId,first.releaseSettlement.requestId);assert.equal(fs.existsSync(f.source),false);
 const final=f.status();assert.equal(final.state,'released');assert.equal(final.releaseSettlement.requestId,first.releaseSettlement.requestId);assert.equal(final.releaseSettlement.kind,'completed');assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace_release_attempt').get().n,1);
 if(process.env.WORKSPACE_RELEASE_PROOF_DIR){fs.mkdirSync(process.env.WORKSPACE_RELEASE_PROOF_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.WORKSPACE_RELEASE_PROOF_DIR,`fault-${signal}.json`),JSON.stringify({signal,caller:{status:killed.status,signal:killed.signal,stdout:killed.stdout,stderr:killed.stderr},enteredGitStatus:true,first,final,sourceHead:f.head,physicalPathAbsent:!fs.existsSync(f.source)},null,2)+'\n');}
}));
test('interrupted release cannot change its preserved runtime policy',()=>fixture(f=>{
 f.fault();const before=f.status();assert.throws(()=>f.run(['release','--id',f.record.id,'--json']),/retained request binding changed/);assert.deepEqual(f.status().releaseSettlement,before.releaseSettlement);assert.equal(fs.existsSync(f.source),true);
}));
test('fresh source edits after interruption remain retained by the same owner/request',()=>fixture(f=>{
 f.fault();const before=f.status();fs.writeFileSync(path.join(f.source,'proof'),'new dirty source');const result=f.release();assert.equal(result.releaseSettlement.requestId,before.releaseSettlement.requestId);assert.equal(result.record.state,'repair-required');assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.releaseSettlement.kind,'completed');assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'new dirty source');
}));
test('normal successful release persists its terminal receipt before output',()=>fixture(f=>{
 const result=f.release();assert.equal(result.releaseSettlement.kind,'completed');assert.equal(f.status().releaseSettlement.result.action,'released');assert.equal(f.status().releaseSettlement.result.physicalDisposition.kind,'removed');
}));
test('status page bounds, filter-preserving cursors, and executable help agree',()=>fixture(f=>{
 const help=execFileSync(process.execPath,[modulePath,'status','--help'],{encoding:'utf8',timeout:2000});assert.match(help,/limit 1\.\.500/);assert.match(help,/nextAfter.*same filters.*--after nextAfter/);
 assert.throws(()=>f.run(['status','--limit','501','--json']),/1 to 500/);assert.throws(()=>f.run(['status','--limit','3000','--json']),/1 to 500/);
 for(let i=0;i<2;i++){const target=path.join(f.root,`record-${i}`);f.git('clone',f.remote,target);f.git('-C',target,'checkout',f.head);f.run(['register','--path',target,'--owner','page-fixture','--source-commit',f.head,'--json']);}
 const first=f.run(['status','--owner','page-fixture','--limit','1','--json']);assert.equal(first.records.length,1);assert.equal(first.matched,2);assert.ok(first.nextAfter);const second=f.run(['status','--owner','page-fixture','--limit','1','--after',first.nextAfter,'--json']);assert.equal(second.records.length,1);assert.equal(second.nextAfter,null);assert.notEqual(first.records[0].id,second.records[0].id);
}));

test('group interruption atomically retains every peer and resumes one original request',()=>fixture(f=>{
 const peer=path.join(f.root,'peer');f.git('clone',f.remote,peer);f.git('-C',peer,'checkout',f.head);const record=f.run(['register','--path',peer,'--owner','release-fixture','--group','6fb-team','--source-commit',f.head,'--json']);f.db.prepare('UPDATE workspace SET group_id=? WHERE id=?').run('6fb-team',f.record.id);
 f.fault();const first=f.status(),other=f.run(['status','--id',record.id,'--json']).records[0];assert.equal(first.state,'repair-required');assert.equal(other.state,'repair-required');assert.equal(other.leaseExpiresAt,0);assert.equal(other.releaseSettlement.requestId,first.releaseSettlement.requestId);assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace_release_attempt').get().n,2);
 const results=f.release();assert.equal(results.length,2);for(const result of results){assert.equal(result.action,'released-group');assert.equal(result.releaseSettlement.requestId,first.releaseSettlement.requestId);assert.equal(result.releaseSettlement.kind,'completed');}assert.equal(fs.existsSync(peer),false);
}));
