import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ActionStore } from "kenan-memory/actions";
import type { PiSessionOptions } from "../src/threads/contracts.js";

// Overrides exercise the exact frozen/installed consumer; no candidate files are changed.
const orchestrator=process.env.PI_PURPOSE_PROBE_ORCHESTRATOR;
const remote=process.env.PI_PURPOSE_PROBE_REMOTE;
const { threadTools }=await import(orchestrator ? pathToFileURL(join(orchestrator,"threads/pi-tools.js")).href : "../src/threads/pi-tools.ts");
const { PiExecution }=await import(orchestrator ? pathToFileURL(join(orchestrator,"threads/pi-execution.js")).href : "../src/threads/pi-execution.ts");
const { callerResolver, threadCapability }=await import(orchestrator ? pathToFileURL(join(orchestrator,"threads/caller.js")).href : "../src/threads/caller.ts");
const { externalActionsEndpoint, externalActionCaller }=await import(remote ? pathToFileURL(join(remote,"server/external-actions.ts")).href : "../../../apps/remote/server/external-actions.ts");
const roots:string[]=[], stores:ActionStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const manager="synthetic-manager", evidence={kind:"provider-receipt",reference:"synthetic-provider:confirmed",detail:"Synthetic delivery confirmed"} as const;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"manager-purpose-"));roots.push(root);
 const actions=new ActionStore(join(root,"actions"),"synthetic-owner");stores.push(actions);
 const capability=threadCapability(join(root,"capability"));
 const resolver=callerResolver({capability,peer:()=>({kind:"process",uid:1234})});
 const options:PiSessionOptions={threadId:manager,cwd:root,sessionFile:join(root,"unused.jsonl"),args:[],env:{PI_THREAD_ROLE:"kenaznia",PI_THREAD_MANAGER:"1",PI_THREAD_TOKEN:capability.issue(manager),PI_REMOTE_SERVER_URL:"http://127.0.0.1:19999"}};
 const tool=(value=options)=>threadTools(value).find((t:any)=>t.name==="external_action_resolve_purpose")!;
 const create=(state:"succeeded"|"uncertain"|"inflight"="succeeded")=>{
   const submitted=actions.submit({intentKey:`synthetic-${state}`,recipients:[`synthetic-${state}`],transport:"synthetic",payload:{privateSyntheticPayload:"excluded"},requestId:state,threadId:manager,authenticatedThreadId:manager});
   if(!submitted.ok)throw Error(submitted.message);
   const claimed=actions.claim(submitted.value.action.id,"synthetic-transport");if(!claimed.ok)throw Error(claimed.message);
   expect(actions.dispatch(claimed.value).ok).toBe(true);
   if(state==="inflight") {const read=actions.inspect(claimed.value.id);if(!read.ok)throw Error(read.message);return read.value;}
   const finished=actions.finish(claimed.value,state,{synthetic:true},evidence);if(!finished.ok)throw Error(finished.message);return finished.value;
 };
 const calls:any[]=[];
 const route=()=>spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(url:any,init:any)=>{
   expect(String(url)).toBe("http://127.0.0.1:19999/v1/external-actions");
   const request=new Request(String(url),init), body=await request.clone().json();calls.push({body,headers:Object.fromEntries(request.headers)});
   const caller=externalActionCaller(resolver.resolve({headers:request.headers}),1234,manager,false);
   return externalActionsEndpoint(request,actions,caller);
 }, { preconnect: globalThis.fetch.preconnect }));
 return {root,actions,options,tool,create,calls,route};
}
async function execute(tool:any,input:unknown){return tool.execute("synthetic-call",input,new AbortController().signal);}

test("manager's actual registered tool resolves exact succeeded purpose through authenticated existing route",async()=>{
 const f=fixture(), action=f.create();
 const held=f.actions.reconcile(action.id,action.revision,"hold",{kind:"operator-observation",reference:"synthetic-stop",detail:"Preserve recipient hold"},"synthetic-operator");if(!held.ok)throw Error(held.message);
 const fetch=f.route();
 try {
   const result=await execute(f.tool(),{id:action.id,expectedRevision:held.value.revision,evidence});
   expect(result.details).toEqual({ok:true,value:{id:action.id,revision:held.value.revision+1,state:"succeeded",resolved:true}});
   expect(result.isError).toBe(false);expect(JSON.stringify(result)).not.toContain("privateSyntheticPayload");
   expect(f.calls).toHaveLength(1);
   expect(f.calls[0].body).toEqual({operation:"reconcile",input:{id:action.id,expectedRevision:held.value.revision,decision:"resolve-purpose",evidence,actor:manager}});
   expect(f.calls[0].headers["x-pi-thread-token"]).toBe(f.options.env.PI_THREAD_TOKEN);
   expect(f.actions.db.query("SELECT actor FROM external_action_events WHERE event='resolve-purpose'").get()).toEqual({actor:manager});
   expect(f.actions.db.query("SELECT reason FROM external_contact_holds").get()).toEqual({reason:"Preserve recipient hold"});
   expect(f.actions.db.query("SELECT COUNT(*) AS count FROM external_action_dispatches").get()).toEqual({count:1});
 } finally {fetch.mockRestore();}
});

test("purpose tool is manager-only and rejects operation, actor, identity, revision and evidence overrides before transport",async()=>{
 const f=fixture(), action=f.create(), input={id:action.id,expectedRevision:action.revision,evidence};
 for(const role of ["kena","kenatia"])expect(f.tool({...f.options,env:{...f.options.env,PI_THREAD_ROLE:role}})).toBeUndefined();
 const fetch=f.route();try {
  for(const extra of [{actor:"forged"},{decision:"hold"},{operation:"retry"},{threadId:"another"},{expectedRevision:-1},{evidence:{...evidence,reference:" "}}]){
    const result=await execute(f.tool(),{...input,...extra});expect(result.isError).toBe(true);expect(result.details.error).toBe("invalid-input");
  }
  expect(f.calls).toEqual([]);expect(f.actions.inspect(action.id)).toMatchObject({ok:true,value:{resolved:false,revision:action.revision}});
 }finally{fetch.mockRestore();}
});

test("missing or invalid context never falls back to operator identity and transport uncertainty never retries",async()=>{
 const f=fixture(), action=f.create(), input={id:action.id,expectedRevision:action.revision,evidence};
 const fetch=f.route();try{
  for(const env of [{PI_THREAD_TOKEN:undefined},{PI_REMOTE_SERVER_URL:undefined},{PI_REMOTE_SERVER_URL:"http://other-owner.invalid"}]){
   const result=await execute(f.tool({...f.options,env:{...f.options.env,...env}}),input);expect(result.details.error).toBe("unavailable");
  }
  expect(f.calls).toHaveLength(0);
 }finally{fetch.mockRestore();}
 const unavailable=spyOn(globalThis,"fetch").mockRejectedValue(Error("synthetic lost acknowledgement"));
 try{expect((await execute(f.tool(),input)).details.error).toBe("unavailable");expect(unavailable).toHaveBeenCalledTimes(1);}finally{unavailable.mockRestore();}
});

test("retained SDK registration refreshes the original session and exact execution admission without replacement",async()=>{
 const sdk=process.env.PI_PURPOSE_PROBE_SDK;
 const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager}=await import(sdk ? pathToFileURL(join(resolve(sdk),"dist/index.js")).href : "@earendil-works/pi-coding-agent");
 const f=fixture(), action=f.create(), settings=SettingsManager.inMemory(), history=SessionManager.inMemory(f.root);
 let api:any;
 const loader=new DefaultResourceLoader({cwd:f.root,agentDir:join(f.root,"empty-agent"),settingsManager:settings,
  noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  extensionFactories:[(value:any)=>{api=value;value.registerTool({name:"synthetic_existing",label:"Existing",description:"Synthetic existing tool",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{existing:true}})});}],
  systemPromptOverride:()=>"Synthetic manager; no provider request"});
 await loader.reload();
 const {session}=await createAgentSession({cwd:f.root,agentDir:join(f.root,"empty-agent"),settingsManager:settings,sessionManager:history,resourceLoader:loader,noTools:"builtin"});
 const fetch=f.route();try{
  const identity={session,agent:session.agent,history:session.sessionManager,runner:(session as any)._extensionRunner,env:f.options.env,token:f.options.env.PI_THREAD_TOKEN};
  const entries=history.getEntries(), names=session.getActiveToolNames();expect(names).toEqual(["synthetic_existing"]);
  const execution=new PiExecution(), priorAdmission=(name:string)=>name==="synthetic_existing";
  execution.setToolAdmission(priorAdmission);
  const definition=f.tool();api.registerTool(definition);
  expect(session.getToolDefinition(definition.name)).toBe(definition);
  expect(session.getActiveToolNames()).toEqual([...names,definition.name]);
  const registered=session.agent.state.tools.find((tool:any)=>tool.name===definition.name)!;
  const input={id:action.id,expectedRevision:action.revision,evidence}, signal=new AbortController().signal;
  await expect((execution as any).executeRaw(registered,"synthetic-denied",input,signal,()=>{})).rejects.toThrow("outside this thread role");
  expect(f.calls).toHaveLength(0);
  execution.setToolAdmission((name:string)=>name===definition.name||priorAdmission(name));
  const result=await (execution as any).executeRaw(registered,"synthetic-adopted",input,signal,()=>{});
  expect(result.details).toMatchObject({ok:true,value:{id:action.id,resolved:true}});expect(f.calls).toHaveLength(1);
  await expect((execution as any).executeRaw({...registered,name:"bash"},"synthetic-still-denied",input,signal,()=>{})).rejects.toThrow("outside this thread role");
  const after={session,agent:session.agent,history:session.sessionManager,runner:(session as any)._extensionRunner,env:f.options.env,token:f.options.env.PI_THREAD_TOKEN};
  for(const key of Object.keys(identity) as Array<keyof typeof identity>)expect(after[key]).toBe(identity[key]);
  expect(history.getEntries()).toEqual(entries);expect(session.getActiveToolNames()).not.toContain("bash");
 }finally{fetch.mockRestore();session.dispose();}
});

test("server refuses forged capability, stale revision and active/uncertain purposes without changing custody",async()=>{
 const f=fixture(), action=f.create(), fetch=f.route();try{
  const before=f.actions.list();
  const forged=f.tool({...f.options,env:{...f.options.env,PI_THREAD_TOKEN:"forged-manager-text"}});
  expect((await execute(forged,{id:action.id,expectedRevision:action.revision,evidence})).isError).toBe(true);
  expect((await execute(f.tool(),{id:action.id,expectedRevision:action.revision-1,evidence})).details.error).toBe("fenced");
  expect(f.actions.list()).toEqual(before);
  for(const state of ["uncertain","inflight"] as const){const current=f.create(state), prior=f.actions.inspect(current.id);
   expect((await execute(f.tool(),{id:current.id,expectedRevision:current.revision,evidence})).details.error).toBe("fenced");expect(f.actions.inspect(current.id)).toEqual(prior);}
  expect(f.calls.every(call=>call.body.operation==="reconcile"&&call.body.input.decision==="resolve-purpose")).toBe(true);
 }finally{fetch.mockRestore();}
});
