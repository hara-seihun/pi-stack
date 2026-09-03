import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { SCHEMA_VERSION, Store, USAGE_HOUR_SCHEMA, openLedgerDatabase } from "./store.js";
import { work } from "./worker.js";
import { transactSharedCredential } from "./auth/shared-oauth.js";

export const COMMANDS=[
  ["daemon","Run reconciliation and the local API"],
  ["status","Print accounts, lanes, rooms, leases, and active runs"],
  ["run","Start one or more direct sessions"],
  ["wave","Start a one-off wave from a declared lane"],
  ["room","Create, inspect, message, or close a warm room"],
  ["pause / resume","Set or clear the global launch halt"],
  ["abort / kill","Stop one run gracefully or immediately"],
  ["boost","Set a provider pacing multiplier or halt"],
  ["account","Import, remove, or list pooled accounts"],
  ["usage-components","Transition: record usage tokens per component; delete this command once both hosts have run it"],
] as const;
export const USAGE=`usage: pi-orchestrator ${COMMANDS.map(([name])=>name.replace(" / ","|")).join("|")}`;
export const ACCOUNT_USAGE=`usage: pi-orchestrator account list | import ID --provider openai-codex|anthropic --credential-file FILE [--label LABEL] [--concurrency N] | remove ID`;

const BASE=`http://${process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1"}:${process.env.PI_ORCHESTRATOR_PORT??"2460"}`;
const ledgerPath=()=>process.env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");
function flags(args:string[]):{named:Map<string,string>;positional:string[]}{const named=new Map<string,string>(),positional:string[]=[];for(let i=0;i<args.length;i++){const value=args[i]!;if(!value.startsWith("--")){positional.push(value);continue;}const [name,inline]=value.slice(2).split("=",2);if(inline!==undefined)named.set(name!,inline);else if(args[i+1]&&!args[i+1]!.startsWith("--"))named.set(name!,args[++i]!);else named.set(name!,"true");}return{named,positional};}
function required(named:Map<string,string>,key:string):string{const value=named.get(key);if(!value)throw new Error(`--${key} is required`);return value;}
async function request(path:string,method="GET",value?:unknown):Promise<any>{const response=await fetch(`${BASE}${path}`,{method,headers:{"content-type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)});const body=await response.json();if(!response.ok)throw new Error(body.error??`orchestrator returned ${response.status}`);return body;}
function output(value:unknown):void{console.log(JSON.stringify(value,null,2));}
export async function dispatch(argv:string[]):Promise<void>{
  const [command,...rest]=argv;
  if(command===undefined||command==="help"||command==="--help"){
    console.log(USAGE);
    return;
  }
  if(command==="daemon"){const store=Store.open(ledgerPath());try{await new Daemon(store,loadConfig()).start();}finally{store.close();}return;}
  if(command==="worker"){const id=rest[0];if(!id)throw new Error("worker run id is required");await work(id);return;}
  if(command==="status"){output(await request("/v1/status"));return;}
  if(command==="usage-components"){
    // Hourly usage rows written before this upgrade added input, output, and
    // cache tokens into one number that no reader can take apart, and nothing
    // consumed them, so the transition starts the table over.
    const path=ledgerPath(),db=openLedgerDatabase(path);
    try{
      const {version}=db.prepare("SELECT version FROM meta").get() as {version:number};
      if(version===SCHEMA_VERSION){console.log(`${path} already records usage per component`);return;}
      if(version!==1)throw new Error(`${path} is at schema ${version}; this transition upgrades 1 to ${SCHEMA_VERSION}`);
      db.exec(`BEGIN IMMEDIATE;DROP TABLE usage_hour;${USAGE_HOUR_SCHEMA}UPDATE meta SET version=${SCHEMA_VERSION};COMMIT`);
      console.log(`${path} now records usage per component; hourly totals from before the upgrade were dropped`);
    }finally{db.close();}
    return;
  }
  if(command==="pause"){output(await request("/v1/control","POST",{key:"launches",value:"paused"}));return;}
  if(command==="resume"){output(await request("/v1/control","POST",{key:"launches",value:"enabled"}));return;}
  if(command==="abort"||command==="kill"){if(!rest[0])throw new Error(`${command} requires a run id`);output(await request(`/v1/runs/${encodeURIComponent(rest[0])}/${command}`,"POST"));return;}
  if(command==="run"){const {named,positional}=flags(rest),prompt=named.get("prompt")??positional.join(" ");if(!prompt)throw new Error("run requires --prompt");output(await request("/v1/run","POST",{prompt,cwd:named.get("cwd")??process.cwd(),profile:named.get("profile")??"standard",count:Number(named.get("count")??1),force:named.has("force")}));return;}
  if(command==="wave"){const {named,positional}=flags(rest),lane=named.get("lane")??positional[0];if(!lane)throw new Error("wave requires a lane");output(await request("/v1/wave","POST",{lane,count:Number(named.get("count")??1),force:named.has("force")}));return;}
  if(command==="boost"){const {named,positional}=flags(rest),provider=positional[0],value=positional[1]??named.get("multiplier");if(!provider||value===undefined)throw new Error("boost requires provider and multiplier");output(await request("/v1/control","POST",{key:`boost:${provider}`,value:String(value)}));return;}
  if(command==="account"){
    const [action,...tail]=rest;
    if(action===undefined||action==="help"||action==="--help"){
      console.log(ACCOUNT_USAGE);
      return;
    }
    if(action==="list"){output((await request("/v1/plans")).accounts);return;}
    const {named,positional}=flags(tail),id=named.get("id")??positional[0];if(!id)throw new Error(`account ${action} requires an id`);
    const config=loadConfig();
    if(action==="import"){const provider=named.get("provider")??positional[1];if(provider!=="openai-codex"&&provider!=="anthropic")throw new Error("--provider must be openai-codex or anthropic");const credentialFile=required(named,"credential-file"),credential=JSON.parse(readFileSync(credentialFile,"utf8"));output(await transactSharedCredential(config.authPath,id,credential,()=>request("/v1/accounts","POST",{id,provider,label:named.get("label"),concurrency:Number(named.get("concurrency")??config.defaultAccountConcurrency)})));return;}
    if(action==="remove"){output(await transactSharedCredential(config.authPath,id,undefined,()=>request(`/v1/accounts/${encodeURIComponent(id)}`,"DELETE")));return;}
    throw new Error("account action must be import, remove, or list");
  }
  if(command==="room"){
    const [action,...tail]=rest,{named,positional}=flags(tail),name=named.get("name")??positional[0];
    if(action==="status"){const status=await request("/v1/status");output(name?status.rooms.filter((room:any)=>room.name===name||room.id===name):status.rooms);return;}
    if(!name)throw new Error(`room ${action} requires --name`);
    if(action==="create"){output(await request("/v1/rooms","POST",{name,prompt:required(named,"prompt"),coordinatorPrompt:named.get("coordinator-prompt"),cwd:named.get("cwd")??process.cwd(),profile:named.get("profile")??"standard",budget:named.has("force")?"force":"background",members:Number(named.get("members")??2)}));return;}
    if(action==="message"){output(await request(`/v1/rooms/${encodeURIComponent(name)}/messages`,"POST",{targetRunId:named.get("run"),body:required(named,"message"),wake:named.has("wake")}));return;}
    if(action==="close"){output(await request(`/v1/rooms/${encodeURIComponent(name)}/close`,"POST"));return;}
    throw new Error("room action must be create, status, message, or close");
  }
  throw new Error(USAGE);
}

