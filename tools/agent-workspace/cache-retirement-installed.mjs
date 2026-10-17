import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base=fs.mkdtempSync(path.join(tmpdir(),'cache-installed-')),root=path.join(base,'source'),state=path.join(base,'registry.sqlite3');
const entry=new URL('./workspace.mjs',import.meta.url).pathname;
const env={...process.env,PI_WORKSPACE_STATE:state};delete env.NODE_TEST_CONTEXT;delete env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;
const call=args=>JSON.parse(execFileSync(process.execPath,[entry,...args],{encoding:'utf8',env,timeout:45000}));
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
let held;const entries=process.argv.length===2?0:Number(process.argv[3]);if(process.argv.length!==2&&(process.argv.length!==4||process.argv[2]!=='--entries'||!Number.isInteger(entries)||entries<1||entries>500000))throw Error('explicit --entries1..500000 required');
try{
 fs.mkdirSync(root);git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
 fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\nevidence/\n');fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(root,'package-lock.json'),'{}');fs.writeFileSync(path.join(root,'source'),'unpublished original');git('add','.');git('commit','-m','unpublished source');fs.writeFileSync(path.join(root,'source'),'dirty preserved');fs.mkdirSync(path.join(root,'evidence'));fs.writeFileSync(path.join(root,'evidence','receipt'),'retained evidence');
 fs.mkdirSync(path.join(root,'node_modules'));const target=path.join(root,'node_modules','generated');fs.writeFileSync(target,'regenerable');
 if(entries){const shared=path.join(base,'outside-payload');fs.writeFileSync(shared,'external inode retained');for(let i=0;i<entries;i++)fs.linkSync(shared,path.join(root,'node_modules','entry-'+String(i).padStart(6,'0')));}
 const record=call(['register','--path',root,'--root',base,'--owner','fixture','--source-commit',git('rev-parse','HEAD'),'--json']);
 const db=new DatabaseSync(state);db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(record.id);db.close();
 const plan=call(['cache-plan','--id',record.id,'--path',root,'--owner','fixture','--cache','node_modules','--classification','node-dependencies','--operation-id','installed-cache-fixture','--evidence','isolated fixture expired; no work will use dependencies','--json']);assert.equal(plan.ok,true,JSON.stringify(plan));
 const bytes=JSON.stringify(plan.value.request),request=path.join(base,'request.json');fs.writeFileSync(request,bytes);const hash=createHash('sha256').update(bytes).digest('hex');
 const args=['retire-cache','--id',record.id,'--path',root,'--owner','fixture','--request',request,'--request-sha256',hash,'--json'];
 held=spawn(process.execPath,['-e',`const f=require('node:fs');f.openSync(${JSON.stringify(target)},'r');console.log('ready');setInterval(()=>{},1000)`],{stdio:['ignore','pipe','pipe']});await once(held.stdout,'data');
 let blocked;try{call(args);assert.fail('read FD must protect cache');}catch(error){blocked=JSON.parse(error.stdout);assert.equal(blocked.ok,false);assert.equal(fs.existsSync(target),true);}
 held.kill('SIGKILL');await once(held,'exit');held=null;
 let paused=null,result;try{result=call(args);}catch(error){const refused=JSON.parse(error.stdout);if(refused.error?.code!=='generated-io-error'||!refused.error.detail.includes('bounded deletion paused'))throw error;paused=refused;result=call(args);}assert.equal(result.ok,true,JSON.stringify(result));assert.equal(fs.existsSync(path.join(root,'node_modules')),false);assert.equal(fs.readFileSync(path.join(root,'source'),'utf8'),'dirty preserved');assert.equal(fs.readFileSync(path.join(root,'evidence','receipt'),'utf8'),'retained evidence');assert.equal(git('status','--porcelain'),'M source');
 console.log(JSON.stringify({ok:true,fixture:'actual-native-cache-retirement',entries:entries+2,pausedContinuation:paused,fdRefusal:blocked.error.code,retired:result.value.kind,sourceAndEvidencePreserved:true,unpublishedHeadPreserved:true,planAndLifetimeUnchanged:true}));
}finally{if(held){held.kill('SIGKILL');await once(held,'exit');}fs.rmSync(base,{recursive:true,force:true});}
