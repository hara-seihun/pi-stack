import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {retireSourceMaterialization,materializationDigest as digest} from './source-materialization.mjs';
function fixture(){
 const base=fs.mkdtempSync(path.join(tmpdir(),'typed-source-')),root=path.join(base,'parent'),durable=path.join(base,'durable'),state=path.join(base,'state');for(const p of [root,durable,state])fs.mkdirSync(p);
 const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:5000}).trim();
 for(const repo of [root,durable]){git(repo,'init','-b','main');git(repo,'config','user.email','fixture@example.invalid');git(repo,'config','user.name','fixture');fs.writeFileSync(path.join(repo,'keep.ts'),repo===root?'parent':'preserve');git(repo,'add','.');git(repo,'commit','-m','fixture');}
 const source=path.join(root,'.git/source-preparations/historical/source');fs.mkdirSync(source,{recursive:true});fs.copyFileSync(path.join(durable,'keep.ts'),path.join(source,'keep.ts'));fs.writeFileSync(path.join(path.dirname(source),'manifest.json'),'irreplaceable manifest');fs.mkdirSync(path.join(path.dirname(source),'logs'));fs.writeFileSync(path.join(path.dirname(source),'logs/proof'),'retained evidence');
 const pinned=git(durable,'rev-parse','HEAD'),wantedRef='refs/source-preparations/fixture';git(durable,'update-ref',wantedRef,pinned);const id=p=>{const s=fs.statSync(p,{bigint:true});return {device:String(s.dev),inode:String(s.ino)};};
 const proof={summary:{sourceRoot:source,commit:pinned,ref:wantedRef,independentRepository:durable},inventory:[{path:'keep.ts',kind:'file',bytes:8,sha256:digest('preserve'),git:{mode:'100644',oid:git(durable,'rev-parse',pinned+':keep.ts')}}]};
 const file=(name,value)=>{const p=path.join(base,name),b=JSON.stringify(value);fs.writeFileSync(p,b);return {path:p,sha256:digest(b)};};
 const parent={id:'fixture-parent',path:root,owner:'fixture-owner',head:git(root,'rev-parse','HEAD'),...id(root)},container=id(path.dirname(source));
 const r={kind:'retire-source-materialization',operationId:'fixture-operation',parent,source:{path:source,...id(source),containerDevice:container.device,containerInode:container.inode},durable:{repository:durable,commit:pinned,wantedRef},inventory:file('inventory.json',proof),ownerRelease:null,consumerRelease:null};
 const current=file('current-manifest.json',{selected:path.join(root,'.git/source-preparations/NEW/source')});
 const release=kind=>({kind,binding:{parentId:parent.id,owner:parent.owner,sourcePath:source,commit:pinned,wantedRef,inventorySha256:r.inventory.sha256},writers:'none',evidence:'retained authorized owner release',observedAt:Date.now(),manifests:[current]});
 r.ownerRelease=file('owner.json',release('source-materialization-owner-release'));r.consumerRelease=file('consumer.json',release('source-materialization-consumer-release'));
 const db=new DatabaseSync(path.join(state,'journal.sqlite3'));const context={database:db,stateDirectory:state,parentBinding:()=>parent,safety:roots=>({errors:[],references:[],retainedBorrowers:[],observedAt:Date.now()}),invalidate:()=>{}};
 return {base,root,durable,state,source,r,proof,file,db,context,git,current,run:()=>retireSourceMaterialization(context,r),clean:()=>{db.close();fs.rmSync(base,{recursive:true,force:true});}};
}
function protectedBytes(f){return [fs.readFileSync(path.join(f.root,'keep.ts'),'utf8'),fs.readFileSync(path.join(path.dirname(f.source),'manifest.json'),'utf8'),fs.readFileSync(path.join(path.dirname(f.source),'logs/proof'),'utf8'),f.git(f.root,'rev-parse','HEAD'),f.git(f.durable,'rev-parse',f.r.durable.wantedRef)];}

const cli=new URL('./workspace.mjs',import.meta.url).pathname;
function cliFixture(){const f=fixture();
 const env={...process.env,PI_WORKSPACE_STATE:path.join(f.state,'journal.sqlite3')};delete env.NODE_TEST_CONTEXT;delete env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;
 const call=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:45000,env});
 const reg=call(['register','--path',f.root,'--root',f.base,'--owner',f.r.parent.owner,'--source-commit',f.r.parent.head,'--json']);assert.equal(reg.status,0,reg.stderr);const registered=JSON.parse(reg.stdout);f.r.parent.id=registered.id;
 for(const key of ['ownerRelease','consumerRelease']){const v=JSON.parse(fs.readFileSync(f.r[key].path,'utf8'));v.binding.parentId=registered.id;f.r[key]=f.file(key+'.json',v);}
 const req=f.file('request.json',f.r);
 return {...f,call,env,req,registered,args:['retire-source-materialization','--id',registered.id,'--path',f.root,'--owner',registered.owner,'--request',req.path,'--request-sha256',req.sha256,'--json']};}
test('real supported CLI preserves active parent and exact full source; normal route positive then idempotent replay',()=>{const f=cliFixture();try{const before=protectedBytes(f);const result=f.call(f.args);assert.equal(result.status,0,result.stdout+result.stderr);const j=JSON.parse(result.stdout);assert.equal(j.ok,true,JSON.stringify(j));assert.equal(j.value.parentPreserved,true);assert.deepEqual(protectedBytes(f),before);assert.equal(fs.existsSync(f.source),false);const replay=f.call(f.args);assert.equal(replay.status,0,replay.stdout+replay.stderr);assert.equal(JSON.parse(replay.stdout).value.replayed,true);const row=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.registered.id);assert.equal(row.owner,f.registered.owner);assert.equal(row.lease_expires_at,f.registered.leaseExpiresAt);}finally{f.clean();}});
