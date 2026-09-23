import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, orchestratorUrl } from "./config.js";
import { Daemon } from "./daemon.js";
import { Store } from "./store.js";
import { readUsageEvidence } from "./usage-evidence.js";
import { randomUUID } from "node:crypto";
import { createThreadClient } from "./threads/http.js";
import { isThreadState, isThinkingLevel, resolveDelivery, THINKING_LEVELS, type Delivery, type Result, type SettingsOverrides, type SpawnThread, type Thread } from "./threads/contracts.js";
import { providerOAuth, transactSharedCredential } from "./auth/shared-oauth.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { AccountTransfer, prepareWithDrainWait, transferEndpoint, transferPeer } from "./auth/account-transfer.js";
import { fetchAccountFromPeer, resolveFetchPeer, resolvePeerHost } from "./auth/account-peers.js";
import { isAccountReservation } from "./admission-reservation.js";

export const COMMANDS=[
  ["daemon","Run reconciliation and the local API"],
  ["status","Print accounts, lanes, leases, and active threads"],
  ["usage-evidence","Print a read-only 24-hour quota and token snapshot; optional --ledger FILE"],
  ["run","Spawn fresh threads with --prompt TEXT [--model MODEL] [--count N] [--background]"],
  ["schedule","Create and manage recurring thread jobs"],
  ["wave","Spawn a one-off batch from a declared lane [--count N] [--background]"],
  ["list","List threads [--parent ID] [--state STATE] [--limit N] [--cursor CURSOR]"],
  ["read","Read a thread's native history: THREAD_ID [--limit N] [--cursor CURSOR]"],
  ["send","Send to THREAD_ID with --prompt TEXT [--delivery steer|hardSteer]; agents steer by default, senderless sends queue by default"],
  ["stop","Stop THREAD_ID; --descendants also stops its descendants"],
  ["pause / resume","Set or clear the global launch halt; --ordinary controls only ordinary work"],
  ["resume THREAD_ID","Release a held thread's pending messages"],
  ["boost","Set a provider pacing multiplier or halt"],
  ["account","Import, refresh, remove, list, reserve, or exclusively transfer pooled accounts"],
  ["peer","List configured account-transfer peers"],
] as const;
export const USAGE=`usage: pi-orchestrator ${COMMANDS.map(([name])=>name.replace(" / ","|")).join("|")}`;
export const ACCOUNT_USAGE=`usage: pi-orchestrator account list | import ID --provider openai-codex|anthropic --credential-file FILE [--label LABEL] [--concurrency N] | refresh ID | disable ID | enable ID | remove ID | use ID shared|voice | transfer ID --to PEER_OR_SSH_HOST [--wait-for-drain [DURATION]] | fetch ID --from PEER [--wait-for-drain [DURATION]] | transfer-status ID | reserve ID --metadata JSON --reason TEXT | unreserve ID | reservation ID`;

const base=()=>orchestratorUrl();
const threadBase=()=>process.env.PI_THREAD_API_URL??`${base()}/v1/threads`;
const ledgerPath=()=>process.env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");
function flags(args:string[]):{named:Map<string,string>;positional:string[]}{const named=new Map<string,string>(),positional:string[]=[];for(let i=0;i<args.length;i++){const value=args[i]!;if(!value.startsWith("--")){positional.push(value);continue;}const [name,inline]=value.slice(2).split("=",2);if(inline!==undefined)named.set(name!,inline);else if(["force","background","descendants"].includes(name!))named.set(name!,"true");else if(args[i+1]&&!args[i+1]!.startsWith("--"))named.set(name!,args[++i]!);else named.set(name!,"true");}return{named,positional};}
function required(named:Map<string,string>,key:string):string{const value=named.get(key);if(!value)throw new Error(`--${key} is required`);return value;}
async function request(path:string,method="GET",value?:unknown):Promise<any>{const response=await fetch(`${base()}${path}`,{method,headers:{"content-type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)});const body=await response.json();if(!response.ok)throw new Error(typeof body.error==="string"?body.error:body.error?.message??`orchestrator returned ${response.status}`);return body;}
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
function duration(value:string|undefined,name:string,defaultMs:number):number|undefined{
  if(value===undefined)return undefined;
  if(value==="true")return defaultMs;
  const match=/^(\d+)(ms|s|m|h)$/.exec(value);
  if(!match)throw new Error(`${name} must use ms, s, m, or h`);
  const units={ms:1,s:1_000,m:60_000,h:3_600_000} as const;
  const result=Number(match[1])*units[match[2] as keyof typeof units];
  if(!Number.isSafeInteger(result)||result<1||result>24*3_600_000)throw new Error(`${name} must be between 1ms and 24h`);
  return result;
}
function scheduleDuration(value:string):number{
  const match=/^(\d+)(s|m|h|d)$/.exec(value);
  if(!match)throw new Error("--every must use s, m, h, or d");
  const units={s:1_000,m:60_000,h:3_600_000,d:86_400_000} as const;
  const result=Number(match[1])*units[match[2] as keyof typeof units];
  if(!Number.isSafeInteger(result)||result<1_000||result>366*86_400_000)throw new Error("--every must be between 1s and 366d");
  return result;
}
function scheduleStart(value:string|undefined):number|undefined{
  if(value===undefined)return undefined;
  if(value==="now")return Date.now();
  const result=Date.parse(value);
  if(!Number.isFinite(result))throw new Error("--start must be now or an ISO 8601 timestamp");
  return result;
}
function threadSettings(named:Map<string,string>):SettingsOverrides|undefined{
  const model=named.get("model"),thinkingLevel=named.get("thinking"),speed=named.get("speed");
  if(thinkingLevel&&!isThinkingLevel(thinkingLevel))throw new Error(`Invalid --thinking level; use ${THINKING_LEVELS.join(", ")}`);
  if(speed&&speed!=="standard"&&speed!=="priority")throw new Error("--speed must be standard or priority");
  if(!model&&!thinkingLevel&&!speed)return undefined;
  return{...(model?{model}:{}),...(thinkingLevel?{thinkingLevel:thinkingLevel as SettingsOverrides["thinkingLevel"]}:{}),...(speed?{speed:speed as SettingsOverrides["speed"]}:{})};
}
async function spawnThreads(input:Omit<SpawnThread,"requestId">,count:number):Promise<void>{
  if(process.env.PI_THREAD_CAN_SPAWN==="0")throw new Error("Orchestrator workers cannot spawn subagents; report remaining work to the parent conversation");
  if(process.env.PI_THREAD_ID){
    if(input.parentId&&input.parentId!==process.env.PI_THREAD_ID)throw new Error("Agent spawning must use its own thread as parent");
    input={...input,parentId:process.env.PI_THREAD_ID};
  }
  const api=createThreadClient(threadBase()),threads:Thread[]=[];
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
    threadOutput(await createThreadClient(threadBase()).control(command==="stop"?{threadId,action:"stop",descendants:switchEnabled(named,"descendants")}:{threadId,action:"resume"}));return;
  }
  if(command==="schedule"){
    const [action,...tail]=rest;
    if(action===undefined||action==="help"||action==="--help"){
      console.log("usage: pi-orchestrator schedule list | create --prompt TEXT --every DURATION [--start now|ISO] [--cwd PATH] [--model MODEL] [--thinking LEVEL] [--speed standard|priority] [--background] [--id ID] [--title TITLE] | show ID | pause ID | resume ID | remove ID --yes");
      return;
    }
    const {named,positional}=flags(tail);
    if(action==="list"){
      if(positional.length||named.size)throw new Error("schedule list accepts no options");
      output(await request("/v1/schedules"));return;
    }
    if(action==="create"){
      const allowed=new Set(["id","title","prompt","cwd","every","start","model","thinking","speed","background","force"]);
      for(const key of named.keys())if(!allowed.has(key))throw new Error(`Unknown schedule option --${key}`);
      const force=switchEnabled(named,"force"),background=switchEnabled(named,"background");
      if(force&&background)throw new Error("Choose --force or --background");
      const prompt=named.get("prompt")??positional.join(" ");
      if(!prompt.trim())throw new Error("schedule create requires --prompt");
      const every=required(named,"every");
      output(await request("/v1/schedules","POST",{
        ...(named.has("id")?{id:named.get("id")}:{}) ,...(named.has("title")?{title:named.get("title")}:{}) ,
        prompt,cwd:named.get("cwd")??process.cwd(),intervalMs:scheduleDuration(every),startAt:scheduleStart(named.get("start")),
        settings:threadSettings(named),admission:background?"background":"force",
      }));return;
    }
    const id=positional[0];
    if(!id||positional.length!==1)throw new Error(`schedule ${action} requires one schedule id`);
    if(action==="show"){
      if(named.size)throw new Error("schedule show accepts no options");
      output(await request(`/v1/schedules/${encodeURIComponent(id)}`));return;
    }
    if(action==="pause"||action==="resume"){
      if(named.size)throw new Error(`schedule ${action} accepts no options`);
      output(await request(`/v1/schedules/${encodeURIComponent(id)}/${action}`,"POST"));return;
    }
    if(action==="remove"){
      if([...named.keys()].some(key=>key!=="yes")||!switchEnabled(named,"yes"))throw new Error("schedule remove requires --yes because it permanently deletes the schedule definition");
      output(await request(`/v1/schedules/${encodeURIComponent(id)}`,"DELETE"));return;
    }
    throw new Error("schedule action must be list, create, show, pause, resume, or remove");
  }
  if(command==="run"||command==="wave"){
    const {named,positional}=flags(rest),count=positiveInteger(named.get("count")??"1","--count");
    const allowed=new Set(["count","force","background","model","thinking","speed",...(command==="run"?["prompt","cwd","title","parent"]:["lane"])]);
    for(const key of named.keys())if(!allowed.has(key))throw new Error(`Unknown ${command} option --${key}`);
    const force=switchEnabled(named,"force"),background=switchEnabled(named,"background");
    if(force&&background)throw new Error("Choose --force or --background");
    const settings=threadSettings(named),admission=background?"background":"force";
    if(command==="run"){
      const message=named.get("prompt")??positional.join(" ");
      if(!message.trim())throw new Error("run requires --prompt");
      await spawnThreads({message,cwd:named.get("cwd")??process.cwd(),title:named.get("title"),parentId:named.get("parent"),settings,admission},count);
    }else{
      if(process.env.PI_THREAD_ID||process.env.PI_THREAD_CAN_SPAWN==="0")throw new Error("Agents cannot launch unparented waves; use thread_spawn from the parent conversation");
      const id=named.get("lane")??positional[0];if(!id)throw new Error("wave requires a lane");
      output(await request("/v1/wave","POST",{lane:id,count,settings,...(force||background?{admission}:{})}));
    }
    return;
  }
  if(command==="list"){
    const {named,positional}=flags(rest);
    if(positional.length)throw new Error("list accepts named options only");
    const state=named.get("state");
    if(state!==undefined&&!isThreadState(state))throw new Error("Invalid --state");
    threadOutput(await createThreadClient(threadBase()).list({parentId:named.get("parent"),state,limit:named.has("limit")?positiveInteger(named.get("limit")!,"--limit"):undefined,cursor:named.get("cursor")}));return;
  }
  if(command==="read"){
    const {named,positional}=flags(rest),threadId=positional[0];
    if(!threadId||positional.length!==1)throw new Error("read requires one thread id");
    threadOutput(await createThreadClient(threadBase()).read({threadId,cursor:named.get("cursor"),limit:named.has("limit")?positiveInteger(named.get("limit")!,"--limit"):undefined}));return;
  }
  if(command==="send"){
    const {named,positional}=flags(rest),threadId=positional[0],text=named.get("prompt")??positional.slice(1).join(" "),senderId=process.env.PI_THREAD_ID||undefined,delivery=named.get("delivery")??resolveDelivery({senderId});
    if(!threadId||!text.trim())throw new Error("send requires a thread id and --prompt");
    if(senderId&&delivery==="queue")throw new Error("Agents must use steer or hardSteer; they cannot queue messages");
    if(!['queue','steer','hardSteer'].includes(delivery))throw new Error(`--delivery must be ${senderId?"steer or hardSteer":"queue, steer, or hardSteer"}`);
    threadOutput(await createThreadClient(threadBase()).send({requestId:randomUUID(),threadId,senderId,text,delivery:delivery as Delivery}));return;
  }
  if(command==="boost"){const {named,positional}=flags(rest),provider=positional[0],value=positional[1]??named.get("multiplier");if(!provider||value===undefined)throw new Error("boost requires provider and multiplier");output(await request("/v1/control","POST",{key:`boost:${provider}`,value:String(value)}));return;}
  if(command==="peer"){
    if(rest.length!==1||rest[0]!=="list")throw new Error("usage: pi-orchestrator peer list");
    const peers=loadConfig().peers;
    output(Object.entries(peers).map(([name,peer])=>({name,...peer})));
    return;
  }
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
    if(action==="fetch"){
      const config=loadConfig(),source=resolveFetchPeer(config.peers,required(named,"from"));
      const waitForDrainMs=duration(named.get("wait-for-drain"),"--wait-for-drain",10*60_000);
      const signal=AbortSignal.timeout((waitForDrainMs??0)+120_000);
      await fetchAccountFromPeer(id,source,waitForDrainMs,signal);
      return;
    }
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
        const config=loadConfig();
        const waitForDrainMs=action==="transfer"?duration(named.get("wait-for-drain"),"--wait-for-drain",10*60_000):undefined;
        const signal=AbortSignal.timeout((waitForDrainMs??0)+60_000);
        const owner=new AccountTransfer(store,config.authPath,transferEndpoint(ledgerPath()));
        if(action==="transfer-status"){
          const record=store.control(`account-transfer:${id}`);
          output({id,transfer:record?JSON.parse(record):null,enabled:store.account(id)?.enabled,activeLeases:store.activeLeases(id).map(lease=>lease.id)});return;
        }
        const target=resolvePeerHost(config.peers,required(named,"to")),existing=await owner.outgoing(id,signal);
        if(existing){
          const configured=store.control(`account-transfer-target:${id}`);
          if(configured!==target.sshHost)throw new Error("Transfer destination differs from its recorded SSH host");
          if("type" in existing){output(existing);return;}
        }
        const destination=existing?.destination??await transferPeer(target.sshHost,"inspect",{alias:id},signal);
        store.setControl(`account-transfer-target:${id}`,target.sshHost);
        const prepared=existing??await prepareWithDrainWait(owner,id,destination,signal,{waitForDrainMs,onPreparing:state=>{if(waitForDrainMs!==undefined)output(state);}});
        if("type" in prepared){output(prepared);return;}
        const accepted=await transferPeer(target.sshHost,"receive",prepared,signal);
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
    throw new Error("account action must be import, refresh, remove, list, use, transfer, fetch, reserve, or reservation");
  }
  throw new Error(USAGE);
}
