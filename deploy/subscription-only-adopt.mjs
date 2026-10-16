import {readFileSync,writeFileSync,renameSync,statSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const [rootArg,service,proofPath]=process.argv.slice(2);
try {
  if(process.getuid()!==0 || !rootArg || service!=='pi-model-broker.service' || !proofPath)throw Error('Owning root, exact broker service and frozen projection proof are required');
  const root=realpathSync(rootArg),proof=JSON.parse(readFileSync(proofPath,'utf8'));
  if(statSync(proofPath).uid!==0 || statSync(proofPath).mode&0o022)throw Error('Projection proof must be root-owned without external write access');
  const binding=JSON.parse(readFileSync(join(root,'subscription-only-binding.json'),'utf8'));
  if(!/^[a-f0-9]{40}$/.test(proof.source) || proof.source!==binding.source || proof.root!==root)throw Error('Frozen source binding differs from selected artifact');
  const required=['dist/model-broker.js','dist/auth/subscription-only.js','dist/auth/shared-oauth.js','dist/auth/pooled-only.js','dist/auth/anthropic-files-provider.js'];
  if(readFileSync(join(root,'dist/model-broker.js'),'utf8').includes('./experiment-custody.js'))required.push('dist/experiment-custody.js');
  if(!Array.isArray(proof.files) || proof.files.length!==required.length || new Set(proof.files.map(f=>f.path)).size!==required.length)throw Error('Incomplete source projection proof');
  const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  for(const f of proof.files){if(!required.includes(f.path) || sha(join(root,f.path))!==f.sha256)throw Error('Frozen module hash mismatch');}
  const pid=Number(execFileSync('systemctl',['show',service,'--property=MainPID','--value'],{encoding:'utf8'}).trim());
  if(!(pid>0) || !readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').includes(join(root,'dist/cli.js')))throw Error('Loaded broker command differs from frozen source');
  const grants=JSON.parse(readFileSync('/etc/pi-model-broker.json','utf8'));
  const serviceUser=execFileSync('systemctl',['show',service,'--property=User','--value'],{encoding:'utf8'}).trim();
  if(!serviceUser)throw Error('Broker service Unix owner is unset');
  execFileSync('runuser',['-u',serviceUser,'--',process.execPath,'--input-type=module','-e',"import{readFileSync}from'node:fs';for(const p of process.argv.slice(1))readFileSync(p);",'/etc/pi-model-broker.json',...required.map(p=>join(root,p))],{timeout:5000});
  for(const listener of grants.listeners){const ready=await fetch(`http://127.0.0.1:${listener.port}/v1/dispatches`,{signal:AbortSignal.timeout(3000)});if(ready.status!==200)throw Error('Broker listener readiness failed');await ready.body?.cancel();}
  const causal=JSON.parse(execFileSync(process.execPath,[join(root,'subscription-only-check.mjs'),root],{encoding:'utf8',timeout:15000}));
  if(causal.ok!==true || causal.networkCalls!==0)throw Error('Installed subscription-only causal proof failed');
  const configPath='/usr/local/lib/pi-subscription-only/host.json',old=readFileSync(configPath),config=JSON.parse(old.toString('utf8'));
  if(config.broker.kind!=='local-service' || config.broker.service!==service)throw Error('Host guard has another broker owner');
  const prior=config.broker.root;config.broker.root=root;
  config.bindings=[...config.bindings.filter(f=>!f.path.startsWith(prior+'/')),...proof.files.map(f=>({path:join(root,f.path),sha256:f.sha256}))];
  const proofBinding={path:proofPath,sha256:sha(proofPath)};
  config.bindings=config.bindings.filter(f=>f.path!==proofPath);config.bindings.push(proofBinding);
  const next=configPath+'.adoption-next';writeFileSync(next,JSON.stringify(config),{mode:0o600});renameSync(next,configPath);
  try{const checked=JSON.parse(execFileSync(process.execPath,['/usr/local/lib/pi-subscription-only/check.mjs'],{encoding:'utf8',timeout:25000}));if(checked.ok!==true)throw Error('Host guard did not accept the frozen projection');console.log(JSON.stringify({ok:true,source:proof.source,root,loadedPid:pid,priorRoot:prior,proof:proofBinding,hostCheck:checked}));}
  catch(error){writeFileSync(next,old,{mode:0o600});renameSync(next,configPath);throw error;}
} catch(error) {console.log(JSON.stringify({ok:false,error:{code:'broker_source_adoption_failed',message:error instanceof Error?error.message:String(error)}}));process.exitCode=1;}
