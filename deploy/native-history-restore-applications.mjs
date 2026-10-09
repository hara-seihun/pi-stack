import { existsSync, readFileSync, statSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson, BRIDGE_PROTOCOL } from './native-history-bridge.mjs';
import { observationUnitProof, observationUnitIdentityProof } from './native-history-closed-owner.mjs';
const PURPOSE='historical-application-restoration-v1', AUTH_ROOT='/run/pi-native-history-authorizations';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
function fail(code,message,extra={}) { return {ok:false,error:{code,message,...extra}}; }
function owned(path,uid) { const info=lstatSync(path); if(!info.isFile()||info.uid!==uid||realpathSync(path)!==path)throw new Error('Exact own regular database/receipt required'); }
function rootFile(path) { for(const p of [path,dirname(path)]){const s=lstatSync(p);if(s.uid!==0||(s.mode&0o022)||s.isSymbolicLink())throw new Error('Authorization is not immutable administrator custody');} }
function same(record,a) { return record?.candidate===a.candidate&&record?.legacySource===a.legacySource; }
function table(db,name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function kernel(value) { const {releaseCommit,...rest}=value;return JSON.stringify(rest); }
export function authorizeHistoricalApplications(input) {
 try {
  if(process.getuid()!==0)return fail('root-required','Historical authorization requires administrator');
  if(!sha(input.candidate)||!Number.isSafeInteger(input.uid)||input.uid<0||typeof input.unit!=='string')return fail('identity','Exact historical candidate and owner required');
  const path=join('/srv/pi/.pi-stack-maintenance/native-history',input.candidate,'state.json');rootFile(path);
  const raw=readFileSync(path),state=JSON.parse(raw);
  if(state.protocol!==BRIDGE_PROTOCOL||state.candidate!==input.candidate||state.phase!=='restored'||!sha(state.legacySource))return fail('historical-not-restored','Original publication has no acknowledged restored global custody');
  const owners=state.owners.filter(o=>o.uid===input.uid&&o.unit===input.unit&&o.mode==='fleet');
  if(owners.length!==1)return fail('historical-owner','Historical journal has no unique declared own fleet');
  const o=owners[0];
  const authority={version:1,purpose:PURPOSE,candidate:input.candidate,legacySource:state.legacySource,uid:o.uid,unit:o.unit,user:o.user,dataDir:o.dataDir,ledgerPath:o.ledgerPath,
   ownerPid:input.ownerPid,healthPort:input.healthPort,publisherUid:input.publisherUid,selectedSource:state.legacyOrchestrator,
   historicalJournal:{path,sha256:createHash('sha256').update(raw).digest('hex'),phase:'restored'},authorizedAt:new Date().toISOString()};
  mkdirSync(AUTH_ROOT,{recursive:true,mode:0o755});rootFile(AUTH_ROOT);
  const output=join(AUTH_ROOT,`${authority.candidate}-${authority.uid}.json`);atomicJson(output,authority);
  // Nonsecret identity-only certificate; readable by its executing owner, writable only by root.
  const {chmodSync}=process.getBuiltinModule('node:fs');chmodSync(output,0o644);
  return {ok:true,value:{authorization:output,candidate:authority.candidate,uid:authority.uid}};
 }catch(e){return fail('authorization-failed',e.message);}
}
export function restoreApplicationCohorts(a,inspectOwner=observationUnitProof,inspectIdentity=inspectOwner===observationUnitProof?observationUnitIdentityProof:inspectOwner) {
 const databases=[],committed=[];
 try {
  if(a.version!==1||a.purpose!==PURPOSE||a.uid!==process.getuid()||a.user!==userInfo().username||a.unit!==`pi-orchestrator@${a.user}.service`
   ||!sha(a.candidate)||!sha(a.legacySource)||a.historicalJournal?.phase!=='restored'||typeof a.historicalJournal.sha256!=='string'
   ||!a.dataDir?.startsWith('/')||resolve(a.dataDir)!==a.dataDir||dirname(a.ledgerPath)!==a.dataDir||resolve(a.ledgerPath)!==a.ledgerPath)return fail('identity','Exact authorized own fleet custody required');
  const input={...a,mode:'fleet'};const initial=inspectOwner(input);if(!initial.ok)return initial;
  owned(a.ledgerPath,a.uid);const ledger=new DatabaseSync(a.ledgerPath);databases.push(ledger);ledger.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
  const keys=ledger.prepare("SELECT key FROM control WHERE key LIKE 'thread-boundary:%' ORDER BY key").all().map(row=>row.key.slice(16));
  const entries=[];
  for(const id of keys){
   if(!/^[a-f0-9]{24}$/.test(id))return fail('application-identity','Invalid ledger-declared application identity');
   const dir=join(a.dataDir,'applications',id),path=join(dir,'threads.sqlite3');owned(path,a.uid);
   if(existsSync(join(dir,'native-history-readiness.json'))||existsSync(join(dir,'native-history-retirement')))return fail('migration-started','Application readiness/retirement forbids historical restoration');
   const db=new DatabaseSync(path);databases.push(db);db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
   const names=['pi_history_admission','pi_history_children','pi_history_question_cohort'];
   const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (?,?,?) ORDER BY name").all(...names).map(r=>r.name);
   const evidencePath=join(dir,`native-history-restoration-${a.candidate}.json`);
   if(!table(db,'pi_history_bridge')){
    if(triggers.length||table(db,'pi_history_cohort')||table(db,'pi_history_questions')||table(db,'pi_history_observation'))return fail('partial-custody','Unidentified application maintenance state');
    if(!existsSync(evidencePath))return fail('acquisition-unknown','Application has neither original custody nor acknowledged restoration');
    owned(evidencePath,a.uid);const prior=JSON.parse(readFileSync(evidencePath));
    if(prior.version!==1||prior.purpose!==PURPOSE||prior.applicationId!==id||prior.uid!==a.uid||prior.phase!=='restored'||!same(prior,a))return fail('restoration-unproven','Application restoration evidence is not exact owned acknowledgement');
    entries.push({id,db,dir,evidencePath,prior,already:true});continue;
   }
   const identity=db.prepare("SELECT value FROM pi_history_bridge WHERE key='identity'").get();
   if(!identity||!same(JSON.parse(identity.value),a))return fail('foreign-custody','Application belongs to another candidate; no fences were changed');
   if(db.prepare("SELECT 1 FROM pi_history_bridge WHERE key='closing'").get()||table(db,'pi_history_observation'))return fail('not-historical-gated','Closing or different observation contract forbids historical restore');
   if(triggers.length!==3||!table(db,'pi_history_cohort')||!table(db,'pi_history_questions'))return fail('partial-custody','Original gated application custody is incomplete');
   const cohortColumns=db.prepare('PRAGMA table_info(pi_history_cohort)').all().map(r=>r.name),questionColumns=db.prepare('PRAGMA table_info(pi_history_questions)').all().map(r=>r.name);
   if(JSON.stringify(cohortColumns)!=='["id"]'||JSON.stringify(questionColumns)!=='["id","thread_id"]')return fail('schema-mismatch','Historical maintenance schema differs');
   const preimage={version:1,purpose:PURPOSE,uid:a.uid,applicationId:id,candidate:a.candidate,legacySource:a.legacySource,phase:'preimage',
    cohort:db.prepare('SELECT id FROM pi_history_cohort ORDER BY id').all(),questions:db.prepare('SELECT id,thread_id FROM pi_history_questions ORDER BY id').all(),
    triggers:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (?,?,?) ORDER BY name").all(...names),historicalJournal:a.historicalJournal};
   entries.push({id,db,dir,evidencePath,preimage,already:false});
  }
  const current=inspectIdentity(input);if(!current.ok)return current;if(kernel(current.value)!==kernel(initial.value))return fail('owner-generation-changed','Owner changed before historical application restoration');
  for(const e of entries){
   if(e.already){e.db.exec('ROLLBACK');continue;}
   if(existsSync(join(e.dir,'native-history-readiness.json'))||existsSync(join(e.dir,'native-history-retirement')))return fail('migration-started','Application retirement raced restoration',{committedApplications:committed});
   atomicJson(e.evidencePath,e.preimage);
   e.db.exec('DROP TRIGGER pi_history_admission; DROP TRIGGER pi_history_children; DROP TRIGGER pi_history_question_cohort; DROP TABLE pi_history_cohort; DROP TABLE pi_history_questions; DROP TABLE pi_history_bridge;');
   e.db.exec('COMMIT');committed.push(e.id);
   atomicJson(e.evidencePath,{...e.preimage,phase:'restored',restoredAt:new Date().toISOString(),restorationProof:{owner:initial.value,canonicalRows:'untouched'}});
  }
  ledger.exec('ROLLBACK');const after=inspectOwner(input);
  if(!after.ok||JSON.stringify(after.value)!==JSON.stringify(initial.value))return fail('owner-generation-changed','Effects committed but owner proof changed',{committedApplications:committed});
  return {ok:true,value:{purpose:PURPOSE,uid:a.uid,candidate:a.candidate,legacySource:a.legacySource,ready:true,phase:'restored',applications:entries.map(e=>({applicationId:e.id,phase:'restored',alreadyRestored:e.already,cohortRows:(e.prior??e.preimage).cohort.length,questionRows:(e.prior??e.preimage).questions.length,evidence:e.evidencePath})),live:initial.value,nativeOperations:'none'}};
 }catch(e){return fail(e.errcode===5||e.errcode===6?'database-busy':'restoration-failed',e.message,{committedApplications:committed});}
 finally{for(const db of databases.reverse()){if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let result;
 try{
  if(process.argv[2]==='--authorize')result=authorizeHistoricalApplications(JSON.parse(process.argv[3]));
  else if(process.argv[2]==='--restore'){
   const path=process.argv[3];if(!path?.startsWith(AUTH_ROOT+'/')||resolve(path)!==path)throw new Error('Exact source-owned authorization path required');rootFile(path);
   result=restoreApplicationCohorts(JSON.parse(readFileSync(path)));
  }else result=fail('input','Explicit --authorize JSON or --restore CERTIFICATE required');
 }catch(e){result=fail('input',e.message);}
 console.log(JSON.stringify(result));if(!result.ok)process.exitCode=75;
}
