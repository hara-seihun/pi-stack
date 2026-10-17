import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inventory,verifyRecoveredBase} from './recovered-base.mjs';
const tool=path.dirname(fileURLToPath(import.meta.url));
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:5000}).trim();
test('missing original Git can be recovered only from complete exact installed inventory, under normal tools publication fences',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-recovered-custody-'));
 try{
  const root=path.join(tmp,'source'),component=path.join(root,'tools/agent-workspace');fs.mkdirSync(component,{recursive:true});fs.mkdirSync(path.join(root,'deploy'));
  for(const name of ['lib','release-checkout'])fs.copyFileSync(path.join(tool,'../../deploy',name),path.join(root,'deploy',name));
  fs.copyFileSync(path.join(tool,'deploy'),path.join(component,'deploy'));fs.chmodSync(path.join(component,'deploy'),0o755);
  fs.writeFileSync(path.join(component,'workspace.mjs'),'console.log("Usage: agent-workspace fixture");\n');fs.chmodSync(path.join(component,'workspace.mjs'),0o755);fs.symlinkSync('workspace.mjs',path.join(component,'main'));
  fs.writeFileSync(path.join(component,'README.md'),'retained snapshot\n');
  const baseline='0'.repeat(40),releases=path.join(tmp,'releases'),selected=path.join(releases,'tools',baseline);fs.mkdirSync(selected,{recursive:true});fs.cpSync(component,path.join(selected,'agent-workspace'),{recursive:true,verbatimSymlinks:true});fs.rmSync(path.join(selected,'agent-workspace/deploy'));
  fs.writeFileSync(path.join(selected,'.pi-stack-commit'),baseline+'\n');fs.mkdirSync(path.join(selected,'other'));fs.writeFileSync(path.join(selected,'other/body'),'preserve\n');fs.mkdirSync(path.join(tmp,'deps'));fs.symlinkSync(path.join(tmp,'deps'),path.join(selected,'node_modules'));
  const dest=path.join(tmp,'tools');fs.symlinkSync(selected,dest);
  git(root,'init','-b','main');git(root,'config','user.name','Test');git(root,'config','user.email','test@example.invalid');git(root,'add','.');git(root,'commit','-m','recovered snapshot, original object unavailable');const recovered=git(root,'rev-parse','HEAD');
  const proof={kind:'observed-installed-component-custody-recovery',recoveredGitCommit:recovered,originalInstalledCommit:baseline,originalGitObject:'unavailable; not forged',observedInstalledRoot:fs.realpathSync(path.join(dest,'agent-workspace')),inventory:inventory(path.join(dest,'agent-workspace'))};
  fs.writeFileSync(path.join(component,'recovered-custody.json'),JSON.stringify(proof));fs.copyFileSync(path.join(tool,'recovered-base.mjs'),path.join(component,'recovered-base.mjs'));fs.appendFileSync(path.join(component,'README.md'),'new candidate\n');git(root,'add','.');git(root,'commit','-m','candidate');const candidate=git(root,'rev-parse','HEAD');
  assert.equal(verifyRecoveredBase(root,dest,recovered,baseline).files,3);
  fs.appendFileSync(path.join(dest,'agent-workspace/README.md'),'changed\n');assert.throws(()=>verifyRecoveredBase(root,dest,recovered,baseline),/inventory-changed/);fs.writeFileSync(path.join(dest,'agent-workspace/README.md'),'retained snapshot\n');
  fs.writeFileSync(path.join(dest,'agent-workspace/unknown'),'unknown');assert.throws(()=>verifyRecoveredBase(root,dest,recovered,baseline),/inventory-changed/);fs.rmSync(path.join(dest,'agent-workspace/unknown'));
  assert.throws(()=>verifyRecoveredBase(root,dest,recovered,'f'.repeat(40)),/binding-mismatch/);
  const env={...process.env,PI_STACK_TOOLS_DEST:dest,PI_STACK_RELEASES_ROOT:releases,PI_STACK_HOST_LOCK_PATH:path.join(tmp,'host.lock'),PI_STACK_DEPLOY_NO_SUDO:'1'};for(const key of ['PI_STACK_HOST_LOCK_HELD','PI_STACK_DEPLOY_LOCK_HELD','PI_STACK_DEPLOY_DEADLINE_ACTIVE','PI_STACK_PUBLICATION_REQUEST'])delete env[key];
  const output=execFileSync(path.join(component,'deploy'),[],{env,encoding:'utf8',timeout:10000});assert.match(output,/verified-recovered-installed-base/);assert.equal(fs.readlinkSync(dest),path.join(releases,'tools',candidate));assert.equal(fs.readFileSync(path.join(dest,'other/body'),'utf8'),'preserve\n');assert.equal(fs.readlinkSync(path.join(dest,'node_modules')),path.join(tmp,'deps'));assert.equal(fs.readFileSync(path.join(selected,'agent-workspace/README.md'),'utf8'),'retained snapshot\n');
  // Reversible immutable release selection; live registry was never part of this fixture.
  const swap=dest+'.rollback';fs.symlinkSync(selected,swap);fs.renameSync(swap,dest);assert.equal(fs.realpathSync(dest),selected);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
