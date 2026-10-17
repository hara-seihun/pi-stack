import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const modulePath=process.env.CAPACITY_DIAGNOSTIC_MODULE ?? fileURLToPath(new URL('./workspace.mjs',import.meta.url));
const {workspaceTesting:w}=await import(pathToFileURL(modulePath));
const G=1024**3;
test('priced refusal explains one observation including import, shared floor and every reservation without changing requirement',()=>{
 const plan={intent:'source-only',constructionBytes:42197560,growthBytes:2097152,headroomBytes:8*G,sourceImportBytes:0,sourceCommit:'a'.repeat(40),checkoutPricingVersion:4,checkoutAllocation:{totalBytes:42197560}};
 const r={priced:[200,300],headroomBytes:10*G,unpricedDormant:2,measurementFailures:[{path:'/unavailable',error:'stale',reservedBytes:300}]};
 const before=JSON.stringify({plan,r});
 const d=w.capacityRefusalDetails(plan,r);
 assert.equal(d.requiredBytes,w.capacityRequirement(plan,r.priced,r.headroomBytes));
 assert.equal(d.constructionBytes,42197560);assert.equal(d.growthBytes,2097152);
 assert.equal(d.requestedHeadroomBytes,8*G);assert.equal(d.sharedHeadroomBytes,10*G);assert.equal(d.effectiveHeadroomBytes,10*G);
 assert.equal(d.otherReservationsBytes,500);assert.deepEqual(d.otherReservationBytes,[200,300]);
 assert.equal(d.requiredBytes,d.constructionBytes+d.growthBytes+d.effectiveHeadroomBytes+d.otherReservationsBytes);
 assert.deepEqual(d.sourceImport,{state:'set',bytes:0});assert.deepEqual(d.sourceForecast,{state:'set',plan});
 assert.deepEqual(d.measurementFailures,r.measurementFailures);assert.equal(d.unpricedDormant,2);assert.equal(JSON.stringify({plan,r}),before);
 const imported={...plan,constructionBytes:42197560+7654321,sourceImportBytes:7654321};
 assert.equal(w.capacityRefusalDetails(imported,r).requiredBytes,d.requiredBytes+7654321);
 assert.deepEqual(w.capacityRefusalDetails(imported,r).sourceImport,{state:'set',bytes:7654321});
});
test('unestimated capacity is headroom not invented source import, legacy absence stays explicit',()=>{
 const r={priced:[100],headroomBytes:8*G,unpricedDormant:0};
 const p={intent:'unestimated',constructionBytes:30*G,headroomBytes:0,growthBytes:0};
 const d=w.capacityRefusalDetails(p,r);
 assert.equal(d.requiredBytes,30*G+100);assert.equal(d.constructionBytes,0);assert.equal(d.effectiveHeadroomBytes,30*G);
 assert.deepEqual(d.sourceImport,{state:'unset'});assert.deepEqual(d.sourceForecast,{state:'unset'});
 assert.throws(()=>w.capacityRefusalDetails({...p,growthBytes:-1},r));
});
test('real guarded create retains exact forecast and complete refusal through child wrapper without checkout/admission',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'capacity-diagnostic-'));const repo=path.join(root,'repo'),pool=path.join(root,'pool'),state=path.join(root,'state','registry.sqlite3');
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 try{
 mkdirSync(repo);mkdirSync(pool);git('init','-q','-b','main',repo);git('-C',repo,'config','user.name','Fixture');git('-C',repo,'config','user.email','fixture@example.invalid');writeFileSync(path.join(repo,'one.txt'),'exact');git('-C',repo,'add','.');git('-C',repo,'commit','-qm','fixture');const head=git('-C',repo,'rev-parse','HEAD');
 const result=spawnSync(process.execPath,[modulePath,'create','--root',pool,'--name','refused','--repo',repo,'--ref',head,'--owner','fixture','--mode','writer','--intent','source-only','--headroom-gib','1000000','--growth-mib','2','--sparse-pattern','/one.txt','--json'],{encoding:'utf8',timeout:15000,env:{...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_CREATE_CHILD:''}});
 assert.equal(result.status,2,result.stderr);assert.equal(existsSync(path.join(pool,'refused')),false);
 const dir=path.join(root,'state','source-preparations');const files=readdirSync(dir).filter(f=>f.endsWith('.forecast.json'));assert.equal(files.length,1);
 const f=JSON.parse(readFileSync(path.join(dir,files[0]),'utf8'));const c=f.refusal.capacity;
 assert.equal(f.refusal.code,'workspace-capacity-refused');assert.equal(c.breakdown.requiredBytes,c.requiredBytes);
 assert.equal(c.breakdown.growthBytes,2097152);assert.equal(c.breakdown.effectiveHeadroomBytes,1000000*G);
 assert.equal(c.breakdown.otherReservationsBytes,0);assert.deepEqual(c.breakdown.sourceForecast,{state:'set',plan:f.plan});
 assert.equal(c.breakdown.sourceImport.bytes,f.plan.sourceImportBytes);assert.ok(c.requiredBytes>c.freeBytes);
 const line=result.stderr.split('\n').find(x=>x.startsWith('capacity-detail: '));assert.ok(line,result.stderr);
 assert.deepEqual(JSON.parse(line.slice('capacity-detail: '.length)),c);
 assert.equal(git('-C',repo,'rev-parse','HEAD'),head);
 }finally{rmSync(root,{recursive:true,force:true});}
});
