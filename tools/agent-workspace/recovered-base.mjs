import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new Error('component-recovery:'+code)};
export function inventory(root){
 const result={};
 function visit(directory){for(const name of fs.readdirSync(directory).sort()){
  const file=path.join(directory,name),stat=fs.lstatSync(file),relative=path.relative(root,file).split(path.sep).join('/');
  if(stat.isDirectory()){visit(file);continue;}
  if(!stat.isFile()&&!stat.isSymbolicLink())fail('unsupported-installed-entry');
  result[relative]={mode:stat.isSymbolicLink()?'120000':stat.mode&0o111?'100755':'100644',sha256:sha(stat.isSymbolicLink()?Buffer.from(fs.readlinkSync(file)):fs.readFileSync(file))};
 }}visit(root);return result;
}
export function verifyRecoveredBase(repository,destination,recovered,baseline){
 if(!/^[a-f0-9]{40}$/.test(recovered)||!/^[a-f0-9]{40}$/.test(baseline))fail('invalid-commit');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{timeout:5000});
 const proof=JSON.parse(fs.readFileSync(path.join(repository,'tools/agent-workspace/recovered-custody.json'),'utf8'));
 if(proof.kind!=='observed-installed-component-custody-recovery'||proof.recoveredGitCommit!==recovered||proof.originalInstalledCommit!==baseline||proof.originalGitObject!=='unavailable; not forged')fail('binding-mismatch');
 const installed=path.join(destination,'agent-workspace');
 if(fs.realpathSync(installed)!==proof.observedInstalledRoot)fail('installed-target-changed');
 const observed=inventory(installed),expected=proof.inventory;
 if(JSON.stringify(observed)!==JSON.stringify(expected))fail('installed-inventory-changed');
 const entries=git('ls-tree','-r',recovered,'--','tools/agent-workspace').toString().trim().split('\n').map(line=>line.split('\t')[1].replace('tools/agent-workspace/',''));
 if(entries.filter(x=>x!=='deploy').sort().join('\n')!==Object.keys(expected).sort().join('\n'))fail('recovered-inventory-incomplete');
 for(const [name,record]of Object.entries(expected)){
  const object=git('show',recovered+':tools/agent-workspace/'+name);
  const mode=git('ls-tree',recovered,'--','tools/agent-workspace/'+name).toString().split(' ')[0];
  if(sha(object)!==record.sha256||mode!==record.mode)fail('recovered-source-mismatch');
 }
 git('merge-base','--is-ancestor',recovered,'HEAD');
 git('diff','--quiet',recovered,'HEAD','--','tools',':!tools/agent-workspace','config/tools.json');
 return {kind:'verified-recovered-installed-base',baseline,recovered,files:Object.keys(expected).length};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{if(process.argv.length!==6)fail('usage');console.log(JSON.stringify(verifyRecoveredBase(...process.argv.slice(2))));}
 catch(error){console.error(error.message);process.exitCode=65;}
}
