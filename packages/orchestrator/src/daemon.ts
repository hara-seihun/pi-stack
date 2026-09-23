import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BudgetClass, LaneReadiness, LaneManifest, LaneSpec, OrchestratorConfig, Run } from "./domain.js";
import { isRunContext } from "./isolated-context-contract.js";
import { accountCapacity, assign, assignCompletion } from "./policy.js";
import { Store } from "./store.js";
import { Fleet } from "./fleet.js";
import { CompletionService } from "./completion.js";
import { CompletionPool } from "./host/completion-pool.js";
import { accountReservation, isAccountReservation, prioritizeReservedCompletions, reservationKey } from "./admission-reservation.js";
import { COMPLETION_OPENAPI } from "./completion-openapi.js";
import { reconcileCompletionReceipts } from "./host/completion-receipts.js";
import type { CompletionOutcome } from "./completion-contract.js";
import { CodexMeterSampler } from "./meters-codex.js";
import { AnthropicMeterSampler } from "./meters-anthropic.js";
import { ORCHESTRATOR_CATALOG } from "./catalog.js";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerOAuth } from "./auth/shared-oauth.js";
import { ThreadService } from "./threads/service.js";
import { createSharedPiSessionOpener } from "./threads/runner-transport.js";
import { createThreadClient, threadHttp } from "./threads/http.js";
import { importFleetThreads } from "./threads/import.js";
import type { SettingsOverrides, Thread } from "./threads/contracts.js";
import { ThreadDirectory } from "./threads/directory.js";
import { resolveThreadSettings } from "./threads/settings.js";
import type { RunContext } from "./domain.js";
import { ScheduleService, scheduleHttp } from "./schedule.js";

const HOST=process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1";

function json(res:ServerResponse,status:number,body:unknown):void{const text=JSON.stringify(body);res.writeHead(status,{"content-type":"application/json","content-length":Buffer.byteLength(text)});res.end(text);}
async function body(req:IncomingMessage):Promise<any>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{};}
function exec(command:string,cwd?:string,timeout=30_000):Promise<string>{return new Promise((resolve,reject)=>execFile("bash",["-lc",command],{cwd,timeout,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr.trim()||error.message)):resolve(stdout.trim())));}

export class Daemon {
  private manifestMtime=0;
  private laneBudget:BudgetClass="force";
  private snapshotCommand?:string;
  private readinessAt=0;
  private readiness?:LaneReadiness;
  private repairReadiness=new Map<string,{at:number;revision?:string;ready:boolean}>();
  private reconciling=false;
  private stopped=false;
  private releasePath:string;
  private readonly ledgerPath:string;
  private readonly port:number;
  private readonly codexMeters?:CodexMeterSampler;
  private readonly anthropicMeters?:AnthropicMeterSampler;
  private readonly fleet:Fleet;
  private readonly completions:CompletionService;
  private readonly completionPool:CompletionPool;
  private readonly schedules:ScheduleService;
  readonly threads:ThreadService;
  private readonly isolated=new Map<string,ThreadService>();
  private readonly opener:ReturnType<typeof createSharedPiSessionOpener>;

  constructor(readonly store:Store,readonly config:OrchestratorConfig,releasePath?:string,ledgerPath?:string){
    this.fleet=new Fleet(store,config);
    this.completions=new CompletionService(store,process.cwd());
    this.completionPool=new CompletionPool(store,this.completions,config);
    this.releasePath=releasePath??dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
    this.ledgerPath=ledgerPath??store.path;
    this.port=config.port??2460;
    const dataDir=this.ledgerPath===":memory:"?tmpdir():dirname(this.ledgerPath);
    const threadDatabasePath=this.ledgerPath===":memory:"?":memory:":join(dataDir,"threads.sqlite3");
    this.opener=createSharedPiSessionOpener({dataDir,durable:true});
    this.threads=new ThreadService({workersOnly:true,databasePath:threadDatabasePath,sessionsDir:join(dataDir,"threads"),
      attachSession:this.opener.attachSession,
      openSession:(options,output,exit)=>{
        const context=this.threads.get(options.threadId)?.metadata?.context;
        if(context)throw new Error("An isolated thread must be imported into its application ThreadService before execution");
        return this.opener.openSession(options,output,exit);
      },
      environment:thread=>this.threadEnvironment(thread),admit:(...args)=>this.fleet.admit(...args)});
    this.schedules=new ScheduleService({databasePath:threadDatabasePath,threads:this.threads});
    this.threads.subscribe(event=>{if("event" in event)this.fleet.event(event.threadId,event.event);});
    if(!config.modelBrokerUrl){
      this.codexMeters=new CodexMeterSampler(store,{auth:providerOAuth(openaiCodexProvider(),config.authPath),meters:ORCHESTRATOR_CATALOG.meters.filter((meter)=>meter.provider==="openai-codex")});
      this.anthropicMeters=new AnthropicMeterSampler(store,{auth:providerOAuth(anthropicProvider(),config.authPath)});
    }
  }

  async start():Promise<void>{
    await this.loadManifest();
    if(!this.config.modelBrokerUrl)reconcileCompletionReceipts(this.completions,join(this.config.agentDir,"completion-receipts"));
    for(const row of this.store.db.prepare("SELECT value FROM control WHERE key LIKE 'thread-boundary:%'").all() as {value:string}[]){const boundary=JSON.parse(row.value);this.isolatedService(boundary.cwd,boundary.context);}
    const imported=importFleetThreads(this.threads,this.store.db,{sessionsDir:join(dirname(this.ledgerPath),"threads"),
      settingsForProfile:profile=>{const settings=resolveThreadSettings({model:this.profileModel(profile)});if(!settings.ok)throw new Error(settings.error.message);return settings.value;},
      selectService:thread=>thread.metadata?.context?this.isolatedService(thread.cwd,thread.metadata.context as RunContext).service:this.threads,
      services:()=>[...this.isolated.values()]});
    if(!imported.ok)throw new Error(imported.error.message);
    if(!this.config.modelBrokerUrl)for(const run of this.store.runs(["queued","starting","running"]))if(this.completionPool.owns(run))this.completionPool.start(run);
    const server=createServer((req,res)=>void this.request(req,res));
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(this.port,this.config.listenHost??HOST,resolve);});
    for(const service of this.isolated.values()){const result=await service.start();if(!result.ok)throw new Error(result.error.message);}
    this.directory();
    const started=await this.threads.start();if(!started.ok)throw new Error(started.error.message);
    const timer=setInterval(()=>void this.reconcile().catch((error)=>console.error("reconcile:",error)),this.config.reconcileIntervalMs);
    const completionTimer=setInterval(()=>this.completionPool.tick(),1_000);
    await this.reconcile();
    console.log(`pi-orchestrator daemon listening on ${this.config.listenHost??HOST}:${this.port}`);
    await new Promise<void>((resolve)=>{for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,resolve);});
    this.stopped=true;clearInterval(timer);clearInterval(completionTimer);
    await this.waitForReconcile();
    await this.completionPool.close();
    this.threads.suspend();
    const detached=await this.threads.detach();if(!detached.ok)throw new Error(detached.error.message);
    await this.schedules.close();
    for(const service of this.isolated.values()){const result=await service.detach();if(!result.ok)throw new Error(result.error.message);}
    this.opener.detach();
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
    const budget=manifest.budget===undefined?"force":manifest.budget;
    if(budget!=="background"&&budget!=="force")throw new Error("lane manifest budget must be background or force");
    if(manifest.snapshotCommand!==undefined&&(typeof manifest.snapshotCommand!=="string"||!manifest.snapshotCommand.trim()))throw new Error("snapshotCommand must be a non-empty command");
    const lanes=manifest.lanes.map((lane)=>{if("prompt" in lane)return lane;const {promptFile,...spec}=lane;return{...spec,prompt:readFileSync(resolve(dirname(path),promptFile),"utf8")};});
    if(this.config.modelBrokerUrl&&lanes.some(lane=>lane.repair))throw new Error("Root-repair lanes are unavailable when this daemon uses a model broker");
    this.store.reconcileLanes(lanes.map(lane=>({...lane,admission:lane.admission??budget})));
    this.laneBudget=budget;
    this.snapshotCommand=manifest.snapshotCommand;
    if(!this.snapshotCommand)this.store.setControl("readiness_error","");
    this.readinessAt=0;this.readiness=undefined;this.repairReadiness.clear();
    this.manifestMtime=mtime;
  }

  async reconcile():Promise<void>{
    if(this.reconciling||this.stopped)return;this.reconciling=true;
    try{
      await this.loadManifest();
      if(!this.config.modelBrokerUrl)reconcileCompletionReceipts(this.completions,join(this.config.agentDir,"completion-receipts"));
      const samples=this.codexMeters&&this.anthropicMeters?(await Promise.all([this.codexMeters.sample(),this.anthropicMeters.sample()])).flat():[];
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
        // A refused reset-credit balance leaves metering intact, so it is
        // reported by the sampler without holding the account in a meter alarm.
        const failures=observed.filter((sample)=>sample.outcome!=="recorded"&&sample.outcome!=="stale-reading"&&sample.outcome!=="reset-credits-unreadable");
        const key=`meter-error:${account.id}`,error=failures.length?JSON.stringify(failures):"";
        if(error!==(this.store.control(key)??"")){
          this.store.setControl(key,error);
          console.error(`meter ${account.id}: ${error||"recovered"}`);
        }
      }
      await Promise.all([this.refreshReadiness(),this.refreshRepairReadiness()]);
      if(!this.config.modelBrokerUrl)for(const run of prioritizeReservedCompletions(this.store,this.store.admissionQueue())){
        if(this.completions.byRun(run.id))await this.launch(run);
      }
      this.threads.reconcile();
      await this.schedules.reconcile();
      await this.fillCapacity();
    }finally{this.reconciling=false;}
  }

  private async refreshReadiness():Promise<void>{
    if(!this.snapshotCommand||Date.now()-this.readinessAt<30_000)return;
    this.readinessAt=Date.now();
    try{
      const snapshot=JSON.parse(await exec(this.snapshotCommand)) as LaneReadiness;
      if(typeof snapshot.revision!=="string"||!snapshot.lanes||typeof snapshot.lanes!=="object"||Array.isArray(snapshot.lanes))throw new Error("invalid lane readiness snapshot");
      for(const [id,value] of Object.entries(snapshot.lanes))if(!value||typeof value.ready!=="boolean"||Object.keys(value).some((key)=>key!=="ready"))throw new Error(`lane ${id} requires ready: boolean, not a worker count`);
      for(const lane of this.store.lanes().filter(lane=>!lane.repair))if(!Object.hasOwn(snapshot.lanes,lane.id))throw new Error(`readiness snapshot omitted lane ${lane.id}`);
      this.readiness=snapshot;this.store.setControl("readiness_error","");
    }catch(error){this.readiness=undefined;this.store.setControl("readiness_error",String(error));}
  }

  private async refreshRepairReadiness():Promise<void>{
    await Promise.all(this.store.lanes().filter(lane=>lane.repair).map(async lane=>{
      const previous=this.repairReadiness.get(lane.id);
      if(previous&&Date.now()-previous.at<30_000)return;
      const at=Date.now();
      try{
        const probe=JSON.parse(await exec(lane.repair!.readinessCommand)) as {revision:string;ready:boolean};
        if(!probe||typeof probe.revision!=="string"||typeof probe.ready!=="boolean"||Object.keys(probe).some(key=>key!=="revision"&&key!=="ready"))throw new Error("repair readiness requires {revision:string,ready:boolean}");
        this.repairReadiness.set(lane.id,{at,...probe});this.store.setControl(`repair-readiness-error:${lane.id}`,"");
      }catch(error){this.repairReadiness.set(lane.id,{at,ready:false});this.store.setControl(`repair-readiness-error:${lane.id}`,String(error));}
    }));
  }

  private laneReady(id:string):boolean{
    if(this.store.lane(id)?.repair){
      if(this.config.modelBrokerUrl)return false;
      const probe=this.repairReadiness.get(id);
      return !this.threads.snapshot().some(thread=>thread.metadata?.execution==="root-repair"&&thread.state==="running")&&probe?.ready===true&&Number(this.store.control(`readiness-admitted:${id}`)??0)<probe.at;
    }
    return this.store.control("ordinary-launches")!=="paused"&&(!this.snapshotCommand||(this.readiness?.lanes[id]?.ready===true&&Number(this.store.control(`readiness-admitted:${id}`)??0)<this.readinessAt));
  }

  private laneEnabled(id:string):boolean{return !!this.store.lane(id)&&this.store.control(`complete:${id}`)===undefined;}

  private share(lane:LaneSpec):number{
    return (1+this.laneActive(lane.id))/lane.weight;
  }

  private async fillCapacity():Promise<void>{
    if(this.store.control("launches")==="paused")return;
    const failed=new Set<string>();
    for(let slot=0;slot<this.config.maxConcurrentSessions;slot++){
      if(this.threads.snapshot().filter(thread=>thread.state==="running").length>=this.config.maxConcurrentSessions)break;
      const lanes=this.store.lanes().filter((lane)=>this.laneEnabled(lane.id)&&this.laneReady(lane.id));
      lanes.sort((a,b)=>Number(!!b.repair)-Number(!!a.repair)||this.share(a)-this.share(b)||a.id.localeCompare(b.id));
      let admitted=false;
      for(const lane of lanes){
        const key=`lane:${lane.id}`;
        if(failed.has(key))continue;
        const choice=this.config.modelBrokerUrl?undefined:assign(this.store,lane.profile,lane.repair?"force":lane.admission??"force",this.config,Date.now(),undefined,undefined,lane.repair?"root-repair":"user");
        if(choice&&!choice.assignment){this.store.setControl(`refusal:${key}`,choice.refusals.map(r=>`${r.accountId}: ${r.reason}`).join("; "));continue;}
        try{
          const prompt=await this.lanePrompt(lane);
          const spawned=await this.threads.spawn({requestId:crypto.randomUUID(),cwd:lane.cwd,title:lane.id,message:prompt,
            settings:this.laneSettings(lane,choice?.assignment&&`${choice.assignment.provider}/${choice.assignment.model}`),admission:lane.repair?"force":lane.admission??"force",
            metadata:{source:"lane",laneId:lane.id,execution:lane.repair?"root-repair":"user"}});
          if(!spawned.ok)throw new Error(spawned.error.message);
          if(lane.repair||this.snapshotCommand)this.store.setControl(`readiness-admitted:${lane.id}`,String(lane.repair?this.repairReadiness.get(lane.id)!.at:this.readinessAt));
          this.store.setControl(`refusal:${key}`,"");
        }catch(error){failed.add(key);this.store.setControl(`refusal:${key}`,String(error));continue;}
        admitted=true;break;
      }
      if(!admitted)break;
    }
  }

  /** A lane's declared thinking level belongs to every worker it starts, not just the first. */
  private laneSettings(lane:LaneSpec,model?:string):SettingsOverrides{
    return{model:model??this.profileModel(lane.profile),...(lane.thinkingLevel?{thinkingLevel:lane.thinkingLevel}:{})};
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

  private isolatedService(cwd:string,context:RunContext):{id:string;service:ThreadService}{
    const id=createHash("sha256").update(JSON.stringify({cwd,context})).digest("hex").slice(0,24);
    let service=this.isolated.get(id);
    if(!service){
      const dataDir=join(dirname(this.ledgerPath),"applications",id);
      service=new ThreadService({workersOnly:true,databasePath:this.ledgerPath===":memory:"?":memory:":join(dataDir,"threads.sqlite3"),sessionsDir:join(dataDir,"threads"),
        attachSession:this.opener.attachSession,
        openSession:(options,output,exit)=>this.opener.openSession({...options,args:[...options.args,"--orchestrator-context",JSON.stringify(context)]},output,exit),
        environment:thread=>({...this.threadEnvironment(thread),PI_THREAD_API_URL:`http://127.0.0.1:${this.port}/v1/applications/${id}/threads`}),
        admit:(...args)=>this.fleet.admit(...args)});
      service.subscribe(event=>{if("event" in event)this.fleet.event(event.threadId,event.event);});
      this.isolated.set(id,service);
      this.store.setControl(`thread-boundary:${id}`,JSON.stringify({cwd,context}));
    }
    return{id,service};
  }
  private directory():ThreadDirectory{
    const owners=[...this.isolated].map(([id,api])=>({id,api:api as import("./threads/contracts.js").ThreadApi}));
    const path=process.env.PI_STACK_HOST_CONFIG??"/etc/pi-stack/host.json",person=userInfo().username;
    const registryPath=join("/var/lib/pi-remote/persons",`${person}.json`);
    const fleetOwner=existsSync(path)&&JSON.parse(readFileSync(path,"utf8")).fleetUser===person;
    if(existsSync(registryPath)&&(fleetOwner||!!this.config.modelBrokerUrl)){
      const environment=process.env.PI_REMOTE_THREAD_OWNER_URL?undefined:JSON.parse(readFileSync(registryPath,"utf8")).environment;
      const port=Number(environment?.PI_REMOTE_PORT);
      if(!process.env.PI_REMOTE_THREAD_OWNER_URL&&(!Number.isInteger(port)||port<1||port>65535))throw new Error(`Registered person ${registryPath} has no valid PI_REMOTE_PORT`);
      const url=new URL(process.env.PI_REMOTE_THREAD_OWNER_URL??`http://${environment?.PI_REMOTE_HOST??"127.0.0.1"}:${port}/v1/thread-owner`);
      if(!["http:","https:"].includes(url.protocol)||url.pathname!=="/v1/thread-owner")throw new Error("PI_REMOTE_THREAD_OWNER_URL must name the authorized person's local /v1/thread-owner endpoint");
      owners.push({id:"person",api:createThreadClient(url.toString().replace(/\/$/,""))});
    }
    const directory=new ThreadDirectory({id:"fleet",api:this.threads},owners);
    this.threads.setDirectory(directory);
    return directory;
  }
  private laneActive(laneId:string):number{return this.threads.snapshot().filter(thread=>thread.metadata?.laneId===laneId&&thread.state==="running").length;}
  private profileModel(profile:string):string{
    const candidate=this.config.profiles[profile]?.[0];
    if(!candidate)throw new Error(`Unknown model profile ${profile}`);
    return `${candidate.provider}/${candidate.model}`;
  }
  private threadEnvironment(thread:Thread):Record<string,string|undefined>{
    const shared={HOME:process.env.HOME??homedir(),PI_CODING_AGENT_DIR:this.config.agentDir,PI_ORCHESTRATOR_LEDGER:this.ledgerPath,
      PI_BASH_TIMEOUT_MAX_SECONDS:"55",PI_ORCHESTRATOR_EXECUTION:String(thread.metadata?.execution??"user"),
      PI_THREAD_API_URL:`http://127.0.0.1:${this.port}/v1/threads`,PI_THREAD_ADMISSION:thread.admission};
    return this.config.modelBrokerUrl?{...shared,PI_MODEL_BROKER_URL:this.config.modelBrokerUrl,PI_ORCHESTRATOR_ASSIGNED:"0"}
      :{...shared,PI_ORCHESTRATOR_AUTH:this.config.authPath};
  }
  private async launch(run:Run):Promise<boolean>{
    const choice=assignCompletion(this.store,run.id,run.profile,this.config);
    if(!choice.assignment){this.store.setControl(`refusal:${run.id}`,choice.refusals.map(r=>`${r.accountId}: ${r.reason}`).join("; "));return false;}
    if(!this.store.assignRun(run.id,{...choice.assignment,unit:`completion:${run.id}`,releasePath:this.releasePath}))return false;
    this.store.setControl(`refusal:${run.id}`,"");this.completionPool.start(this.store.run(run.id)!);return true;
  }

  private async request(req:IncomingMessage,res:ServerResponse):Promise<void>{
    try{
      const url=new URL(req.url??"/",`http://${HOST}:${this.port}`),method=req.method??"GET";
      const application=/^\/v1\/applications\/([a-f0-9]+)\/threads\//.exec(url.pathname);
      const localOwner=url.pathname.startsWith("/v1/thread-owner/");
      if(url.pathname.startsWith("/v1/threads/")||localOwner||application){
        const input=method==="POST"?await body(req):undefined;
        if(this.config.modelBrokerUrl&&input?.metadata?.execution==="root-repair")return json(res,403,{error:"Root repair is unavailable when this daemon uses a model broker"});
        let api=application?this.isolated.get(application[1]!):localOwner?this.threads:this.directory();
        if(!api)return json(res,404,{error:"Application thread boundary not found"});
        if(!application&&url.pathname==="/v1/threads/spawn"&&input?.metadata?.context){
          if(!isRunContext(input.metadata.context)||!input.cwd?.startsWith("/"))return json(res,400,{error:"Isolated threads require absolute cwd and a valid context"});
          if(input.parentId)return json(res,400,{error:"Spawn children through their parent's application boundary"});
          const boundary=this.isolatedService(input.cwd,input.metadata.context);
          const started=await boundary.service.start();if(!started.ok)return json(res,503,started);
          api=boundary.service;
        }
        const cancellation=new AbortController(),cancel=()=>cancellation.abort();
        res.once("close",cancel);
        if(res.destroyed)cancel();
        try{
          const headers=new Headers(Object.entries(req.headers).flatMap(([key,value])=>value===undefined?[]:[[key,Array.isArray(value)?value.join(","):value] as [string,string]]));
          const response=await threadHttp(api,new Request(url,{method,headers,signal:cancellation.signal,...(method==="POST"?{body:JSON.stringify(input)}:{})}),application?`/v1/applications/${application[1]}/threads`:localOwner?"/v1/thread-owner":"/v1/threads");
          if(res.destroyed)return;
          if(response){res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}
        }finally{res.off("close",cancel);}
      }
      if(url.pathname==="/v1/schedules"||url.pathname.startsWith("/v1/schedules/")){
        const headers=new Headers(Object.entries(req.headers).flatMap(([key,value])=>value===undefined?[]:[[key,Array.isArray(value)?value.join(","):value] as [string,string]]));
        const response=await scheduleHttp(this.schedules,new Request(url,{method,headers,...(["POST","PUT","PATCH"].includes(method)?{body:JSON.stringify(await body(req))}:{})}));
        if(response){res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}
      }
      if(method==="POST"&&(url.pathname==="/v1/run"||url.pathname==="/v1/run/isolated")){
        const input=await body(req),count=input.count??1;
        if(typeof input.prompt!=="string"||!input.prompt.trim()||typeof input.cwd!=="string"||!input.cwd.startsWith("/")||!Number.isInteger(count)||count<1||count>100||input.core!==undefined)
          return json(res,400,{error:"Expected prompt, absolute cwd and count 1..100"});
        const isolated=url.pathname.endsWith("/isolated");
        if(isolated&&!isRunContext(input.context)||!isolated&&input.context)return json(res,400,{error:"Application context requires the isolated endpoint and a valid tool list"});
        const owner=isolated?this.isolatedService(input.cwd,input.context).service:this.threads;
        const started=await owner.start();if(!started.ok)return json(res,503,started);
        const settings=resolveThreadSettings({model:input.model??this.profileModel(input.profile??"standard"),thinkingLevel:input.thinkingLevel,speed:input.speed});
        if(!settings.ok)return json(res,400,settings);
        const runIds:string[]=[];
        for(let index=0;index<count;index++){
          const result=await owner.spawn({requestId:input.requestId?`${input.requestId}:${index}`:randomUUID(),cwd:input.cwd,title:input.profile??"Assignment",message:input.prompt,
            settings:settings.value,admission:input.force===false?"background":"force",metadata:{source:"direct",profile:input.profile,context:isolated?input.context:undefined}});
          if(!result.ok)return json(res,409,result);runIds.push(result.value.id);
        }
        return json(res,202,{runIds});
      }
      const completionReply=(outcome:CompletionOutcome<unknown>)=>{
        if(outcome.ok)return json(res,200,outcome.value);
        const statuses:Record<string,number>={"invalid-request":400,"not-found":404,"request-conflict":409,"invalid-state":409,"unsupported-option":422};
        return json(res,statuses[outcome.error.code]??500,{error:outcome.error});
      };
      if(method==="GET"&&url.pathname==="/v1/completions/openapi.json")return json(res,200,COMPLETION_OPENAPI);
      const completionRoute=/^\/v1\/completions\/([^/]+)(\/(?:cancel|retry|attempts))?$/.exec(url.pathname);
      if(this.config.modelBrokerUrl&&completionRoute)return json(res,403,{error:{code:"unsupported-option",message:"Submit completions to this person's configured model broker endpoint."}});
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
        if(method==="GET"&&completionRoute[2]==="/attempts"){
          const attempts=this.completions.attempts(id);return attempts?json(res,200,{attempts}):json(res,404,{error:{code:"not-found",message:"Completion not found."}});
        }
        if(method==="POST"&&completionRoute[2]==="/retry"){
          const outcome=this.completions.retry(id);if(outcome.ok)void this.reconcile();return completionReply(outcome);
        }
        if(method==="POST"&&completionRoute[2]==="/cancel"){
          const outcome=this.completions.cancel(id);
          if(outcome.ok&&outcome.value.state==="cancelled")this.completionPool.tick();
          return completionReply(outcome);
        }
      }
      if(method==="GET"&&url.pathname==="/v1/status")return json(res,200,this.status());
      if(method==="GET"&&url.pathname==="/v1/plans")return json(res,200,{accounts:this.store.accounts(),meters:this.store.meters(),leases:this.store.activeLeases(),controls:Object.fromEntries((this.store.db.prepare("SELECT key,value FROM control INDEXED BY sqlite_autoindex_control_1 WHERE key NOT GLOB 'completion:*' AND key NOT GLOB 'completion-attempt:*' AND key NOT GLOB 'completion-receipt:*' AND key NOT GLOB 'completion-recovery:*' AND key NOT GLOB 'run-context:*' AND key NOT GLOB 'run-core:*' AND key NOT GLOB 'run-environment:*' AND key NOT GLOB 'run-execution:*' AND key NOT GLOB 'run-usage:*' AND key NOT GLOB 'fleet-child:*'").all() as any[]).map((r)=>[r.key,r.value]))});
      if(method==="POST"&&url.pathname==="/v1/accounts"){
        const input=await body(req);
        this.store.upsertAccount({id:String(input.id),provider:input.provider,label:input.label,enabled:true,concurrency:Number(input.concurrency??this.config.defaultAccountConcurrency)});
        return json(res,201,{ok:true});
      }
      // Suspending an account keeps its credential and its usage history: a
      // lapsed subscription or a login that needs replacing must leave the
      // schedulable pool without discarding the evidence needed to bring it
      // back. Removal is the destructive path and stays separate.
      const reservationRoute=/^\/v1\/accounts\/([^/]+)\/reservation$/.exec(url.pathname);
      if(reservationRoute){
        const id=decodeURIComponent(reservationRoute[1]!);
        if(method==="GET")return json(res,200,{reservation:accountReservation(this.store,id)??null});
        if(method==="PUT"){
          const input=await body(req);
          if(!isAccountReservation(input))return json(res,400,{error:"Expected nonempty completion metadata string selectors and a reservation reason"});
          this.store.setControl(reservationKey(id),JSON.stringify(input));
          return json(res,200,{reservation:input});
        }
        if(method==="DELETE"){
          this.store.setControl(reservationKey(id),"");
          return json(res,200,{reservation:null});
        }
      }
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
      if(method==="POST"&&url.pathname==="/v1/wave"){
        const input=await body(req),lane=this.store.lane(String(input.lane));
        if(!lane)return json(res,404,{error:"lane not found"});
        if(lane.repair)return json(res,400,{error:"Repair lanes admit only from their independent readiness probe"});
        const count=input.count??1;if(!Number.isInteger(count)||count<1||count>100)return json(res,400,{error:"count must be between 1 and 100"});
        const threads:Thread[]=[];
        for(let i=0;i<count;i++){
          const result=await this.threads.spawn({requestId:crypto.randomUUID(),cwd:lane.cwd,title:lane.id,message:await this.lanePrompt(lane),
            settings:{...this.laneSettings(lane),...input.settings},admission:input.admission??lane.admission??"force",metadata:{source:"direct",laneId:lane.id}});
          if(!result.ok)return json(res,400,result);threads.push(result.value);
        }
        return json(res,201,{threads});
      }
      if(method==="POST"&&url.pathname==="/v1/control"){const input=await body(req);this.store.setControl(String(input.key),String(input.value));return json(res,200,{ok:true});}
      json(res,404,{error:"not found"});
    }catch(error){json(res,500,{error:String(error)});}
  }

  private status():unknown{return{
    launches:this.store.control("launches")??"enabled",ordinaryLaunches:this.store.control("ordinary-launches")??"enabled",repairOwner:this.threads.snapshot().find(thread=>thread.metadata?.execution==="root-repair"&&thread.state==="running")?.id,laneBudget:this.laneBudget,
    repairReadiness:this.store.lanes().filter(lane=>lane.repair).map(lane=>({lane:lane.id,...this.repairReadiness.get(lane.id),error:this.store.control(`repair-readiness-error:${lane.id}`)||undefined})),
    readinessError:this.store.control("readiness_error")||undefined,
    meterErrors:this.store.accounts().flatMap((account)=>{const error=this.store.control(`meter-error:${account.id}`);return error?JSON.parse(error):[];}),
    capacity:this.store.accounts().map((account)=>({accountId:account.id,...accountCapacity(this.store,account.id,this.laneBudget,this.config)})),
    accounts:this.store.accounts(),lanes:this.store.lanes().map((lane)=>({...lane,active:this.laneActive(lane.id)})),
    threads:this.threads.snapshot(),leases:this.store.activeLeases(),
  };}
}
