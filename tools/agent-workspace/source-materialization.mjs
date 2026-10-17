import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {retireGeneratedOnly,generatedStagingRoots,GeneratedRetirementError} from './generated-retirement.mjs';

export class MaterializationError extends Error {constructor(code,detail){super(detail);this.code=code;}}
const refuse=(code,detail)=>{throw new MaterializationError(code,detail);};
export const materializationDigest=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>materializationDigest(JSON.stringify(canonical(v)));
const same=(a,b)=>hash(a)===hash(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),keys.sort());
const text=v=>typeof v==='string'&&v.length>0;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const commit=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const inside=(base,p)=>p===base||p.startsWith(base+path.sep);
const absent=p=>{try{return fs.lstatSync(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const ident=s=>({device:String(s.dev),inode:String(s.ino)});
function safeFile(p){if(!text(p)||!path.isAbsolute(p)||path.normalize(p)!==p||fs.realpathSync(p)!==p)refuse('materialization-unsafe-path','unaliased absolute path required');const s=fs.lstatSync(p,{bigint:true});if(!s.isFile()||s.nlink!==1n)refuse('materialization-unsafe-path','evidence must be a single-link regular file');return s;}
function evidence(ref,maxBytes){if(!exact(ref,['path','sha256'])||!sha(ref.sha256))refuse('materialization-invalid-request','hash-bound evidence required');const s=safeFile(ref.path);if(s.size>BigInt(maxBytes))refuse('materialization-invalid-request','evidence too large');const b=fs.readFileSync(ref.path);if(materializationDigest(b)!==ref.sha256)refuse('materialization-evidence-changed',ref.path);return JSON.parse(b.toString('utf8'));}
function git(repo,args,input,maxBuffer=32*1024*1024){const r=spawnSync('git',['-C',repo,...args],{input,encoding:null,timeout:15000,maxBuffer,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0||r.error)refuse('materialization-custody-required',`independent Git operation failed: ${r.error?.code??r.status}`);return r.stdout;}
function relative(p){if(!text(p)||path.posix.normalize(p)!==p||path.isAbsolute(p)||p.includes('\\')||p.includes('\0')||p.split('/').some(x=>['.','..','.git','.converge','node_modules','candidate.git'].includes(x)))refuse('materialization-unsafe-path','protected or aliased source member');return p;}
export function validateMaterializationRequest(r){
 if(!exact(r,['kind','operationId','parent','source','durable','inventory','ownerRelease','consumerRelease'])||r.kind!=='retire-source-materialization'||!text(r.operationId)||!/^[a-zA-Z0-9_-]{8,80}$/.test(r.operationId))refuse('materialization-invalid-request','explicit source-materialization request required');
 if(!exact(r.parent,['id','path','owner','head','device','inode'])||!Object.values(r.parent).every(text)||!commit(r.parent.head))refuse('materialization-invalid-request','complete registered parent identity required');
 if(!exact(r.source,['path','device','inode','containerDevice','containerInode'])||!Object.values(r.source).every(text)||!path.isAbsolute(r.source.path)||path.normalize(r.source.path)!==r.source.path)refuse('materialization-invalid-request','complete source/container inode identity required');
 const prefix=path.join(r.parent.path,'.git','source-preparations')+path.sep;
 if(!r.source.path.startsWith(prefix)||path.basename(r.source.path)!=='source')refuse('materialization-unsafe-path','only an exact SOURCE leaf beneath parent .git/source-preparations');
 const suffix=r.source.path.slice(prefix.length);suffix.split('/').forEach(relative);
 if(suffix.split('/').length<2)refuse('materialization-unsafe-path','preparation parent and source leaf must differ');
 if(!exact(r.durable,['repository','commit','wantedRef'])||!text(r.durable.repository)||!commit(r.durable.commit)||!text(r.durable.wantedRef)||!r.durable.wantedRef.startsWith('refs/'))refuse('materialization-invalid-request','independent commit and wanted ref required');
 for(const ref of [r.inventory,r.ownerRelease,r.consumerRelease])if(!exact(ref,['path','sha256'])||!sha(ref.sha256))refuse('materialization-invalid-request','explicit proof/release hashes required');
 return r;
}
function ancestry(r){
 const root=r.parent.path;if(!path.isAbsolute(root)||path.normalize(root)!==root||fs.realpathSync(root)!==root)refuse('materialization-unsafe-path','parent is aliased');
 const p=fs.lstatSync(root,{bigint:true});if(!p.isDirectory()||!same(ident(p),{device:r.parent.device,inode:r.parent.inode}))refuse('materialization-identity-changed','parent inode changed');
 let current=root;for(const part of path.relative(root,path.dirname(r.source.path)).split(path.sep)){current=path.join(current,part);const s=fs.lstatSync(current,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||String(s.dev)!==r.source.device||fs.realpathSync(current)!==current)refuse('materialization-unsafe-path','source ancestor aliased or crossed mount');}
 const container=fs.lstatSync(path.dirname(r.source.path),{bigint:true});if(!same(ident(container),{device:r.source.containerDevice,inode:r.source.containerInode}))refuse('materialization-identity-changed','source container changed');
 const common=git(root,['rev-parse','--path-format=absolute','--git-common-dir']).toString().trim();if(common!==path.join(root,'.git'))refuse('materialization-unsafe-path','source parent must own its actual Git directory');
 for(const ref of [r.inventory,r.ownerRelease,r.consumerRelease])if(inside(root,ref.path))refuse('materialization-unsafe-path','proof and releases must be independently retained outside parent');
}
function releases(r){
 const expected={parentId:r.parent.id,owner:r.parent.owner,sourcePath:r.source.path,commit:r.durable.commit,wantedRef:r.durable.wantedRef,inventorySha256:r.inventory.sha256};
 const owner=evidence(r.ownerRelease,1024*1024),consumer=evidence(r.consumerRelease,1024*1024);
 for(const [value,kind] of [[owner,'source-materialization-owner-release'],[consumer,'source-materialization-consumer-release']]){
  if(value.kind!==kind||!same(value.binding,expected)||!text(value.evidence)||value.writers!=='none'||!Array.isArray(value.manifests)||value.manifests.length===0||!Number.isSafeInteger(value.observedAt)||value.observedAt>Date.now())refuse('materialization-release-required','fresh bound owner and consumer releases with manifest observations required');
  for(const m of value.manifests){const manifest=evidence(m,16*1024*1024);const body=JSON.stringify(manifest);if(body.includes(r.source.path))refuse('materialization-reference-active','current manifest still refers to source leaf');}
 }
}
function durableTree(r,proof){
 const repo=r.durable.repository;if(!path.isAbsolute(repo)||fs.realpathSync(repo)!==repo||inside(r.parent.path,repo))refuse('materialization-custody-required','durable repository must be independent');
 const objects=git(repo,['rev-parse','--path-format=absolute','--git-path','objects']).toString().trim();if(inside(r.parent.path,objects)||fs.realpathSync(objects)!==objects)refuse('materialization-custody-required','independent object directory required');
 // A borrowed object store is not independent durable custody. Never traverse/follow it.
 if(fs.existsSync(path.join(objects,'info','alternates')))refuse('materialization-custody-required','alternate-dependent durable repository refused');
 if(git(repo,['rev-parse','--verify',r.durable.wantedRef]).toString().trim()!==r.durable.commit)refuse('materialization-source-pin-changed','wanted ref no longer selects commit');
 const summary=proof.summary;if(!summary||summary.sourceRoot!==r.source.path||summary.commit!==r.durable.commit||summary.ref!==r.durable.wantedRef||summary.independentRepository!==repo||!Array.isArray(proof.inventory))refuse('materialization-evidence-changed','inventory source/ref/repository mismatch');
 const tree=git(repo,['ls-tree','-r','-z','--full-tree',r.durable.commit]).toString().split('\0').filter(Boolean).map(line=>{const x=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);if(!x)refuse('materialization-custody-required','only regular Git blobs qualify');return {path:relative(x[3]),oid:x[2],mode:x[1]};});
 if(!tree.length||tree.length>100000||tree.length!==proof.inventory.length)refuse('materialization-evidence-changed','complete candidate tree inventory required');
 const supplied=new Map();for(const f of proof.inventory){if(!f||!text(f.path)||supplied.has(f.path)||!sha(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.kind!=='file')refuse('materialization-evidence-changed','invalid or duplicate inventory member');supplied.set(relative(f.path),f);}
 const expected=tree.map(f=>{const p=supplied.get(f.path);if(!p||p.git?.oid!==f.oid||p.git?.mode!==f.mode)refuse('materialization-evidence-changed','inventory missing or Git pin changed');return {...f,bytes:p.bytes,sha256:p.sha256};});
 // Bound each batch's decoded bytes. Verify actual independent Git content, not just object names.
 let at=0;while(at<expected.length){let total=0,end=at;while(end<expected.length&&(total+expected[end].bytes<=16*1024*1024||end===at)){if(expected[end].bytes>64*1024*1024)refuse('materialization-custody-required','blob exceeds bounded content verifier');total+=expected[end++].bytes;}
  const chunk=expected.slice(at,end),b=git(repo,['cat-file','--batch'],chunk.map(x=>x.oid+'\n').join(''),total+chunk.length*200+4096);let offset=0;
  for(const f of chunk){const nl=b.indexOf(10,offset);if(nl<offset)refuse('materialization-custody-required','truncated Git batch');const header=b.subarray(offset,nl).toString();if(header!==`${f.oid} blob ${f.bytes}`)refuse('materialization-custody-required','Git blob header mismatch');const body=b.subarray(nl+1,nl+1+f.bytes);if(body.length!==f.bytes||materializationDigest(body)!==f.sha256||b[nl+1+f.bytes]!==10)refuse('materialization-custody-required','independent Git bytes do not match inventory');offset=nl+2+f.bytes;}
  if(offset!==b.length)refuse('materialization-custody-required','extra Git batch bytes');at=end;
 }
 return expected;
}
function sourceInventory(root,r,expected,previous,partial){
 const wanted=new Map(expected.map(f=>[f.path,f]));const directories=new Set(['']);for(const f of expected){let p=path.dirname(f.path);while(p!=='.'){directories.add(p);p=path.dirname(p);}}const found=[],pending=[''];let count=0;
 while(pending.length){if(++count>200000)refuse('materialization-invalid-request','source inventory exceeds bounded verifier');const rel=pending.pop(),p=path.join(root,rel),s=fs.lstatSync(p,{bigint:true});if(String(s.dev)!==r.source.device||s.isSymbolicLink()||!s.isFile()&&!s.isDirectory()||s.isFile()&&s.nlink!==1n)refuse('materialization-unsafe-path','symlink/hardlink/mount/special source member');if(rel)relative(rel);
  if(s.isDirectory()){if(!directories.has(rel))refuse('materialization-extra-source','unknown source directory: '+rel);for(const n of fs.readdirSync(p).sort().reverse())pending.push(path.join(rel,n));continue;}
  const f=wanted.get(rel);if(!f)refuse('materialization-extra-source','unknown source bytes: '+rel);
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;try{const before=fs.fstatSync(fd,{bigint:true});b=fs.readFileSync(fd);const after=fs.fstatSync(fd,{bigint:true});if(before.ino!==s.ino||before.dev!==s.dev||after.ctimeNs!==before.ctimeNs||after.mtimeNs!==before.mtimeNs||after.size!==before.size)refuse('materialization-identity-changed','source changed while hashing');}finally{fs.closeSync(fd);}
  if(b.length!==f.bytes||materializationDigest(b)!==f.sha256)refuse('materialization-dirty-source','source bytes differ: '+rel);
  const item={path:rel,device:String(s.dev),inode:String(s.ino),size:String(s.size),mtime:String(s.mtimeNs)};if(previous){const old=previous.get(rel);if(!old||!same(item,old))refuse('materialization-identity-changed','member inode/stat drift: '+rel);}found.push(item);
 }
 if(!partial&&found.length!==expected.length)refuse('materialization-missing-source','source tree is missing candidate files');return new Map(found.map(f=>[f.path,f]));
}
/** Public owning command implementation. Caller holds parent/group AND exact-source resource fences. */
export function retireSourceMaterialization(context,request){
 try{
  const r=validateMaterializationRequest(request);ancestry(r);const proof=evidence(r.inventory,64*1024*1024),expected=durableTree(r,proof);
  const inner={kind:'retire-generated-only',operationId:'source-'+r.operationId,ownerEvidence:hash(r),binding:{id:r.parent.id,path:path.dirname(r.source.path),owner:r.parent.owner,sourceCommit:r.durable.commit,durableSourceCommit:r.durable.commit,head:r.durable.commit,device:r.source.containerDevice,inode:r.source.containerInode},paths:['source']};
  const stage=generatedStagingRoots(inner,context.stateDirectory)[0];let baseline;
  const custody=()=>{
   ancestry(r);releases(r);if(!same(context.parentBinding(),r.parent))refuse('materialization-identity-changed','registered parent changed');
   if(git(r.durable.repository,['rev-parse','--verify',r.durable.wantedRef]).toString().trim()!==r.durable.commit)refuse('materialization-source-pin-changed','wanted ref changed');
   const row=context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_generated_retirement'").get()?context.database.prepare('SELECT request_sha256,journal_json FROM workspace_generated_retirement WHERE operation_id=?').get(inner.operationId):null;
   const journal=row?JSON.parse(row.journal_json):null;if(journal&&journal.state==='completed')return;
   const staged=absent(stage),original=absent(r.source.path);if(staged&&original)refuse('materialization-identity-changed','source recreated while staged');const actual=staged?stage:r.source.path,s=staged??original;
   if(!s&&journal?.entries?.[0]?.phase==='deleting')return;
   if(!s||!same(ident(s),{device:r.source.device,inode:r.source.inode}))refuse('materialization-identity-changed','source leaf inode changed or missing');
   const entry=journal?.entries?.[0],partial=Boolean(staged&&entry?.phase==='deleting');
   if(!baseline&&entry)baseline=new Map(entry.files.filter(f=>f.type==='file').map(f=>[f.path,{path:f.path,device:f.device,inode:f.inode,size:f.size,mtime:f.mtime}]));
   const current=sourceInventory(actual,r,expected,baseline,partial);if(!baseline)baseline=current;
  };
  const result=retireGeneratedOnly({...context,binding:()=>inner.binding,custody:()=>{try{custody();}catch(e){if(e instanceof MaterializationError)throw new GeneratedRetirementError(e.code,e.message);throw e;}},declarations:()=>['source'],tracked:()=>false,safety:stages=>{const observed=context.safety([r.source.path,...stages]);if(!Number.isSafeInteger(observed?.observedAt)||observed.observedAt>Date.now()||Date.now()-observed.observedAt>60000)throw new GeneratedRetirementError('materialization-safety-stale','fresh native observation required');return observed;}},inner);
  if(!result.ok)return result;return {ok:true,value:{...result.value,kind:'source-materialization-retired',sourcePath:r.source.path,parentPreserved:true,durableCommit:r.durable.commit,requestSha256:hash(r)}};
 }catch(e){return {ok:false,error:{code:e instanceof MaterializationError?e.code:'materialization-io-error',detail:String(e.message)}};}
}
