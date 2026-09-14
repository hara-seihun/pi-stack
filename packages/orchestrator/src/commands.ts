import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { Store } from "./store.js";
import { readUsageEvidence } from "./usage-evidence.js";
import { randomUUID } from "node:crypto";
import { createThreadClient } from "./threads/http.js";
import type { Delivery, Result, SettingsOverrides, SpawnThread, Thread, ThreadState } from "./threads/contracts.js";
import { providerOAuth, transactSharedCredential } from "./auth/shared-oauth.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { AccountTransfer, transferEndpoint, transferPeer } from "./auth/account-transfer.js";
import { isAccountReservation } from "./admission-reservation.js";

export const COMMANDS=[
  ["daemon","Run reconciliation and the local API"],
  ["status","Print accounts, lanes, leases, and active threads"],
  ["usage-evidence","Print a read-only 24-hour quota and token snapshot; optional --ledger FILE"],
  ["run","Spawn fresh threads with --prompt TEXT [--model MODEL] [--count N] [--background]"],
  ["wave","Spawn a one-off batch from a declared lane [--count N] [--background]"],
  ["list","List threads [--parent ID] [--state STATE] [--limit N] [--cursor CURSOR]"],
  ["read","Read a thread's native history: THREAD_ID [--limit N] [--cursor CURSOR]"],
  ["send","Send to THREAD_ID with --prompt TEXT [--delivery queue|steer|hardSteer]"],
  ["stop","Stop THREAD_ID; --descendants also stops its descendants"],
  ["pause / resume","Set or clear the global launch halt; --ordinary controls only ordinary work"],
  ["resume THREAD_ID","Release a stopped thread's pending messages"],
  ["boost","Set a provider pacing multiplier or halt"],
  ["account","Import, refresh, remove, list, reserve, or exclusively transfer pooled accounts"],
] as const;
export const USAGE=`usage: pi-orchestrator ${COMMANDS.map(([name])=>name.replace(" / ","|")).join("|")}`;
export const ACCOUNT_USAGE=`usage: pi-orchestrator account list | import ID --provider openai-codex|anthropic --credential-file FILE [--label LABEL] [--concurrency N] | refresh ID | disable ID | enable ID | remove ID | use ID shared|voice | transfer ID --to SSH_HOST | transfer-status ID | reserve ID --metadata JSON --reason TEXT | unreserve ID | reservation ID`;

const BASE=`http://${process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1"}:${process.env.PI_ORCHESTRATOR_PORT??"2460"}`;
const ledgerPath=()=>process.env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");
function flags(args:string[]):{named:Map<string,string>;positional:string[]}{const named=new Map<string,string>(),positional:string[]=[];for(let i=0;i<args.length;i++){const value=args[i]!;if(!value.startsWith("--")){positional.push(value);continue;}const [name,inline]=value.slice(2).split("=",2);if(inline!==undefined)named.set(name!,inline);else if(["force","background","descendants"].includes(name!))named.set(name!,"true");else if(args[i+1]&&!args[i+1]!.startsWith("--"))named.set(name!,args[++i]!);else named.set(name!,"true");}return{named,positional};}
function required(named:Map<string,string>,key:string):string{const value=named.get(key);if(!value)throw new Error(`--${key} is required`);return value;}
async function request(path:string,method="GET",value?:unknown):Promise<any>{const response=await fetch(`${BASE}${path}`,{method,headers:{"content-type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)});const body=await response.json();if(!response.ok)throw new Error(body.error??`orchestrator returned ${response.status}`);return body;}
function output(value:unknown):void{console.log(JSON.stringify(value,null,2));}
function threadOutput<T>(result:Result<T>):void{output(result);if(!result.ok)process.exitCode=1;}
function switchEnabled(named:Map<string,string>,key:string):boolean{
  const value=named.get(key);
  if(value!==undefined&&value!=="true"&&value!=="false")throw new Error(`--${key} must be true or false`);
  return value==="true";
}
function positiveInteger(value:string,name:string):number{
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<1)throw new Error(`${name} must be a positive integer`);
  return number;
}
function threadSettings(named:Map<string,string>):SettingsOverrides|undefined{
  const model=named.get("model"),thinkingLevel=named.get("thinking"),speed=named.get("speed");
  if(thinkingLevel&&!['off','minimal','low','medium','high','xhigh','max'].includes(thinkingLevel))throw new Error("Invalid --thinking level");
  if(speed&&speed!=="standard"&&speed!=="priority")throw new Error("--speed must be standard or priority");
  if(!model&&!thinkingLevel&&!speed)return undefined;
  return{...(model?{model}:{}),...(thinkingLevel?{thinkingLevel:thinkingLevel as SettingsOverrides["thinkingLevel"]}:{}),...(speed?{speed:speed as SettingsOverrides["speed"]}:{})};
}
async function spawnThreads(input:Omit<SpawnThread,"requestId">,count:number):Promise<void>{
  const api=createThreadClient(`${BASE}/v1/threads`),threads:Thread[]=[];
  for(let index=0;index<count;index++){
    const result=await api.spawn({...input,requestId:randomUUID()});
    if(!result.ok){output({...result,threads});process.exitCode=1;return;}
    threads.push(result.value);
  }
  output({ok:true,value:{threads}});
}
export async function dispatch(argv:string[]):Promise<void>{
  const [command,...rest]=argv;
  if(command===undefined||command==="help"||command==="--help"){
    console.log(USAGE);
    return;
  }
  if(command==="daemon"){const store=Store.open(ledgerPath());try{await new Daemon(store,loadConfig()).start();}finally{store.close();}return;}
  if(command==="usage-evidence"){
    if(rest.length!==0&&(rest.length!==2||rest[0]!=="--ledger")){
      console.error("usage: pi-orchestrator usage-evidence [--ledger FILE]");process.exitCode=1;return;
    }
    const result=readUsageEvidence(rest[1]??ledgerPath());
    if(result.ok)output(result.value);else{console.error(result.error);process.exitCode=1;}
    return;
  }
  if(command==="status"){output(await request("/v1/status"));return;}
  if(command==="pause"||(command==="resume"&&(rest.length===0||rest[0]==="--ordinary"))){
    if(rest.length>1||(rest.length===1&&rest[0]!=="--ordinary"))throw new Error(`${command} accepts only --ordinary`);
    output(await request("/v1/control","POST",{key:rest[0]==="--ordinary"?"ordinary-launches":"launches",value:command==="pause"?"paused":"enabled"}));return;
  }
  if(command==="stop"||command==="resume"){
    const {named,positional}=flags(rest),threadId=positional[0];
    if(!threadId)throw new Error(`${command} requires a thread id`);
    if(positional.length!==1||[...named.keys()].some(key=>command!=="stop"||key!=="descendants"))throw new Error(`${command} accepts one thread id${command==="stop"?" and --descendants":""}`);
    threadOutput(await createThreadClient(`${BASE}/v1/threads`).control(command==="stop"?{threadId,action:"stop",descendants:switchEnabled(named,"descendants")}:{threadId,action:"resume"}));return;
  }
  if(command==="run"||command==="wave"){
    const {named,positional}=flags(rest),count=positiveInteger(named.get("count")??"1","--count");
    if(named.has("core"))throw new Error("--core is not supported");
    if(named.has("profile"))throw new Error("Use --model instead of --profile");
    const force=switchEnabled(named,"force"),background=switchEnabled(named,"background");
    if(force&&background)throw new Error("Choose --force or --background");
    const settings=threadSettings(named),admission=background?"background":"force";
    if(command==="run"){
      const message=named.get("prompt")??positional.join(" ");
      if(!message.trim())throw new Error("run requires --prompt");
      await spawnThreads({message,cwd:named.get("cwd")??process.cwd(),title:named.get("title"),parentId:named.get("parent"),settings,admission},count);
    }else{
      const id=named.get("lane")??positional[0];if(!id)throw new Error("wave requires a lane");
      output(await request("/v1/wave","POST",{lane:id,count,settings,...(force||background?{admission}:{})}));
    }
    return;
  }
  if(command==="list"){
    const {named,positional}=flags(rest);
    if(positional.length)throw new Error("list accepts named options only");
    const state=named.get("state");
    if(state&&!['idle','queued','starting','running','stopping','stopped','interrupted'].includes(state))throw new Error("Invalid --state");
    threadOutput(await createThreadClient(`${BASE}/v1/threads`).list({parentId:named.get("parent"),state:state as ThreadState|undefined,limit:named.has("limit")?positiveInteger(named.get("limit")!,"--limit"):undefined,cursor:named.get("cursor")}));return;
  }
  if(command==="read"){
    const {named,positional}=flags(rest),threadId=positional[0];
    if(!threadId||positional.length!==1)throw new Error("read requires one thread id");
    threadOutput(await createThreadClient(`${BASE}/v1/threads`).read({threadId,cursor:named.get("cursor"),limit:named.has("limit")?positiveInteger(named.get("limit")!,"--limit"):undefined}));return;
  }
  if(command==="send"){
    const {named,positional}=flags(rest),threadId=positional[0],text=named.get("prompt")??positional.slice(1).join(" "),delivery=named.get("delivery")??"queue";
    if(!threadId||!text.trim())throw new Error("send requires a thread id and --prompt");
    if(!['queue','steer','hardSteer'].includes(delivery))throw new Error("--delivery must be queue, steer, or hardSteer");
    threadOutput(await createThreadClient(`${BASE}/v1/threads`).send({requestId:randomUUID(),threadId,text,delivery:delivery as Delivery}));return;
  }
  if(command==="boost"){const {named,positional}=flags(rest),provider=positional[0],value=positional[1]??named.get("multiplier");if(!provider||value===undefined)throw new Error("boost requires provider and multiplier");output(await request("/v1/control","POST",{key:`boost:${provider}`,value:String(value)}));return;}
  if(command==="account"){
    const [action,...tail]=rest;
    if(action===undefined||action==="help"||action==="--help"){
      console.log(ACCOUNT_USAGE);
      return;
    }
    if(action==="list"){output((await request("/v1/plans")).accounts);return;}
    if(action==="transfer-receive"){
      const store=Store.open(ledgerPath());
      try {
        const owner=new AccountTransfer(store,loadConfig().authPath,transferEndpoint(ledgerPath())),signal=AbortSignal.timeout(30_000);
        let input:any;try{let text="";for await(const chunk of process.stdin)text+=chunk.toString();input=JSON.parse(text);}catch{throw new Error("Invalid transfer input");}
        if(tail[0]==="inspect")output(await owner.inspect(input.alias,signal));
        else if(tail[0]==="receive")output(await owner.receive(input,signal));
        else throw new Error("Transfer receiver requires inspect or receive");
      }catch(error){output({error:error instanceof Error?error.message:"Transfer receiver failed"});}
      finally{store.close();}
      return;
    }
    const {named,positional}=flags(tail),id=named.get("id")??positional[0];if(!id)throw new Error(`account ${action} requires an id`);
    if(action==="reserve"||action==="unreserve"||action==="reservation"){
      const path=`/v1/accounts/${encodeURIComponent(id)}/reservation`;
      if(action==="reservation")output(await request(path));
      else if(action==="unreserve")output(await request(path,"DELETE"));
      else {
        let metadata:unknown;
        try{metadata=JSON.parse(required(named,"metadata"));}catch{throw new Error("--metadata must be a JSON object");}
        const reservation={metadata,reason:required(named,"reason")};
        if(!isAccountReservation(reservation))throw new Error("--metadata must be a nonempty object of string values and --reason must be nonempty");
        output(await request(path,"PUT",reservation));
      }
      return;
    }
    if(action==="transfer"||action==="transfer-status"){
      const store=Store.open(ledgerPath());
      try {
        const owner=new AccountTransfer(store,loadConfig().authPath,transferEndpoint(ledgerPath())),signal=AbortSignal.timeout(45_000);
        if(action==="transfer-status"){
          const record=store.control(`account-transfer:${id}`);
          output({id,transfer:record?JSON.parse(record):null,enabled:store.account(id)?.enabled,activeLeases:store.activeLeases(id).map(lease=>lease.id)});return;
        }
        const target=required(named,"to"),existing=await owner.outgoing(id,signal);
        if(existing){
          const configured=store.control(`account-transfer-target:${id}`);
          if(configured!==target)throw new Error("Transfer destination differs from its recorded SSH host");
          if("type" in existing){output(existing);return;}
        }
        const destination=existing?.destination??await transferPeer(target,"inspect",{alias:id},signal);
        store.setControl(`account-transfer-target:${id}`,target);
        const prepared=existing??await owner.prepare(id,destination,signal);
        if("type" in prepared){output(prepared);return;}
        const accepted=await transferPeer(target,"receive",prepared,signal);
        output(await owner.finish(id,accepted,signal));
      }finally{store.close();}
      return;
    }
    if(action==="use"){const use=positional[1];if(use!=="shared"&&use!=="voice")throw new Error("account use requires shared or voice");output(await request(`/v1/accounts/${encodeURIComponent(id)}/use`,"PUT",{use}));return;}
    // Suspends or restores an account without touching its credential, for a
    // subscription that lapsed or a login that has to be replaced. Nothing
    // new is admitted on a disabled account, and its meters stop being
    // polled; admitted workers keep their leases as usual.
    if(action==="disable"||action==="enable"){output(await request(`/v1/accounts/${encodeURIComponent(id)}/enabled`,"PUT",{enabled:action==="enable"}));return;}
    const config=loadConfig();
    if(action==="import"){const provider=named.get("provider")??positional[1];if(provider!=="openai-codex"&&provider!=="anthropic")throw new Error("--provider must be openai-codex or anthropic");const credentialFile=required(named,"credential-file"),credential=JSON.parse(readFileSync(credentialFile,"utf8"));output(await transactSharedCredential(config.authPath,id,credential,()=>request("/v1/accounts","POST",{id,provider,label:named.get("label"),concurrency:Number(named.get("concurrency")??config.defaultAccountConcurrency)})));return;}
    if(action==="remove"){output(await transactSharedCredential(config.authPath,id,undefined,()=>request(`/v1/accounts/${encodeURIComponent(id)}`,"DELETE")));return;}
    // Exchanges the account's refresh token for a new access token whatever
    // the stored expiry claims. The samplers and interactive routing do this
    // on their own when a provider refuses a token, so this is for the case
    // where an operator has other evidence a credential is dead and wants it
    // replaced now rather than at the next poll.
    if(action==="refresh"){
      const account=(await request("/v1/plans")).accounts.find((candidate:{id:string})=>candidate.id===id);
      if(!account)throw new Error(`account ${id} is not registered`);
      const family=builtinProviders().find((provider)=>provider.id===account.provider);
      if(!family)throw new Error(`account ${id} names an unknown provider family ${account.provider}`);
      const auth=providerOAuth(family,config.authPath),signal=AbortSignal.timeout(60_000);
      const current=await auth.credential(id,signal);
      const refreshed=await auth.refreshRejected(id,current.access,signal);
      output({id,provider:account.provider,expires:new Date(refreshed.expires).toISOString()});
      return;
    }
    throw new Error("account action must be import, refresh, remove, list, or use");
  }
  throw new Error(USAGE);
}
