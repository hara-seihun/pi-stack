import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {restoreApplicationCohorts,authorizeHistoricalApplications} from '../deploy/native-history-restore-applications.mjs';
function fixture(t){
 const dataDir=mkdtempSync(join(tmpdir(),'nested-restore-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const uid=process.getuid(),user=userInfo().username,a={version:1,purpose:'historical-application-restoration-v1',uid,user,unit:`pi-orchestrator@${user}.service`,dataDir,ledgerPath:join(dataDir,'ledger.sqlite3'),candidate:'a'.repeat(40),legacySource:'b'.repeat(40),historicalJournal:{phase:'restored',sha256:'c'.repeat(64)}};
 const db=new DatabaseSync(a.ledgerPath);db.exec('CREATE TABLE control(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE run(id TEXT,state TEXT); INSERT INTO run VALUES(\'provider\',\'running\');');db.close();return a;
}
function application(a,id,candidate=a.candidate){
 const dir=join(a.dataDir,'applications',id);mkdirSync(dir,{recursive:true});
 const l=new DatabaseSync(a.ledgerPath);l.prepare('INSERT INTO control VALUES(?,?)').run('thread-boundary:'+id,'never-read-private-context');l.close();
 const db=new DatabaseSync(join(dir,'threads.sqlite3'));db.exec(`CREATE TABLE thread(id TEXT,metadata TEXT,state TEXT);INSERT INTO thread VALUES('native','preserve-me','running');CREATE TABLE thread_question(id TEXT,thread_id TEXT,body TEXT);INSERT INTO thread_question VALUES('question','native','private-unchanged');CREATE TABLE thread_work(id TEXT);CREATE TABLE pi_history_bridge(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE pi_history_cohort(id TEXT PRIMARY KEY);INSERT INTO pi_history_cohort VALUES('native');CREATE TABLE pi_history_questions(id TEXT PRIMARY KEY,thread_id TEXT);INSERT INTO pi_history_questions VALUES('question','native');CREATE TRIGGER pi_history_admission BEFORE INSERT ON thread_work BEGIN SELECT RAISE(ABORT,'closed');END;CREATE TRIGGER pi_history_children AFTER INSERT ON thread BEGIN INSERT OR IGNORE INTO pi_history_cohort VALUES(NEW.id);END;CREATE TRIGGER pi_history_question_cohort AFTER INSERT ON thread_question BEGIN INSERT OR IGNORE INTO pi_history_questions VALUES(NEW.id,NEW.thread_id);END;`);
 db.prepare('INSERT INTO pi_history_bridge VALUES(?,?)').run('identity',JSON.stringify({candidate,legacySource:a.legacySource}));db.close();return dir;
}
function live(a,pid=42){return {ok:true,value:{unit:a.unit,pid,namespace:'mnt:test',source:a.legacySource,releaseCommit:a.legacySource}};}
test('all ledger-declared nested historical fences restore, private cohort/question IDs preserved, native/provider records unchanged',t=>{
 const a=fixture(t),dir=application(a,'1'.repeat(24));application(a,'2'.repeat(24));
 const result=restoreApplicationCohorts(a,()=>live(a));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.applications.length,2);
 const db=new DatabaseSync(join(dir,'threads.sqlite3'));assert.equal(db.prepare('SELECT metadata,state FROM thread').get().state,'running');assert.equal(db.prepare('SELECT body FROM thread_question').get().body,'private-unchanged');db.exec("INSERT INTO thread_work VALUES('new-admitted')");db.close();
 const evidence=JSON.parse(readFileSync(result.value.applications[0].evidence));assert.equal(evidence.phase,'restored');assert.equal(evidence.cohort[0].id,'native');assert.equal(evidence.questions[0].id,'question');
 assert.equal(restoreApplicationCohorts(a,()=>live(a)).value.applications.every(v=>v.alreadyRestored),true);
 const ledger=new DatabaseSync(a.ledgerPath);assert.equal(ledger.prepare('SELECT state FROM run').get().state,'running');ledger.close();
});
test('a foreign nested candidate rejects the entire preflight before any fence or evidence mutation',t=>{
 const a=fixture(t),dir=application(a,'1'.repeat(24));application(a,'2'.repeat(24),'d'.repeat(40));
 const result=restoreApplicationCohorts(a,()=>live(a));assert.equal(result.error.code,'foreign-custody');assert.equal(existsSync(join(dir,`native-history-restoration-${a.candidate}.json`)),false);
 const db=new DatabaseSync(join(dir,'threads.sqlite3'));assert.equal(db.prepare('SELECT count(*) AS n FROM pi_history_cohort').get().n,1);assert.throws(()=>db.exec("INSERT INTO thread_work VALUES('blocked')"),/closed/);db.close();
});
test('closure, readiness, retirement, partial/observation schema and unacknowledged empty custody are refused',t=>{
 for(const defect of ['closing','readiness','retirement','partial','observation','absent']){
  const a=fixture(t),dir=application(a,'1'.repeat(24));const db=new DatabaseSync(join(dir,'threads.sqlite3'));
  if(defect==='closing')db.exec("INSERT INTO pi_history_bridge VALUES('closing','1')");
  if(defect==='readiness')writeFileSync(join(dir,'native-history-readiness.json'),'{}');
  if(defect==='retirement')mkdirSync(join(dir,'native-history-retirement'));
  if(defect==='partial')db.exec('DROP TRIGGER pi_history_children');
  if(defect==='observation')db.exec('CREATE TABLE pi_history_observation(version INTEGER)');
  if(defect==='absent')db.exec('DROP TRIGGER pi_history_children;DROP TRIGGER pi_history_question_cohort;DROP TRIGGER pi_history_admission;DROP TABLE pi_history_cohort;DROP TABLE pi_history_questions;DROP TABLE pi_history_bridge;');db.close();
  assert.equal(restoreApplicationCohorts(a,()=>live(a)).ok,false,defect);
 }
});
test('kernel generation checked under all DB locks; health only before/after unlock',t=>{
 const a=fixture(t),dir=application(a,'1'.repeat(24));let checks=0;
 const full=()=>{for(const p of [a.ledgerPath,join(dir,'threads.sqlite3')]){const d=new DatabaseSync(p);try{d.exec('BEGIN IMMEDIATE;ROLLBACK');}finally{d.close();}}checks++;return live(a);};
 const locked=()=>{const d=new DatabaseSync(join(dir,'threads.sqlite3'));try{assert.throws(()=>d.exec('BEGIN IMMEDIATE'),/locked/);return live(a);}finally{d.close();}};
 assert.equal(restoreApplicationCohorts(a,full,locked).ok,true);assert.equal(checks,2);
});
test('generation drift before changes rolls back; after changes returns exact committed effects, no invented readiness',t=>{
 const a=fixture(t),dir=application(a,'1'.repeat(24));assert.equal(restoreApplicationCohorts(a,()=>live(a),()=>live(a,43)).error.code,'owner-generation-changed');
 const db=new DatabaseSync(join(dir,'threads.sqlite3'));assert.equal(db.prepare('SELECT count(*) AS n FROM pi_history_bridge').get().n,1);db.close();let n=0;
 const result=restoreApplicationCohorts(a,()=>live(a,++n===1?42:43),()=>live(a));assert.equal(result.error.code,'owner-generation-changed');assert.deepEqual(result.error.committedApplications,['1'.repeat(24)]);
});
test('historical authorization cannot be granted by an ordinary UID',()=>{assert.notEqual(process.getuid(),0);assert.equal(authorizeHistoricalApplications({}).error.code,'root-required');});
