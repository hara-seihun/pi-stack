import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { patchBrowserBatchTimeout } from './patch-browser-batch-timeout.mjs';
const require=createRequire(import.meta.url);
const nativeRoot=dirname(require.resolve('pi-agent-browser-native/package.json'));
const processTarget='dist/extensions/agent-browser/lib/process.js';
const diagnosticsTarget='dist/extensions/agent-browser/lib/orchestration/browser-run/diagnostics.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'browser-batch-contract-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 cpSync(join(nativeRoot,'dist'),join(root,'dist'),{recursive:true});
 symlinkSync(dirname(nativeRoot),join(root,'node_modules'));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'pi-agent-browser-native',version:'0.6.6',type:'module'}));
 return root;
}
test('timeout outcomes without step receipts stay unknown on args and job routes',async t=>{
 const root=fixture(t);patchBrowserBatchTimeout(root);
 const path=join(root,diagnosticsTarget);
 writeFileSync(path,readFileSync(path,'utf8')+'\nexport { buildTimeoutProgressSteps };\n');
 const {buildTimeoutProgressSteps:build}=await import(pathToFileURL(path));
 const steps=[['fill','#first','alpha'],['wait','7000'],['fill','#second','beta'],['get','url']].map((args,index)=>({args,index:index+1}));
 for(const shape of [steps,steps.map(step=>({...step,generatedFrom:'fill'}))]){
  const result=build({steps:shape,artifacts:[],currentPageSource:'live',currentPageUrl:'http://fixture.test/'});
  assert.deepEqual(result.steps.map(step=>step.status),['unknown','unknown','unknown','unknown']);
  assert.equal(result.retryStep,undefined);
  assert.ok(result.steps.every(step=>!step.retry));
 }
 const explicit=build({steps:[{args:['screenshot','proof.png'],index:1},{args:['fill','#input','value'],index:2}],artifacts:[{stepIndex:1,exists:true}],currentPageSource:'live',currentPageUrl:'http://fixture.test/'});
 assert.deepEqual(explicit.steps.map(step=>step.status),['completed','unknown']);
});
test('patch is idempotent and validates both targets before changing either',t=>{
 const root=fixture(t);patchBrowserBatchTimeout(root);
 const original=readFileSync(join(root,processTarget),'utf8');patchBrowserBatchTimeout(root);
 assert.equal(readFileSync(join(root,processTarget),'utf8'),original);
 const unpatched=fixture(t);const processBefore=readFileSync(join(unpatched,processTarget),'utf8');
 writeFileSync(join(unpatched,diagnosticsTarget),'unknown source');
 assert.throws(()=>patchBrowserBatchTimeout(unpatched),/differs from pinned/);
 assert.equal(readFileSync(join(unpatched,processTarget),'utf8'),processBefore);
});
function running(pid){
 try {return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0]!=='Z';}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
for(const mode of ['timeout','abort'])test(`${mode} stops launcher and CLI but preserves detached daemon`,{skip:process.platform!=='linux'},async t=>{
 const root=fixture(t);patchBrowserBatchTimeout(root);
 const bin=join(root,'bin');mkdirSync(bin);writeFileSync(join(bin,'package.json'),JSON.stringify({type:'commonjs'}));const socket=join(root,'socket');mkdirSync(socket,{mode:0o700});
 const daemon=join(root,'daemon.cjs'),cli=join(root,'cli.cjs');
 writeFileSync(daemon,`require('node:fs').writeFileSync(${JSON.stringify(join(root,'daemon.pid'))},String(process.pid));setInterval(()=>{},1000);`);
 writeFileSync(cli,`require('node:fs').writeFileSync(${JSON.stringify(join(root,'cli.pid'))},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
 writeFileSync(join(bin,'agent-browser'),`#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root,'launcher.pid'))},String(process.pid));spawn(process.execPath,[${JSON.stringify(cli)}],{stdio:'inherit'});const daemon=spawn(process.execPath,[${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'});daemon.unref();setInterval(()=>{},1000);`,{mode:0o755});
 t.after(()=>{try{process.kill(Number(readFileSync(join(root,'daemon.pid'),'utf8')),'SIGKILL');}catch(error){if(!['ESRCH','ENOENT'].includes(error.code))throw error;}});
 const {runAgentBrowserProcess}=await import(pathToFileURL(join(root,processTarget)));
 const controller=new AbortController();const timer=mode==='abort'?setTimeout(()=>controller.abort(),800):undefined;
 const result=await runAgentBrowserProcess({args:['get','url'],cwd:root,env:{PATH:`${bin}:${process.env.PATH}`,AGENT_BROWSER_SOCKET_DIR:socket},timeoutMs:mode==='timeout'?800:3000,signal:controller.signal});
 clearTimeout(timer);
 assert.equal(result.timedOut,mode==='timeout',JSON.stringify(result));assert.equal(result.aborted,mode==='abort',JSON.stringify(result));
 const launcherPid=Number(readFileSync(join(root,'launcher.pid'),'utf8')),cliPid=Number(readFileSync(join(root,'cli.pid'),'utf8')),daemonPid=Number(readFileSync(join(root,'daemon.pid'),'utf8'));
 assert.equal(running(launcherPid),false);assert.equal(running(cliPid),false);assert.equal(running(daemonPid),true);
});
