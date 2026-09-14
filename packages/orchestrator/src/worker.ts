import { loadConfig } from "./config.js";
import type { Run } from "./domain.js";
import { openCoreSession } from "./cores/index.js";
import { coreOptions, runCoreWorker } from "./host/core-worker.js";
import { workCompletion } from "./host/completion-worker.js";
import { workerTransport } from "./host/worker-transport.js";
import { assertWorkerExecution } from "./host/worker-execution.js";

const BASE=`http://${process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1"}:${process.env.PI_ORCHESTRATOR_PORT??"2460"}`;
let workerUnit:string|undefined;
const transport=workerTransport(BASE);
const request=(path:string,init?:RequestInit):Promise<any>=>transport(path,{...init,headers:{...init?.headers,...(workerUnit?{"x-pi-worker-unit":workerUnit}:{})}});
async function post(path:string,value:unknown={}):Promise<any>{return request(path,{method:"POST",body:JSON.stringify(value)});}

export async function work(runId:string):Promise<void>{
  process.env.PI_ORCHESTRATOR_ASSIGNED="1";
  process.env.PI_ORCHESTRATOR_RUN_ID=runId;
  process.env.PI_ORCHESTRATOR_CORE_USAGE="worker";
  for(const key of Object.keys(process.env))if(/^(PI_REMOTE_|PI_SESSION_)/.test(key))delete process.env[key];
  const config=loadConfig();
  const {run}=await request(`/internal/runs/${runId}`) as {run:Run};
  workerUnit=run.workerUnit;
  try { assertWorkerExecution(run); }
  catch (error) {
    await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"infrastructure",result:String(error)});
    return;
  }
  process.env.PI_ORCHESTRATOR_EXECUTION=run.execution??"user";
  if(await workCompletion(run,config,post,request))return;
  if(["done","failed","aborted","waiting"].includes(run.state))return;
  if(!run.accountId||!run.provider||!run.model)throw new Error("run has no account assignment");
  const env={...process.env,PI_CODING_AGENT_DIR:config.agentDir};
  try {
    await runCoreWorker(run,coreOptions(run,env),openCoreSession,post,request);
  } catch(error) {
    await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"infrastructure",result:String(error)});
  }
}
