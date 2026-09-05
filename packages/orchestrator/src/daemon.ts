import { execFile, spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LaneReadiness, LaneManifest, LaneSpec, OrchestratorConfig, Run } from "./domain.js";
import { accountCapacity, assign, commitMeterAdmission } from "./policy.js";
import { Store } from "./store.js";
import { CodexMeterSampler } from "./meters-codex.js";
import { AnthropicMeterSampler } from "./meters-anthropic.js";
import { ORCHESTRATOR_CATALOG } from "./catalog.js";

const HOST=process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1";
const PORT=Number(process.env.PI_ORCHESTRATOR_PORT??"2460");

function json(res:ServerResponse,status:number,body:unknown):void{const text=JSON.stringify(body);res.writeHead(status,{"content-type":"application/json","content-length":Buffer.byteLength(text)});res.end(text);}
async function body(req:IncomingMessage):Promise<any>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{};}
function exec(command:string,cwd?:string,timeout=30_000):Promise<string>{return new Promise((resolve,reject)=>execFile("bash",["-lc",command],{cwd,timeout,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr.trim()||error.message)):resolve(stdout.trim())));}

export class Daemon {
  private manifestMtime=0;
  private snapshotCommand?:string;
  private readinessAt=0;
  private readiness?:LaneReadiness;
  private reconciling=false;
  private stopped=false;
  private releasePath:string;
  private readonly ledgerPath:string;
  private readonly codexMeters:CodexMeterSampler;
  private readonly anthropicMeters:AnthropicMeterSampler;

  constructor(readonly store:Store,readonly config:OrchestratorConfig,releasePath?:string,ledgerPath?:string){
    this.releasePath=releasePath??dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
    this.ledgerPath=ledgerPath||process.env.PI_ORCHESTRATOR_LEDGER||join(homedir(),".local/share/pi-orchestrator/ledger.sqlite3");
    this.codexMeters=new CodexMeterSampler(store,{authPaths:[config.authPath],meters:ORCHESTRATOR_CATALOG.meters.filter((meter)=>meter.provider==="openai-codex")});
    this.anthropicMeters=new AnthropicMeterSampler(store,{agentDir:config.agentDir,sharedAuthPath:config.authPath});
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
    this.recoverWorkers();
    const server=createServer((req,res)=>void this.request(req,res));
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(PORT,HOST,resolve);});
    const timer=setInterval(()=>void this.reconcile().catch((error)=>console.error("reconcile:",error)),this.config.reconcileIntervalMs);
    await this.reconcile();
    console.log(`pi-orchestrator daemon listening on ${HOST}:${PORT}`);
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
    for(const key of Object.keys(manifest))if(!["version","lanes","snapshotCommand"].includes(key))throw new Error(`unsupported lane manifest field ${key}`);
    const lanes=manifest.lanes.map((lane)=>{if("prompt" in lane)return lane;const {promptFile,...spec}=lane;return{...spec,prompt:readFileSync(resolve(dirname(path),promptFile),"utf8")};});
    this.store.reconcileLanes(lanes);
    this.snapshotCommand=manifest.snapshotCommand;
    this.readinessAt=0;this.readiness=undefined;
    this.manifestMtime=mtime;
  }

  async reconcile():Promise<void>{
    if(this.reconciling||this.stopped)return;this.reconciling=true;
    try{
      await this.loadManifest();
      await Promise.all([this.codexMeters.sample(),this.anthropicMeters.sample()]);
      await this.refreshReadiness();
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
        const choice=assign(this.store,lane.profile,"background",this.config);
        if(!choice.assignment){this.store.setControl(`refusal:${key}`,choice.refusals.map((r)=>`${r.accountId}: ${r.reason}`).join("; "));continue;}
        try{
          const prompt=await this.lanePrompt(lane);
          const [id]=this.store.createRuns({count:1,source:"lane",sourceId:lane.id,prompt,cwd:lane.cwd,profile:lane.profile,budget:"background"});
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
    const choice=assign(this.store,run.profile,run.budget,this.config,Date.now());
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
    for(const name of ["PATH","PYTHONPATH","CPATH","LIBRARY_PATH","PKG_CONFIG_PATH","PI_ORCHESTRATOR_CONFIG","PI_MCP_SIZE_ALERTS_INBOX","PI_MCP_SIZE_ALERT_COMMAND"]){
      const value=process.env[name];if(value!==undefined)args.push(`--setenv=${name}=${value}`);
    }
    args.push(process.execPath,cli,"worker",runId);
    if(process.env.PI_ORCHESTRATOR_WORKER_LAUNCH==="process"){
      const child=spawn(process.execPath,[cli,"worker",runId],{detached:true,stdio:"ignore",env:{...process.env,PI_ORCHESTRATOR_ASSIGNED:"1"}});child.unref();return;
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
      if(method==="GET"&&url.pathname==="/v1/status")return json(res,200,this.status());
      if(method==="GET"&&url.pathname==="/v1/runs")return json(res,200,{runs:this.store.runs(),live:this.store.live()});
      if(method==="GET"&&url.pathname==="/v1/plans")return json(res,200,{accounts:this.store.accounts(),meters:this.store.meters(),leases:this.store.activeLeases(),controls:Object.fromEntries((this.store.db.prepare("SELECT * FROM control").all() as any[]).map((r)=>[r.key,r.value]))});
      if(method==="GET"&&url.pathname.startsWith("/internal/runs/")){
        const parts=url.pathname.split("/"),id=parts[3]!,action=parts[4];const run=this.store.run(id);if(!run)return json(res,404,{error:"run not found"});
        if(action==="control"&&parts.length===5)return json(res,200,{abort:this.store.control(`abort:${id}`)});
        if(parts.length===4)return json(res,200,{run});
      }
      if(method==="POST"&&url.pathname.startsWith("/internal/runs/")){
        const parts=url.pathname.split("/"),id=parts[3]!,action=parts[4],input=await body(req);
        if(action==="state"){
          this.store.updateRun(id,input);
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
      if(method==="POST"&&url.pathname==="/v1/run"){const input=await body(req);const ids=this.store.createRuns({count:Number(input.count??1),source:"direct",prompt:String(input.prompt),cwd:String(input.cwd??process.cwd()),profile:String(input.profile??"standard"),budget:input.force?"force":"background"});void this.reconcile();return json(res,201,{runIds:ids});}
      if(method==="POST"&&url.pathname==="/v1/wave"){const input=await body(req),lane=this.store.lane(String(input.lane));if(!lane)return json(res,404,{error:"lane not found"});const ids=this.store.createRuns({count:Number(input.count??1),source:"direct",sourceId:lane.id,prompt:lane.prompt,cwd:lane.cwd,profile:lane.profile,budget:input.force?"force":"background"});void this.reconcile();return json(res,201,{runIds:ids});}
      const runAbort=/^\/v1\/runs\/([^/]+)\/(abort|kill)$/.exec(url.pathname);if(method==="POST"&&runAbort){const id=runAbort[1]!,action=runAbort[2]!;this.store.setControl(`abort:${id}`,action);const run=this.store.run(id);if(action==="kill"||run?.state==="queued"){this.stopUnit(run?.workerUnit);this.store.updateRun(id,{state:"aborted",failureKind:"operator",result:`${action} by operator`});}return json(res,200,{ok:true});}
      if(method==="POST"&&url.pathname==="/v1/control"){const input=await body(req);this.store.setControl(String(input.key),String(input.value));return json(res,200,{ok:true});}
      json(res,404,{error:"not found"});
    }catch(error){json(res,500,{error:String(error)});}
  }

  private status():unknown{return{launches:this.store.control("launches")??"enabled",readinessError:this.store.control("readiness_error")||undefined,capacity:this.store.accounts().map((account)=>({accountId:account.id,...accountCapacity(this.store,account.id,"background",this.config)})),accounts:this.store.accounts(),lanes:this.store.lanes().map((lane)=>({...lane,active:this.store.admittedLaneCount(lane.id)})),runs:this.store.runs(["queued","starting","running"]),leases:this.store.activeLeases()};}
}
