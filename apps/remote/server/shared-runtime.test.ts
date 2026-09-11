import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {startRuntimeHost, attachRuntimeHost, type RuntimeTransport} from "./runtime-transport";
import {AsyncLocalStorage} from "node:async_hooks";
import {sessionEnvironment} from "./session-environment";

const roots:string[]=[];
const transports:RuntimeTransport[]=[];
afterEach(async()=>{
  await Promise.all(transports.splice(0).map(t=>t.terminate()));
  roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));
});
function fixture(max=8){
  const data=mkdtempSync(join(tmpdir(),"pi-shared-"));roots.push(data);
  const factory=join(data,"factory.mjs");
  writeFileSync(factory,`export async function openSession(options,output,exit){
    const scope=globalThis[Symbol.for('pi-stack.session-environment')];
    const env=scope.getStore();
    return {async command(value){await new Promise(r=>setTimeout(r,value.delay||0));
      output({id:value.id,type:'response',command:value.type,success:true,data:{thread:env.PI_REMOTE_SESSION_ID,active:scope.getStore().PI_REMOTE_SESSION_ID}});
    },async close(){exit(0);}};
  }`);
  return {data,cwd:data,args:["pi","--mode","rpc"],env:{...process.env,PI_REMOTE_SESSION_FACTORY:pathToFileURL(factory).href,PI_REMOTE_MAX_ACTIVE_RUNTIMES:String(max)}};
}
async function waitFor(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await Bun.sleep(20);}throw new Error("event timeout");}

test("concurrent sessions share one PID but not identity, events, or lifetime",async()=>{
  const options=fixture(),outputs:string[][]=[[],[],[]];
  const values=await Promise.all(outputs.map((out,i)=>startRuntimeHost({...options,sessionId:String(i),env:{...options.env,PI_REMOTE_SESSION_ID:String(i)},onOutput:line=>out.push(line)})));
  transports.push(...values);
  expect(new Set(values.map(t=>t.pid)).size).toBe(1);
  values.forEach((t,i)=>t.send({id:String(i),type:"get_state",delay:(3-i)*10}));
  await waitFor(()=>outputs.every(out=>out.length===1));
  outputs.forEach((out,i)=>expect(JSON.parse(out[0]!).data).toEqual({thread:String(i),active:String(i)}));
  await values[0]!.terminate();
  values[1]!.send({id:"still-running",type:"get_state"});
  await waitFor(()=>outputs[1]!.length===2);
  expect(JSON.parse(outputs[1]![1]!).data.thread).toBe("1");
});

test("runner rejects excess residency and admits again after one session closes",async()=>{
  const options=fixture(1);
  const first=await startRuntimeHost({...options,sessionId:"first",onOutput(){}});transports.push(first);
  await expect(startRuntimeHost({...options,sessionId:"second",onOutput(){}})).rejects.toThrow("Runner capacity busy");
  await first.terminate();
  const second=await startRuntimeHost({...options,sessionId:"second",onOutput(){}});transports.push(second);
  expect(second.pid).toBe(first.pid);
});

test("coordinator reserve admits priority work after leaf residency fills",async()=>{
  const options=fixture(6);
  for (const sessionId of ["leaf1","leaf2"]) transports.push(await startRuntimeHost({...options,sessionId,onOutput(){}}));
  await expect(startRuntimeHost({...options,sessionId:"leaf3",onOutput(){}})).rejects.toThrow("Runner capacity busy");
  const coordinator=await startRuntimeHost({...options,sessionId:"coordinator",priority:true,onOutput(){}});transports.push(coordinator);
  expect(coordinator.pid).toBe(transports[0]!.pid);
});

test("repeated open rejoins the same session without consuming another slot",async()=>{
  const options=fixture(1);
  const first=await startRuntimeHost({...options,sessionId:"stable",onOutput(){}});
  first.detach();
  const resumed=await startRuntimeHost({...options,sessionId:"stable",onOutput(){}});transports.push(resumed);
  expect(resumed.socketPath).toBe(first.socketPath);
  expect(resumed.pid).toBe(first.pid);
});

test("shared sessions fit Linux sockets under production-length encrypted data paths",async()=>{
  const options=fixture();
  options.data=join(options.data,"hara",".pi-remote");mkdirSync(options.data,{recursive:true});
  const host=await startRuntimeHost({...options,sessionId:crypto.randomUUID(),onOutput(){}});transports.push(host);
  expect(Buffer.byteLength(host.socketPath)).toBeLessThan(108);
  expect(host.shared).toBe(true);
});

test("session output survives supervisor detach and can be acknowledged repeatedly",async()=>{
  const options=fixture();const output:string[]=[];
  const first=await startRuntimeHost({...options,sessionId:"replay",env:{...options.env,PI_REMOTE_SESSION_ID:"replay"},onOutput:line=>output.push(line)});
  first.send({id:"before",type:"get_state"});await waitFor(()=>output.length===1);
  first.send({id:"detached",type:"get_state",delay:100});first.detach();
  await Bun.sleep(150);
  const replay:string[]=[];
  const next=await attachRuntimeHost(first.socketPath,line=>replay.push(line));transports.push(next);
  await waitFor(()=>replay.length===1);
  expect(JSON.parse(replay[0]!).id).toBe("detached");
  next.send({id:"after",type:"get_state"});await waitFor(()=>replay.length===2);
  expect(JSON.parse(replay[1]!).id).toBe("after");
});

test("environment scopes preserve nested and concurrent identities without changing process.env",async()=>{
  const key=Symbol.for("pi-stack.session-environment"),target=globalThis as any;
  const previous=target[key];target[key]=new AsyncLocalStorage();
  try{
    const values=await Promise.all(["parent","child"].map(PI_REMOTE_SESSION_ID=>target[key].run({PI_REMOTE_SESSION_ID},async()=>{await Bun.sleep(10);return sessionEnvironment().PI_REMOTE_SESSION_ID;})));
    expect(values).toEqual(["parent","child"]);
    expect(sessionEnvironment()).toBe(process.env);
  }finally{target[key]=previous;}
});
