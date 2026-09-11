import { execFile, spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BudgetClass, LaneReadiness, LaneManifest, LaneSpec, OrchestratorConfig, Run } from "./domain.js";
import { isRunContext } from "./isolated-context-contract.js";
import { accountCapacity, assign, commitMeterAdmission } from "./policy.js";
import { Store } from "./store.js";
import { Fleet } from "./fleet.js";
import { CompletionService } from "./completion.js";
import { COMPLETION_OPENAPI } from "./completion-openapi.js";
import { reconcileCompletionReceipts } from "./host/completion-worker.js";
import type { CompletionOutcome } from "./completion-contract.js";
import { CodexMeterSampler } from "./meters-codex.js";
import { AnthropicMeterSampler } from "./meters-anthropic.js";
import { ORCHESTRATOR_CATALOG } from "./catalog.js";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerOAuth } from "./auth/shared-oauth.js";

const HOST=process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1";
const PORT=Number(process.env.PI_ORCHESTRATOR_PORT??"2460");

function json(res:ServerResponse,status:number,body:unknown):void{const text=JSON.stringify(body);res.writeHead(status,{"content-type":"application/json","content-length":Buffer.byteLength(text)});res.end(text);}
async function body(req:IncomingMessage):Promise<any>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{};}
function exec(command:string,cwd?:string,timeout=30_000):Promise<string>{return new Promise((resolve,reject)=>execFile("bash",["-lc",command],{cwd,timeout,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr.trim()||error.message)):resolve(stdout.trim())));}

export class Daemon {
  private manifestMtime=0;
  private laneBudget:BudgetClass="background";
  private snapshotCommand?:string;
  private readinessAt=0;
  private readiness?:LaneReadiness;
  private reconciling=false;
  private stopped=false;
  private releasePath:string;
  private readonly ledgerPath:string;
  private readonly codexMeters:CodexMeterSampler;
  private readonly anthropicMeters:AnthropicMeterSampler;
  private readonly fleet:Fleet;
  private readonly completions:CompletionService;

  constructor(readonly store:Store,readonly config:OrchestratorConfig,releasePath?:string,ledgerPath?:string){
    this.fleet=new Fleet(store);
    this.completions=new CompletionService(store,process.cwd());
    this.releasePath=releasePath??dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
    this.ledgerPath=ledgerPath||process.env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");
    this.codexMeters=new CodexMeterSampler(store,{auth:providerOAuth(openaiCodexProvider(),config.authPath),meters:ORCHESTRATOR_CATALOG.meters.filter((meter)=>meter.provider==="openai-codex")});
    this.anthropicMeters=new AnthropicMeterSampler(store,{auth:providerOAuth(anthropicProvider(),config.authPath)});
  }

  async start():Promise<void>{
    // Workers are transient units in this account's own user manager. A system
    // unit with User= does not point systemctl at that manager, so derive the
    // runtime directory from the real uid when the environment does not say.
    const uid=process.getuid?.();
    if(uid!==undefined){
      process.env.XDG_RUNTIME_DIR??=`/run/user/${uid}`;
      process.env.DBUS_SESSION_BUS_ADDRESS??=`unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
    }
    await this.loadManifest();
    reconcileCompletionReceipts(this.completions,join(this.config.agentDir,"completion-receipts"));
    this.recoverWorkers();
    const server=createServer((req,res)=>void this.request(req,res));
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(PORT,this.config.listenHost??HOST,resolve);});
    const timer=setInterval(()=>void this.reconcile().catch((error)=>console.error("reconcile:",error)),this.config.reconcileIntervalMs);
    await this.reconcile();
    console.log(`pi-orchestrator daemon listening on ${this.config.listenHost??HOST}:${PORT}`);
    await new Promise<void>((resolve)=>{for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,resolve);});
    this.stopped=true;clearInterval(timer);
    await this.waitForReconcile();
    await new Promise<void>((resolve)=>server.close(()=>resolve()));
  }

  private waitForReconcile():Promise<void>{
    return new Promise((resolve)=>{
      const settled=()=>{if(this.reconciling)setTimeout(settled,10);else resolve();};
      settled();
    });
  }

  private async loadManifest():Promise<void>{
    const path=this.config.taskManifest;if(!path)return;
    const mtime=statSync(path).mtimeMs;if(mtime===this.manifestMtime)return;
    const manifest=JSON.parse(readFileSync(path,"utf8")) as LaneManifest;
    if(manifest.version!==2||!Array.isArray(manifest.lanes))throw new Error("lane manifest version 2 required");
    for(const key of Object.keys(manifest))if(!["version","budget","lanes","snapshotCommand"].includes(key))throw new Error(`unsupported lane manifest field ${key}`);
    const budget=manifest.budget===undefined?"background":manifest.budget;
    if(budget!=="background"&&budget!=="force")throw new Error("lane manifest budget must be background or force");
    if(manifest.snapshotCommand!==undefined&&(typeof manifest.snapshotCommand!=="string"||!manifest.snapshotCommand.trim()))throw new Error("snapshotCommand must be a non-empty command");
    if(budget==="force"&&!manifest.snapshotCommand)throw new Error("force lane budget requires a snapshotCommand that reports unfinished work");
    const lanes=manifest.lanes.map((lane)=>{if("prompt" in lane)return lane;const {promptFile,...spec}=lane;return{...spec,prompt:readFileSync(resolve(dirname(path),promptFile),"utf8")};});
    this.store.reconcileLanes(lanes);
    this.laneBudget=budget;
    this.snapshotCommand=manifest.snapshotCommand;
    this.readinessAt=0;this.readiness=undefined;
    this.manifestMtime=mtime;
  }

  async reconcile():Promise<void>{
    if(this.reconciling||this.stopped)return;this.reconciling=true;
    try{
      await this.loadManifest();
      reconcileCompletionReceipts(this.completions,join(this.config.agentDir,"completion-receipts"));
      const samples=(await Promise.all([this.codexMeters.sample(),this.anthropicMeters.sample()])).flat();
      for(const account of this.store.accounts()){
        // A disabled account is never sampled again, so whatever failure it
        // reported last would stay in status for good. Suspension answers the
        // alarm; retiring it here is what makes the alarm trustworthy.
        if(!account.enabled){
          const key=`meter-error:${account.id}`;
          if(this.store.control(key))this.store.setControl(key,"");
          continue;
        }
        const observed=samples.filter((sample)=>sample.accountId===account.id&&sample.outcome!=="not-due");
        if(!observed.length)continue;
        const failures=observed.filter((sample)=>sample.outcome!=="recorded"&&sample.outcome!=="stale-reading");
        const key=`meter-error:${account.id}`,error=failures.length?JSON.stringify(failures):"";
        if(error!==(this.store.control(key)??"")){
          this.store.setControl(key,error);
          console.error(`meter ${account.id}: ${error||"recovered"}`);
        }
      }
      await this.refreshReadiness();
      this.resumeCoordinators();
      for(const run of this.store.admissionQueue()){
        if(run.source==="lane"){this.store.trimQueuedLane(run.sourceId!,0);continue;}
        await this.launch(run);
      }
      await this.fillCapacity();
      const now=Date.now();
      for(const run of this.store.runs(["starting","running"])){
        const progress=run.progressAt??run.startedAt??run.createdAt;
        if(now-progress>this.config.killAfterMs){this.stopUnit(run.workerUnit);this.store.updateRun(run.id,{state:"failed",failureKind:"infrastructure",result:"session made no progress"});continue;}
        if(process.env.PI_ORCHESTRATOR_WORKER_LAUNCH!=="process"&&run.workerUnit&&!this.unitIsActive(run.workerUnit)){
          this.restartAssignedWorker(run,now);
          continue;
        }
        if(now-progress>this.config.stallAfterMs)this.store.setControl(`abort:${run.id}`,"stalled");
      }
    }finally{this.reconciling=false;}
  }

  private async refreshReadiness():Promise<void>{
    if(!this.snapshotCommand||Date.now()-this.readinessAt<30_000)return;
    this.readinessAt=Date.now();
    try{
      const snapshot=JSON.parse(await exec(this.snapshotCommand)) as LaneReadiness;
      if(typeof snapshot.revision!=="string"||!snapshot.lanes||typeof snapshot.lanes!=="object"||Array.isArray(snapshot.lanes))throw new Error("invalid lane readiness snapshot");
      for(const [id,value] of Object.entries(snapshot.lanes))if(!value||typeof value.ready!=="boolean"||Object.keys(value).some((key)=>key!=="ready"))throw new Error(`lane ${id} requires ready: boolean, not a worker count`);
      for(const lane of this.store.lanes())if(!Object.hasOwn(snapshot.lanes,lane.id))throw new Error(`readiness snapshot omitted lane ${lane.id}`);
      this.readiness=snapshot;this.store.setControl("readiness_error","");
    }catch(error){this.readiness=undefined;this.store.setControl("readiness_error",String(error));}
  }

  private laneReady(id:string):boolean{
    return !this.snapshotCommand||(this.readiness?.lanes[id]?.ready===true&&Number(this.store.control(`readiness-admitted:${id}`)??0)<this.readinessAt);
  }

  private laneEnabled(id:string):boolean{return !!this.store.lane(id)&&this.store.control(`complete:${id}`)===undefined;}

  private share(lane:LaneSpec):number{
    return (1+this.store.admittedLaneCount(lane.id))/lane.weight;
  }

  private async fillCapacity():Promise<void>{
    const failed=new Set<string>();
    for(let slot=0;slot<this.config.maxConcurrentSessions;slot++){
      const lanes=this.store.lanes().filter((lane)=>this.laneEnabled(lane.id)&&this.laneReady(lane.id));
      lanes.sort((a,b)=>this.share(a)-this.share(b)||a.id.localeCompare(b.id));
      let admitted=false;
      for(const lane of lanes){
        const key=`lane:${lane.id}`;
        if(failed.has(key))continue;
        const choice=assign(this.store,lane.profile,this.laneBudget,this.config);
        if(!choice.assignment){this.store.setControl(`refusal:${key}`,choice.refusals.map((r)=>`${r.accountId}: ${r.reason}`).join("; "));continue;}
        try{
          const prompt=await this.lanePrompt(lane);
          const [id]=this.store.createRuns({count:1,source:"lane",sourceId:lane.id,prompt,cwd:lane.cwd,profile:lane.profile,budget:this.laneBudget});
          if(!await this.launch(this.store.run(id!)!)){failed.add(key);this.store.trimQueuedLane(lane.id,0);continue;}
          if(this.snapshotCommand)this.store.setControl(`readiness-admitted:${lane.id}`,String(this.readinessAt));
          this.store.setControl(`refusal:${key}`,"");
        }catch(error){failed.add(key);this.store.setControl(`refusal:${key}`,String(error));continue;}
        admitted=true;break;
      }
      if(!admitted)break;
    }
  }

  private async lanePrompt(lane:LaneSpec):Promise<string>{
    let prompt=lane.prompt;
    if(lane.openingProbe){
      const values=JSON.parse(await exec(lane.openingProbe,lane.cwd,55_000));
      if(!values||typeof values!=="object"||Array.isArray(values))throw new Error(`lane ${lane.id} opening probe must print one JSON object`);
      prompt=prompt.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g,(_whole,key)=>{
        const value=values[key];if(!["string","number","boolean"].includes(typeof value))throw new Error(`lane ${lane.id} probe omitted ${key}`);return String(value);
      });
    }
    if(lane.doctrineUrl){
      const response=await fetch(lane.doctrineUrl,{signal:AbortSignal.timeout(10_000)});
      if(!response.ok)throw new Error(`lane ${lane.id} doctrine returned HTTP ${response.status}`);
      prompt=`# Lane doctrine\n\n${await response.text()}\n\n# Assignment\n\n${prompt}`;
    }
    return prompt;
  }

  private async launch(run:Run):Promise<boolean>{
    const fixed=this.store.fleetChild(run.id)?.assignment;
    const config=fixed?{...this.config,profiles:{...this.config.profiles,[run.profile]:[fixed]}}:this.config;
    const choice=assign(this.store,run.profile,run.budget,config,Date.now());
    if(!choice.assignment){this.store.setControl(`refusal:${run.id}`,choice.refusals.map((r)=>`${r.accountId}: ${r.reason}`).join("; "));return false;}
    const unit=`pi-orchestrator-run-${run.id.replaceAll("-","")}`;
    if(!this.store.assignRun(run.id,{...choice.assignment,unit,releasePath:this.releasePath}))return false;
    commitMeterAdmission(this.store,choice.assignment);
    try{this.startUnit(unit,run.id,this.releasePath);return true;}catch(error){this.store.updateRun(run.id,{state:"failed",failureKind:"infrastructure",result:`worker launch failed: ${String(error)}`});return false;}
  }

  private startUnit(unit:string,runId:string,releasePath:string):void{
    const cli=join(releasePath,"dist/cli.js");
    const args=[
      "--user","--collect",`--unit=${unit}`,
      "--property=Type=exec","--property=Restart=no","--property=KillMode=mixed","--property=TimeoutStopSec=20",
      "--property=CPUWeight=20","--property=MemoryHigh=6G","--property=MemoryMax=8G","--property=TasksMax=4096","--property=LimitNOFILE=1048576",
      "--setenv=PI_ORCHESTRATOR_ASSIGNED=1",`--setenv=PI_ORCHESTRATOR_RUN_ID=${runId}`,
      `--setenv=PI_ORCHESTRATOR_LEDGER=${this.ledgerPath}`,
      `--setenv=PI_CODING_AGENT_DIR=${this.config.agentDir}`,
      "--setenv=PI_BASH_TIMEOUT_MAX_SECONDS=55",
    ];
    for(const name of ["PATH","PYTHONPATH","CPATH","LIBRARY_PATH","PKG_CONFIG_PATH","PI_ORCHESTRATOR_CONFIG","PI_ORCHESTRATOR_HOST","PI_ORCHESTRATOR_PORT","PI_MCP_SIZE_ALERTS_INBOX","PI_MCP_SIZE_ALERT_COMMAND"]){
      const value=process.env[name];if(value!==undefined)args.push(`--setenv=${name}=${value}`);
    }
    args.push(process.execPath,cli,"worker",runId);
    if(process.env.PI_ORCHESTRATOR_WORKER_LAUNCH==="process"){
      const child=spawn(process.execPath,[cli,"worker",runId],{detached:true,stdio:"ignore",env:{...process.env,PI_ORCHESTRATOR_ASSIGNED:"1",PI_ORCHESTRATOR_RUN_ID:runId,PI_ORCHESTRATOR_LEDGER:this.ledgerPath}});child.unref();return;
    }
    const result=spawnSync("systemd-run",args,{encoding:"utf8"});
    if(result.status!==0)throw new Error(result.stderr.trim()||`systemd-run exited ${result.status}`);
  }

  private stopUnit(unit?:string):void{
    if(!unit)return;
    const result=spawnSync("systemctl",["--user","--no-block","stop",unit],{encoding:"utf8",timeout:10_000});
    if(result.error||result.status!==0)throw new Error(`worker stop failed: ${result.error??result.stderr.trim()}`);
  }
  private unitIsActive(unit:string):boolean{
    return spawnSync("systemctl",["--user","is-active","--quiet",unit]).status===0;
  }
  private startExistingUnit(unit:string):boolean{
    const started=spawnSync("systemctl",["--user","start",unit],{stdio:"ignore"});
    return started.status===0&&this.unitIsActive(unit);
  }
  private resumeCoordinators():void{
    if(this.store.control("launches")==="paused")return;
    for(const run of this.store.runs(["waiting"])){
      if(!this.fleet.pending(run.id).length||!run.accountId||!run.workerUnit||!run.releasePath)continue;
      if(this.unitIsActive(run.workerUnit))continue;
      if(this.store.activeLeases().length>=this.config.maxConcurrentSessions)return;
      const resumeConfig={...this.config,profiles:{...this.config.profiles,[run.profile]:[{provider:run.provider!,model:run.model!,thinking:run.thinking}]}};
      const preferred=assign(this.store,run.profile,"force",resumeConfig,Date.now(),run.accountId);
      const choice=preferred.assignment?preferred:assign(this.store,run.profile,"force",resumeConfig);
      if(!choice.assignment){this.store.setControl(`refusal:${run.id}`,choice.refusals.map(refusal=>`${refusal.accountId}: ${refusal.reason}`).join("; "));continue;}
      if(!this.store.resumeAssignedRun(run.id,Date.now(),choice.assignment.accountId))continue;
      this.store.updateRun(run.id,{progressAt:Date.now()});
      try{this.startUnit(run.workerUnit,run.id,run.releasePath);}
      catch(error){if(!this.startExistingUnit(run.workerUnit))this.store.updateRun(run.id,{state:"failed",failureKind:"infrastructure",result:`coordinator resume failed: ${String(error)}`});}
    }
  }
  private recoverWorkers():void{
    for(const run of this.store.runs(["queued","starting","running","failed"])){
      if(!run.accountId||!run.provider||!run.model||!run.workerUnit||!run.releasePath)continue;
      if(this.unitIsActive(run.workerUnit)){
        if(run.state!=="running")this.store.adoptAssignedRun(run.id);
      }else if(run.state!=="failed")this.restartAssignedWorker(run);
    }
  }
  private restartAssignedWorker(run:Run,at=Date.now()):void{
    const progress=run.progressAt??run.startedAt??run.createdAt;
    if(at-progress>this.config.killAfterMs){this.store.updateRun(run.id,{state:"failed",failureKind:"infrastructure",result:"session made no progress"},at);return;}
    if(!this.store.resumeAssignedRun(run.id,at))return;
    // A daemon restart can race the user manager's state transition for a worker that never stopped.
    // Adopt it instead of trying to redefine its still-loaded transient unit.
    if(this.unitIsActive(run.workerUnit!)){this.store.adoptAssignedRun(run.id,at);return;}
    spawnSync("systemctl",["--user","reset-failed",run.workerUnit!],{stdio:"ignore"});
    try{this.startUnit(run.workerUnit!,run.id,run.releasePath!);}
    catch(error){
      // systemd-run refuses an existing transient unit. `start` is a no-op when that unit is already
      // active and restarts its recorded immutable release when it is loaded but inactive.
      if(this.startExistingUnit(run.workerUnit!)){this.store.adoptAssignedRun(run.id,at);return;}
      this.store.updateRun(run.id,{state:"failed",failureKind:"infrastructure",result:`worker recovery failed: ${String(error)}`},at);
    }
  }

  private async request(req:IncomingMessage,res:ServerResponse):Promise<void>{
    try{
      const url=new URL(req.url??"/",`http://${HOST}:${PORT}`),method=req.method??"GET";
      const completionReply=(outcome:CompletionOutcome<unknown>)=>{
        if(outcome.ok)return json(res,200,outcome.value);
        const statuses:Record<string,number>={"invalid-request":400,"not-found":404,"request-conflict":409,"invalid-state":409,"unsupported-option":422};
        return json(res,statuses[outcome.error.code]??500,{error:outcome.error});
      };
      if(method==="GET"&&url.pathname==="/v1/completions/openapi.json")return json(res,200,COMPLETION_OPENAPI);
      const completionRoute=/^\/v1\/completions\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if(completionRoute){
        const id=decodeURIComponent(completionRoute[1]!);
        if(method==="GET"&&!completionRoute[2]){
          const record=this.completions.get(id);
          return record?json(res,200,record):json(res,404,{error:{code:"not-found",message:"Completion not found."}});
        }
        if(method==="PUT"&&!completionRoute[2]){
          const outcome=this.completions.submit(id,await body(req));
          if(outcome.ok)void this.reconcile();
          return completionReply(outcome);
        }
        if(method==="POST"&&completionRoute[2]){
          const outcome=this.completions.cancel(id);
          if(outcome.ok&&outcome.value.state==="cancelled")this.stopUnit(this.store.run(outcome.value.runId)?.workerUnit);
          return completionReply(outcome);
        }
      }
      if(method==="GET"&&url.pathname==="/v1/status")return json(res,200,this.status());
      if(method==="GET"&&url.pathname==="/v1/runs")return json(res,200,{runs:this.store.runs(),live:this.store.live()});
      if(method==="GET"&&url.pathname==="/v1/plans")return json(res,200,{accounts:this.store.accounts(),meters:this.store.meters(),leases:this.store.activeLeases(),controls:Object.fromEntries((this.store.db.prepare("SELECT * FROM control").all() as any[]).map((r)=>[r.key,r.value]))});
      if(method==="GET"&&url.pathname.startsWith("/internal/runs/")){
        const parts=url.pathname.split("/"),id=parts[3]!,action=parts[4];const run=this.store.run(id);if(!run)return json(res,404,{error:"run not found"});
        if(action==="completion"&&parts.length===5)return json(res,200,{completion:this.completions.byRun(id)});
        if(action==="control"&&parts.length===5){const results=this.fleet.pending(id);return json(res,200,{abort:this.store.control(`abort:${id}`),...(results.length?{results}:{})});}
        if(parts.length===4)return json(res,200,{run,results:this.fleet.pending(id)});
      }
      if(method==="POST"&&url.pathname.startsWith("/internal/runs/")){
        const parts=url.pathname.split("/"),id=parts[3]!,action=parts[4],input=await body(req);
        if(!this.store.run(id))return json(res,404,{error:"run not found"});
        if(action==="completion"&&parts[5]==="claim")return completionReply(this.completions.claim(id,input.attemptId));
        if(action==="completion"&&parts[5]==="settle")return completionReply(this.completions.settle(id,input.attemptId,input.outcome));
        if(action==="dispatch"){
          const outcome=this.fleet.dispatch(id,input);
          if(!outcome.ok)return json(res,400,{error:outcome.error});
          void this.reconcile();
          return json(res,201,{run:outcome.value});
        }
        if(action==="acknowledge"){
          const outcome=this.fleet.acknowledge(id,input.deliveryIds);
          return outcome.ok?json(res,200,{ok:true}):json(res,400,{error:outcome.error});
        }
        if(action==="state"){
          if(input.state==="done"&&!this.store.run(id)!.context)this.fleet.settle(id,input.result??"");
          else this.store.updateRun(id,input);
          const run=this.store.run(id);
          if(input.cooldownUntil&&run?.accountId)this.store.setCooldown(run.accountId,Number(input.cooldownUntil));
          if(input.activity)this.store.setLive(id,input);
          return json(res,200,{ok:true});
        }
        if(action==="heartbeat"){this.store.heartbeatLease(`run:${id}`);this.store.updateRun(id,{progressAt:input.progress?Date.now():undefined});if(input.activity)this.store.setLive(id,input);return json(res,200,{ok:true});}
      }
      if(method==="POST"&&url.pathname==="/v1/accounts"){
        const input=await body(req);
        this.store.upsertAccount({id:String(input.id),provider:input.provider,label:input.label,enabled:true,concurrency:Number(input.concurrency??this.config.defaultAccountConcurrency)});
        return json(res,201,{ok:true});
      }
      // Suspending an account keeps its credential and its usage history: a
      // lapsed subscription or a login that needs replacing must leave the
      // schedulable pool without discarding the evidence needed to bring it
      // back. Removal is the destructive path and stays separate.
      const accountEnabled=/^\/v1\/accounts\/([^/]+)\/enabled$/.exec(url.pathname);
      if(method==="PUT"&&accountEnabled){
        const id=decodeURIComponent(accountEnabled[1]!),account=this.store.account(id),input=await body(req);
        if(!account)return json(res,404,{error:"account not found"});
        if(typeof input.enabled!=="boolean")return json(res,400,{error:"enabled must be true or false"});
        this.store.setAccountEnabled(id,input.enabled);
        void this.reconcile();
        return json(res,200,{account:this.store.account(id)});
      }
      const accountUse=/^\/v1\/accounts\/([^/]+)\/use$/.exec(url.pathname);
      if(method==="PUT"&&accountUse){
        const id=decodeURIComponent(accountUse[1]!),account=this.store.account(id),input=await body(req);
        if(!account)return json(res,404,{error:"account not found"});
        if(input.use!=="shared"&&input.use!=="voice")return json(res,400,{error:"use must be shared or voice"});
        if(input.use==="voice"&&account.provider!=="openai-codex")return json(res,400,{error:"GPT Live requires an openai-codex account"});
        this.store.setControl(`account-use:${id}`,input.use);
        return json(res,200,{account:this.store.account(id)});
      }
      const accountRemove=/^\/v1\/accounts\/([^/]+)$/.exec(url.pathname);
      if(method==="DELETE"&&accountRemove){this.store.setAccountEnabled(decodeURIComponent(accountRemove[1]!),false);return json(res,200,{ok:true});}
      if(method==="POST"&&(url.pathname==="/v1/run"||url.pathname==="/v1/run/isolated")){
        const input=await body(req);
        if(url.pathname==="/v1/run/isolated"&&input.context===undefined)return json(res,400,{error:"An isolated run requires context.tools"});
        if(input.context!==undefined&&!isRunContext(input.context))return json(res,400,{error:"context requires a tools allowlist and optional absolute application extension paths"});
        if(input.context&&(!input.cwd||!Number.isInteger(input.count??1)||(input.count??1)!==1))return json(res,400,{error:"Isolated runs require an explicit workspace cwd and count 1"});
        const ids=this.store.createRuns({count:Number(input.count??1),source:"direct",prompt:String(input.prompt),cwd:String(input.cwd??process.cwd()),profile:String(input.profile??"standard"),budget:input.force?"force":"background",context:input.context});
        void this.reconcile();return json(res,201,{runIds:ids});
      }
      if(method==="POST"&&url.pathname==="/v1/wave"){const input=await body(req),lane=this.store.lane(String(input.lane));if(!lane)return json(res,404,{error:"lane not found"});const ids=this.store.createRuns({count:Number(input.count??1),source:"direct",sourceId:lane.id,prompt:lane.prompt,cwd:lane.cwd,profile:lane.profile,budget:input.force?"force":"background"});void this.reconcile();return json(res,201,{runIds:ids});}
      const runAbort=/^\/v1\/runs\/([^/]+)\/(abort|kill)$/.exec(url.pathname);if(method==="POST"&&runAbort){const id=runAbort[1]!,action=runAbort[2]!;this.store.setControl(`abort:${id}`,action);const run=this.store.run(id);if(action==="kill"||run?.state==="queued"||run?.state==="waiting"){this.stopUnit(run?.workerUnit);this.store.updateRun(id,{state:"aborted",failureKind:"operator",result:`${action} by operator`});}return json(res,200,{ok:true});}
      if(method==="POST"&&url.pathname==="/v1/control"){const input=await body(req);this.store.setControl(String(input.key),String(input.value));return json(res,200,{ok:true});}
      json(res,404,{error:"not found"});
    }catch(error){json(res,500,{error:String(error)});}
  }

  private status():unknown{return{
    launches:this.store.control("launches")??"enabled",laneBudget:this.laneBudget,
    readinessError:this.store.control("readiness_error")||undefined,
    meterErrors:this.store.accounts().flatMap((account)=>{const error=this.store.control(`meter-error:${account.id}`);return error?JSON.parse(error):[];}),
    capacity:this.store.accounts().map((account)=>({accountId:account.id,...accountCapacity(this.store,account.id,this.laneBudget,this.config)})),
    accounts:this.store.accounts(),lanes:this.store.lanes().map((lane)=>({...lane,active:this.store.admittedLaneCount(lane.id)})),
    runs:this.store.runs(["queued","starting","running","waiting"]),leases:this.store.activeLeases(),
  };}
}
