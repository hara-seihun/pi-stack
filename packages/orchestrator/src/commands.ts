import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { Store } from "./store.js";
import { readUsageEvidence } from "./usage-evidence.js";
import { work } from "./worker.js";
import { providerOAuth, transactSharedCredential } from "./auth/shared-oauth.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export const COMMANDS=[
  ["daemon","Run reconciliation and the local API"],
  ["status","Print accounts, lanes, leases, and active runs"],
  ["usage-evidence","Print a read-only 24-hour quota and token snapshot; optional --ledger FILE"],
  ["run","Start one or more direct sessions"],
  ["wave","Start a one-off wave from a declared lane"],
  ["pause / resume","Set or clear the global launch halt"],
  ["abort / kill","Stop one run gracefully or immediately"],
  ["boost","Set a provider pacing multiplier or halt"],
  ["account","Import, refresh, remove, list, or reserve pooled accounts"],
] as const;
export const USAGE=`usage: pi-orchestrator ${COMMANDS.map(([name])=>name.replace(" / ","|")).join("|")}`;
export const ACCOUNT_USAGE=`usage: pi-orchestrator account list | import ID --provider openai-codex|anthropic --credential-file FILE [--label LABEL] [--concurrency N] | refresh ID | disable ID | enable ID | remove ID | use ID shared|voice`;

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
  if(command==="usage-evidence"){
    if(rest.length!==0&&(rest.length!==2||rest[0]!=="--ledger")){
      console.error("usage: pi-orchestrator usage-evidence [--ledger FILE]");process.exitCode=1;return;
    }
    const result=readUsageEvidence(rest[1]??ledgerPath());
    if(result.ok)output(result.value);else{console.error(result.error);process.exitCode=1;}
    return;
  }
  if(command==="status"){output(await request("/v1/status"));return;}
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

