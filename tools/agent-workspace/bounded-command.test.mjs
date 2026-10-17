import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {boundedCommand} from './bounded-command.mjs';
import {currentStackQueueReferences} from './cache-queue.mjs';

const options={encoding:'utf8',timeout:80,maxBuffer:262144,env:process.env};
test('SIGTERM-ignoring baseline overruns; hard-deadline command returns and ceases',()=>{
 const script="process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setTimeout(()=>process.exit(0),700)";
 let start=Date.now();const baseline=spawnSync(process.execPath,['-e',script],options),old=Date.now()-start;assert.ok(old>=650);assert.equal(baseline.error.code,'ETIMEDOUT');
 start=Date.now();const result=boundedCommand(process.execPath,['-e',script],options),elapsed=Date.now()-start;
 assert.equal(result.error.code,'ETIMEDOUT');assert.ok(elapsed<500,String(elapsed));assert.equal(fs.existsSync('/proc/'+result.stdout),false);
});
test('an inherited grandchild pipe cannot extend timeout or survive owned group cessation',()=>{
 const script="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore','inherit','inherit']});console.log(child.pid);setInterval(()=>{},1000)";
 const start=Date.now(),result=boundedCommand(process.execPath,['-e',script],options);assert.equal(result.error.code,'ETIMEDOUT');assert.ok(Date.now()-start<500);
 const child=Number(result.stdout.trim());assert.ok(child>0);
 try{assert.match(fs.readFileSync('/proc/'+child+'/stat','utf8'),/\) [ZX] /);}catch(error){if(error.code!=='ENOENT')throw error;}
});
test('bounded success and output failure stay distinct',()=>{
 const success=boundedCommand(process.execPath,['-e',"console.log('[]')"],{...options,timeout:1000});assert.equal(success.status,0);assert.equal(success.stdout.trim(),'[]');
 const tooLarge=boundedCommand(process.execPath,['-e',"console.log('0123456789')"],{...options,timeout:1000,maxBuffer:4});assert.equal(tooLarge.error.code,'COMMAND_OUTPUT_LIMIT');
});
test('all queue domains share one absolute deadline and a late success cannot become a verdict',()=>{
 const read=p=>p.endsWith('host.json')?{hostId:'host',installationId:'one'}:p.endsWith('registry.json')?{installationId:'one',domains:[{id:'hara',hostId:'host',unixUser:'pi2-hara'},{id:'converge',hostId:'host',unixUser:'pi2-converge'}]}:{domainId:p.includes('converge')?'converge':'hara',database:'stack'};
 let calls=0;const deadline=Date.now()+40;
 const result=currentStackQueueReferences(['/source'],{resourceKind:'physical-checkout',deadline,read,execute:(_name,args,options)=>{calls++;assert.ok(options.timeout<=40);assert.match(args.at(-1),/statement_timeout='4000ms'/);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);return {status:0,stdout:'[]'};}});
 assert.equal(calls,1);assert.equal(result.errors.length,1);assert.equal(result.references.length,0);
});
