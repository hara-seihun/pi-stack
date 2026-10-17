import {constants,fstatSync,lstatSync,readdirSync,realpathSync,renameSync,rmSync,mkdirSync,openSync,closeSync,fsyncSync,readlinkSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** @typedef {'invalid-generated-request'|'unsafe-generated-path'|'generated-identity-changed'|'generated-reference-active'|'generated-safety-unknown'|'generated-custody-required'|'generated-operation-conflict'|'generated-io-error'} GeneratedErrorCode */
export class GeneratedRetirementError extends Error {
  constructor(code,detail) {super(detail);this.code=code;}
}
const refuse=(code,detail)=>{throw new GeneratedRetirementError(code,detail);};
const canonical=value=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const optionalStat=p=>{try{return lstatSync(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const identity=s=>({device:String(s.dev),inode:String(s.ino)});
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function syncDirectory(p) {const fd=openSync(p,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function relativePath(value) {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||path.isAbsolute(value)||path.posix.normalize(value)!==value||value.split('/').some(p=>['.','..','.git','.converge'].includes(p))||/[?*\[]/.test(value)) refuse('unsafe-generated-path',String(value));
  return value;
}
export function validateGeneratedRequest(request) {
  if(!request||!equal(Object.keys(request).sort(),['binding','kind','operationId','ownerEvidence','paths'].sort())||request.kind!=='retire-generated-only'||typeof request.operationId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(request.operationId)||typeof request.ownerEvidence!=='string'||!request.ownerEvidence.trim()||!Array.isArray(request.paths)||!request.paths.length||request.paths.length>64||!request.binding||!equal(Object.keys(request.binding).sort(),['device','durableSourceCommit','head','id','inode','owner','path','sourceCommit'].sort())) refuse('invalid-generated-request','exact binding, operationId, paths and owner evidence required');
  const paths=request.paths.map(relativePath);
  if(new Set(paths).size!==paths.length||paths.some(a=>paths.some(b=>a!==b&&b.startsWith(a+'/')))) refuse('unsafe-generated-path','duplicate or overlapping paths');
  if(Object.values(request.binding).some(v=>typeof v!=='string'||!v)) refuse('invalid-generated-request','all binding fields must be set');
  return paths;
}
function checkAncestors(root,relative) {
  if(realpathSync(root)!==root||!lstatSync(root).isDirectory()) refuse('unsafe-generated-path','root must be an unaliased directory');
  let current=root;
  for(const part of relative.split('/').slice(0,-1)) {
    current=path.join(current,part);
    const s=lstatSync(current);
    if(s.isSymbolicLink()||!s.isDirectory()) refuse('unsafe-generated-path','aliased ancestor');
  }
}
function inventory(root,device,policy,deadline) {
  if(policy!==undefined && policy!=="unlink-cache-links") refuse("unsafe-generated-path","unknown inventory policy");
  const entries=[];const pending=[''];
  while(pending.length) {
    if(deadline!==undefined && Date.now()>=deadline) refuse('generated-io-error','inventory deadline exhausted');
    if(entries.length>=1000000) refuse("generated-io-error","inventory exceeds bounded 1000000 entries; split declared paths");
    const relative=pending.pop(),absolute=path.join(root,relative),s=lstatSync(absolute,{bigint:true});
    if((s.isSymbolicLink()&&policy!=="unlink-cache-links")||(!s.isDirectory()&&!s.isFile()&&!s.isSymbolicLink())||String(s.dev)!==device||s.isFile()&&s.nlink!==1n&&policy!=="unlink-cache-links"||relative.split(path.sep).some(v=>v==='.git'||v==='.converge')) refuse('unsafe-generated-path',`symlink, protected evidence, shared inode, mount or special file: ${absolute}`);
    entries.push({path:relative,...identity(s),type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'file',...(s.isSymbolicLink()?{linkTarget:readlinkSync(absolute)}:{}),...(s.isFile()&&s.nlink!==1n?{shared:true}:{}),size:String(s.size),blocks:String(s.blocks),mtime:String(s.mtimeNs)});
    if(s.isDirectory()) for(const name of readdirSync(absolute).sort().reverse()) pending.push(path.join(relative,name));
  }
  return entries.sort((a,b)=>a.path.localeCompare(b.path));
}
function sameEntry(a,b) {return a.path===b.path&&a.device===b.device&&a.inode===b.inode&&a.type===b.type&&a.linkTarget===b.linkTarget&&(a.type==='directory'||a.size===b.size&&a.blocks===b.blocks&&a.mtime===b.mtime);}
function sameInventory(a,b) {return a.length===b.length&&a.every((entry,index)=>sameEntry(entry,b[index]));}
function remainingInventorySafe(original,remaining) {
  const known=new Map(original.map(e=>[e.path,e]));
  return remaining.every(e=>{const old=known.get(e.path);return old!==undefined&&sameEntry(old,e);});
}
function removeManifest(context,stage,files) {
 const known=new Map(files.map(entry=>[entry.path,entry]));
 const visit=(relative,target)=>{
  if(context.deadline!==undefined&&Date.now()>=context.deadline)refuse('generated-io-error','bounded deletion paused; resume the same pending operation');
  const expected=known.get(relative),stat=optionalStat(target);if(stat===null)return;
  if(!expected)refuse('generated-identity-changed','unlisted staging entry');
  const current={path:relative,...identity(stat),type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'special',size:String(stat.size),blocks:String(stat.blocks),mtime:String(stat.mtimeNs),...(stat.isSymbolicLink()?{linkTarget:readlinkSync(target)}:{})};
  if(!sameEntry(expected,current))refuse('generated-identity-changed','staging entry changed during bounded deletion');
  if(expected.type!=='directory'){unlinkSync(target);context.afterEntryRemoval?.(relative,context);return;}
  const fd=openSync(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
   const pinned=fstatSync(fd,{bigint:true});if(String(pinned.dev)!==expected.device||String(pinned.ino)!==expected.inode)refuse('generated-identity-changed','staging directory changed during open');
   const descriptor='/proc/self/fd/'+fd,names=readdirSync(descriptor);
   for(const name of names)if(!known.has(path.join(relative,name)))refuse('generated-identity-changed','unlisted staging entry');
   for(const name of names)visit(path.join(relative,name),descriptor+'/'+name);
   const latest=optionalStat(target);if(latest===null||String(latest.dev)!==expected.device||String(latest.ino)!==expected.inode)refuse('generated-identity-changed','staging directory replaced during removal');
   if(context.deadline!==undefined&&Date.now()>=context.deadline)refuse('generated-io-error','bounded deletion paused; resume the same pending operation');
   rmdirSync(target);context.afterEntryRemoval?.(relative,context);
  } finally {closeSync(fd);}
 };
 visit('',stage);
}

export function generatedStagingRoots(request,stateDirectory) {
  return request.paths.map(relative=>path.join(stateDirectory,'generated-retirement',hash([request.operationId,relative])));
}
export function referenceSummaries(values) {const keys=new Set(['kind','resourceClass','type','id','pid','startTime','startTicks','uid','state','domainId','workspaceId','threadId','conversationId','assignmentId','jobId','operationId','unit','name','containerId','root','path','roots','cwd','field','mode','fd','access','owner','groupId']);return values.map(value=>Object.fromEntries(Object.entries(value).filter(([key])=>keys.has(key))));}
function authorizeBinding(context,request) {
  const declarations=context.declarations();
  if(!Array.isArray(declarations)||request.paths.some(relative=>!declarations.some(d=>d===relative||typeof d==='string'&&d.startsWith('**/')&&relative.split('/').at(-1)===d.slice(3)))) refuse('unsafe-generated-path','selected output is no longer declared');
  const current=context.binding();
  if(!equal(current,request.binding)) refuse('generated-identity-changed','workspace/head/source/root binding changed');
}
function authorize(context,request) {
  authorizeBinding(context,request);
  const safety=context.safety(generatedStagingRoots(request,context.stateDirectory));
  if(!safety||!Array.isArray(safety.errors)||!Array.isArray(safety.references)||!Array.isArray(safety.retainedBorrowers)) refuse('generated-safety-unknown','invalid safety result');
  if(safety.errors.length) refuse('generated-safety-unknown',JSON.stringify(safety.errors));
  if(safety.references.length||safety.retainedBorrowers.length) refuse('generated-reference-active',JSON.stringify({references:referenceSummaries(safety.references),retainedBorrowers:referenceSummaries(safety.retainedBorrowers)}));
  context.custody();
}

/** Returns {ok:true,value} or {ok:false,error:{code,detail}}. Caller holds owning checkout/group/borrower fences. */
export function retireGeneratedOnly(context,request) {
  try {return {ok:true,value:execute(context,request)};}
  catch(error) {return {ok:false,error:{code:error instanceof GeneratedRetirementError?error.code:'generated-io-error',detail:String(error.message)}};}
}
function execute(context,request) {
  const paths=validateGeneratedRequest(request),root=request.binding.path;
  const snapshot=target=>inventory(target,request.binding.device,context.inventoryPolicy,context.deadline);
  if(context.journalKind==='workspace-cache-retirement')authorizeBinding(context,request);else authorize(context,request);
  const db=context.database,sha=hash(request);
  db.exec('PRAGMA synchronous=FULL');
  db.exec('CREATE TABLE IF NOT EXISTS workspace_generated_retirement(operation_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,journal_json TEXT NOT NULL)');
  let row=db.prepare('SELECT * FROM workspace_generated_retirement WHERE operation_id=?').get(request.operationId);
  if(row&&row.request_sha256!==sha) refuse('generated-operation-conflict','operation identity has different request bytes');
  if(!row&&db.prepare("SELECT operation_id FROM workspace_generated_retirement WHERE workspace_id=? AND json_extract(journal_json,'$.state')='pending'").get(request.binding.id)) refuse('generated-operation-conflict','resume the existing pending workspace retirement first');
  let journal;
  const stageRoot=path.join(context.stateDirectory,'generated-retirement');
  if(row) journal=JSON.parse(row.journal_json);
  else {
    const declared=context.declarations();
    const entries=paths.map(relative=>{
      checkAncestors(root,relative);
      if(!declared.some(d=>d===relative||d.startsWith('**/')&&relative.split('/').at(-1)===d.slice(3))) refuse('unsafe-generated-path',`not declared: ${relative}`);
      const target=path.join(root,relative);
      if(context.tracked(target)) refuse('unsafe-generated-path',`tracked or unknown Git path: ${relative}`);
      const stat=optionalStat(target);
      if(!stat) refuse('unsafe-generated-path',`initial target missing: ${relative}`);
      const files=snapshot(target);
      return {relative,stage:path.join(stageRoot,hash([request.operationId,relative])),files,phase:'planned',logicalBytes:files.filter(f=>f.type==='file').reduce((s,f)=>s+Number(f.size),0),allocatedBytes:files.reduce((s,f)=>s+(f.shared?0:Number(f.blocks)*512),0)};
    });
    mkdirSync(stageRoot,{recursive:true,mode:0o700});
    syncDirectory(path.dirname(stageRoot));
    if(realpathSync(stageRoot)!==stageRoot||String(lstatSync(stageRoot,{bigint:true}).dev)!==request.binding.device) refuse('unsafe-generated-path','staging must be unaliased and on same filesystem');
    if(entries.some(e=>optionalStat(e.stage))) refuse('generated-operation-conflict','staging path already exists');
    journal={kind:context.journalKind??'generated-only-retirement',request,entries,state:'pending'};
    db.prepare('INSERT INTO workspace_generated_retirement VALUES(?,?,?,?)').run(request.operationId,request.binding.id,sha,JSON.stringify(journal));
  }
  const save=()=>db.prepare('UPDATE workspace_generated_retirement SET journal_json=? WHERE operation_id=?').run(JSON.stringify(journal),request.operationId);
  if(journal.state==='completed') return {...journal.result,replayed:true};
  if(realpathSync(stageRoot)!==stageRoot) refuse('unsafe-generated-path','staging aliased');
  // Validate every still-live member before the first effect, including on resume.
  for(const e of journal.entries.length===1?[]:journal.entries) {
    if(e.phase==='removed') continue;
    const target=path.join(root,e.relative);checkAncestors(root,e.relative);
    const staged=optionalStat(e.stage),source=optionalStat(target);
    if(staged) {
      if(source) refuse('generated-identity-changed','source recreated during retirement');
      const remaining=snapshot(e.stage);
      if(!remainingInventorySafe(e.files,remaining)) refuse('generated-identity-changed','staging content changed');
      if(e.phase==='planned'&&!sameInventory(e.files,remaining)) refuse('generated-identity-changed','unconfirmed rename content differs');
    } else if(e.phase==='planned') {
      if(!source||!sameInventory(e.files,snapshot(target))||context.tracked(target)) refuse('generated-identity-changed','generated content changed before effect');
    } else if(e.phase!=='deleting') refuse('generated-identity-changed','staging disappeared without deletion intent');
  }
  for(const e of journal.entries) {
    if(e.phase==='removed') continue;
    const target=path.join(root,e.relative);
    if(optionalStat(e.stage)&&optionalStat(target))refuse('generated-identity-changed','source recreated during retirement');
    if(e.phase==='planned') {
      if(!optionalStat(e.stage)) {
        authorize(context,request);
        checkAncestors(root,e.relative);
        if(!sameInventory(e.files,snapshot(target))||context.tracked(target)) refuse('generated-identity-changed','generated content changed at rename');
        context.invalidate();
        renameSync(target,e.stage);syncDirectory(path.dirname(target));syncDirectory(stageRoot);
        context.afterRename?.(e);
      }
      e.phase='deleting';save();
    }
    if(optionalStat(e.stage)) {
      const manifestRemoval=context.journalKind==='workspace-cache-retirement';
      const remaining=manifestRemoval?null:snapshot(e.stage);
      if(!manifestRemoval&&!remainingInventorySafe(e.files,remaining)) refuse('generated-identity-changed','staging changed before removal');
      authorize(context,request);
      context.beforeRemoval?.(e);
      if(manifestRemoval)removeManifest(context,e.stage,e.files);
      else for(const entry of [...remaining].sort((a,b)=>b.path.length-a.path.length)) {
        if(context.deadline!==undefined&&Date.now()>=context.deadline) refuse('generated-io-error','bounded deletion paused; resume the same pending operation');
        const target=path.join(e.stage,entry.path),stat=optionalStat(target);if(stat===null)continue;
        const current={...entry,...identity(stat),type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'special',size:String(stat.size),blocks:String(stat.blocks),mtime:String(stat.mtimeNs),...(stat.isSymbolicLink()?{linkTarget:readlinkSync(target)}:{})};
        if(!sameEntry(entry,current))refuse('generated-identity-changed','staging entry changed during bounded deletion');
        if(entry.type==='directory')rmdirSync(target);else unlinkSync(target);
      }
      syncDirectory(stageRoot);
      context.afterRemoval?.(e);
    }
    e.phase='removed';save();
  }
  journal.state='completed';
  journal.result={kind:context.journalKind==='workspace-cache-retirement'?'workspace-cache-retired':'generated-only-retired',...(context.journalKind==='workspace-cache-retirement'?{cacheState:{kind:'retired-regenerable',paths,sourceIntentDisposition:'retained in canonical input/task and durable source; regenerate dependencies under a new admitted writing lease'}}:{}),operationId:request.operationId,workspaceId:request.binding.id,removedPaths:paths,removedLogicalBytes:journal.entries.reduce((s,e)=>s+e.logicalBytes,0),removedAllocatedBytes:journal.entries.reduce((s,e)=>s+e.allocatedBytes,0),measurement:'sum of observed unshared inode blocks before retirement; shared hardlinks excluded; not filesystem free-space delta',workspacePreserved:true};
  save();return {...journal.result,replayed:false};
}
