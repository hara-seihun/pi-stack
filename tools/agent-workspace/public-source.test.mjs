import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
for(const existing of [false,true])test('component publication preserves source refs, existing projection='+existing,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'component-publication-')),repo=path.join(root,'source'),remote=path.join(root,'public.git');
 const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],...options}).trim();
 const git=(...args)=>run('git',['-C',repo,...args]);
 try{
  fs.mkdirSync(path.join(repo,'tools/agent-workspace'),{recursive:true});run('git',['init','--bare',remote]);git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  const script=path.join(repo,'tools/agent-workspace/public-source');fs.copyFileSync(new URL('./public-source',import.meta.url),script);fs.writeFileSync(path.join(repo,'tools/agent-workspace/value'),'control');fs.writeFileSync(path.join(repo,'unrelated'),'unchanged');git('add','.');git('commit','-m','parent');const parent=git('rev-parse','HEAD');git('push',remote,parent+':refs/heads/main');
  if(existing)git('update-ref','refs/heads/agent/workspace-component-public',parent);
  fs.writeFileSync(path.join(repo,'tools/agent-workspace/value'),'candidate');git('commit','-am','source');const source=git('rev-parse','HEAD'),before=git('for-each-ref','--format=%(refname) %(objectname)');
  const receipt=run('bash',[script,remote,parent,source]);const projected=receipt.match(/^public ([a-f0-9]{40})$/m)?.[1];assert(projected,receipt);assert.equal(run('git',['--git-dir='+remote,'rev-parse','refs/heads/main']),projected);
  assert.equal(git('for-each-ref','--format=%(refname) %(objectname)'),before);assert.equal(git('status','--porcelain'),'');assert.equal(git('show',projected+':tools/agent-workspace/value'),'candidate');assert.equal(git('show',projected+':unrelated'),'unchanged');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
