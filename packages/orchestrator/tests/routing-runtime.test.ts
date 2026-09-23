import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let buildRoot: string, routing: string, ai: string, sdk: string, cli: string;

test.each(['remote', 'remote-physical', 'fleet', 'fleet-reserved', 'fresh-astra', 'fresh-sol', 'fresh-luna'])('binds pooled credentials and keeps the pinned model: %s', async kind => {
  const fresh = kind.startsWith('fresh-');
  const selectedModel = fresh ? `gpt-6-${kind.slice(6)}` : 'gpt-6-luna';
  const root = await mkdtemp(join(tmpdir(), 'pi-pinned-model-'));
  const fixture = join(root, 'fixture.mjs');
  await writeFile(fixture, `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from ${JSON.stringify(sdk)};
import { Store } from ${JSON.stringify(join(buildRoot, 'compiled/store.js'))};
const root=process.env.HOME,dir=join(root,'agent'),account='openai-codex-2';
mkdirSync(dir);
writeFileSync(join(dir,'auth.json'),'{}');
const credential={type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000};
writeFileSync(join(root,'auth.json'),JSON.stringify({[account]:credential,'openai-codex-3':credential}));
const store=Store.open(process.env.PI_ORCHESTRATOR_LEDGER);
store.upsertAccount({id:account,provider:'openai-codex'});
store.upsertAccount({id:'openai-codex-3',provider:'openai-codex'});
if (${JSON.stringify(kind)}.startsWith('fleet')) {
  const [id]=store.createRuns({count:1,source:'direct',prompt:'fixture',cwd:root,profile:'luna',budget:'force'});
  store.assignRun(id,{accountId:account,provider:'openai-codex',model:'gpt-6-luna',thinking:'high',unit:'fixture',releasePath:root});
  process.env.PI_ORCHESTRATOR_RUN_ID=id;
  if(${JSON.stringify(kind)}==='fleet-reserved')store.setControl('account-reservation:'+account,JSON.stringify({metadata:{purpose:'reserved'},reason:'new admissions only'}));
} else process.env.PI_SUBAGENT_MODEL=${JSON.stringify(selectedModel)};
store.close();
const manager=SessionManager.inMemory(root);
if(!${fresh}){
manager.appendModelChange(account,'gpt-6-sol');
manager.appendThinkingLevelChange('high');
manager.appendMessage({role:'assistant',content:[],api:'openai-codex-responses',provider:account,model:'gpt-6-sol',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
}
const settingsManager=SettingsManager.inMemory();
const modelRuntime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json')});
const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:[${JSON.stringify(routing)}]});
await resourceLoader.reload();
const {session}=await createAgentSession({cwd:root,agentDir:dir,modelRuntime,settingsManager,resourceLoader,sessionManager:manager,...(${fresh}?{model:modelRuntime.getModel('openai-codex',${JSON.stringify(selectedModel)}),thinkingLevel:'medium'}:{})});
const errors=[];
try {
  await session.bindExtensions({mode:'print',onError:error=>errors.push(error)});
  assert.deepEqual(errors,[]);
  assert.equal(session.model.id,${JSON.stringify(selectedModel)});
  assert.equal(session.model.provider,account);
  if(${fresh})assert.equal(session.thinkingLevel,'medium');
  await session.setModel(session.modelRuntime.getModel(account,${JSON.stringify(selectedModel === 'gpt-6-sol' ? 'gpt-6-luna' : 'gpt-6-sol')}));
  assert.equal(session.model.id,${JSON.stringify(selectedModel)});
  assert.equal(session.model.provider,account);
  await session.setModel(session.modelRuntime.getModel('openai-codex-3',${JSON.stringify(selectedModel)}));
  assert.equal(session.model.id,${JSON.stringify(selectedModel)});
  assert.equal(session.model.provider,'openai-codex-3');
  assert.deepEqual(errors,[]);
} finally {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
console.log('model pin held');
`);
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_ORCHESTRATOR_LEDGER: join(root, 'ledger.sqlite3'), PI_ORCHESTRATOR_AUTH: join(root, 'auth.json'), PI_ORCHESTRATOR_ASSIGNED: kind.startsWith('fleet') ? '1' : '0', PI_OFFLINE: '1' };
  for (const key of Object.keys(env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key)) delete env[key as keyof typeof env];
  try {
    const result = await promisify(execFile)(process.execPath, [fixture], { cwd: root, env, timeout: 4000 });
    expect(result.stdout).toContain('model pin held');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 6000);

test.each(['explicit', 'family', 'resume', 'reserved', 'cooldown', 'missing-credential'])('fresh ordinary startup honors eligible explicit naming alias: %s', async kind => {
  const root=await mkdtemp(join(tmpdir(),'pi-naming-account-')),fixture=join(root,'fixture.mjs');
  await writeFile(fixture, `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from ${JSON.stringify(sdk)};
import {Store} from ${JSON.stringify(join(buildRoot,'compiled/store.js'))};
const root=process.env.HOME,dir=join(root,'agent'),kind=${JSON.stringify(kind)};
mkdirSync(dir);writeFileSync(join(dir,'auth.json'),'{}');
const credential={type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000};
writeFileSync(join(root,'auth.json'),JSON.stringify({'openai-codex-9':credential,...(kind==='missing-credential'?{}:{'openai-codex-11':credential})}));
const store=Store.open(process.env.PI_ORCHESTRATOR_LEDGER);
for(const [id,spent] of [['openai-codex-11',96],['openai-codex-9',75]]){
  store.upsertAccount({id,provider:'openai-codex'});
  store.recordMeter(id,'codex-7d',spent,Date.now()+86400000,Date.now());
}
if(kind==='reserved')store.setControl('account-reservation:openai-codex-11',JSON.stringify({metadata:{purpose:'other'},reason:'reserved'}));
if(kind==='cooldown')store.setCooldown('openai-codex-11',Date.now()+3600000);
const modelRuntime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json')});
const settingsManager=SettingsManager.inMemory(),manager=SessionManager.inMemory(root);
const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:[${JSON.stringify(routing)}]});
await resourceLoader.reload();
const base=modelRuntime.getModel('openai-codex','gpt-6-luna');
const {session}=await createAgentSession({cwd:root,agentDir:dir,modelRuntime,settingsManager,resourceLoader,sessionManager:manager,model:{...base,provider:kind==='family'||kind==='resume'?'openai-codex':'openai-codex-11'},thinkingLevel:'low',sessionStartEvent:{type:'session_start',reason:kind==='resume'?'resume':'startup'}});
const errors=[];
try{
  await session.bindExtensions({mode:'print',onError:error=>errors.push(error)});
  assert.deepEqual(errors,[]);
  const expected=kind==='explicit'?'openai-codex-11':'openai-codex-9';
  assert.equal(session.model.provider,expected);
  assert.equal(session.model.id,'gpt-6-luna');
  assert.equal(session.thinkingLevel,'low');
  assert.deepEqual(store.activeLeases(),[]);
}finally{await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();store.close();}
console.log('fresh naming account selected');
`);
  const env={...process.env,HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_ORCHESTRATOR_LEDGER:join(root,'ledger.sqlite3'),PI_ORCHESTRATOR_AUTH:join(root,'auth.json'),PI_ORCHESTRATOR_ASSIGNED:'0',PI_OFFLINE:'1'};
  for(const key of Object.keys(env))if(/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key))delete env[key as keyof typeof env];
  try{const result=await promisify(execFile)(process.execPath,[fixture],{cwd:root,env,timeout:4000});expect(result.stdout).toContain('fresh naming account selected');}
  finally{await rm(root,{recursive:true,force:true});}
},6000);

test('native history cannot overwrite an explicit thread model and thinking selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-explicit-model-'));
  const fixture = join(root, 'fixture.mjs');
  await writeFile(fixture, `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SessionManager} from ${JSON.stringify(sdk)};
import {openPiSession} from ${JSON.stringify(process.env.PI_TEST_NATIVE_ENTRY??join(buildRoot,'compiled/threads/pi-session.js'))};
import {seedPiSession} from ${JSON.stringify(join(buildRoot,'compiled/threads/pi-session-file.js'))};
import {Store} from ${JSON.stringify(join(buildRoot,'compiled/store.js'))};
const root=process.env.HOME,agentDir=join(root,'agent'),sessionFile=join(root,'history.jsonl');
mkdirSync(agentDir);writeFileSync(join(agentDir,'auth.json'),'{}');
const credential={type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000};
writeFileSync(join(root,'auth.json'),JSON.stringify({'anthropic-2':credential,'openai-codex-2':credential}));
const store=Store.open(process.env.PI_ORCHESTRATOR_LEDGER);
store.upsertAccount({id:'anthropic-2',provider:'anthropic'});
store.upsertAccount({id:'openai-codex-2',provider:'openai-codex'});
seedPiSession(sessionFile,root);
const history=SessionManager.open(sessionFile);
history.appendModelChange('anthropic-2','claude-fable-5-1');
history.appendThinkingLevelChange('high');
history.appendMessage({role:'assistant',content:[],api:'anthropic-messages',provider:'anthropic-2',model:'claude-fable-5-1',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
let providerRequests=0;
globalThis.fetch=async()=>{providerRequests++;throw new Error('provider request during session open');};
const events=[];
const session=await openPiSession({cwd:root,threadId:'explicit-model',sessionFile,args:['--provider','openai-codex','--model','gpt-6-astra','--thinking','minimal','--extension',${JSON.stringify(routing)}],env:{PI_CODING_AGENT_DIR:agentDir,PI_THREAD_REQUIRE_SESSION:'1'}},event=>events.push(event),()=>{});
try {
  await session.command({type:'get_state',id:'state'});
  const state=events.find(event=>event.id==='state');
  assert.equal(state.success,true,JSON.stringify(state));
  assert.equal(state.data.model.provider,'openai-codex-2');
  assert.equal(state.data.model.id,'gpt-6-astra');
  assert.equal(state.data.thinkingLevel,'minimal');
  assert.equal(providerRequests,0);
} finally {await session.close();store.close();}
console.log('explicit thread model retained');
`);
  const env={...process.env,HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_ORCHESTRATOR_LEDGER:join(root,'ledger.sqlite3'),PI_ORCHESTRATOR_AUTH:join(root,'auth.json'),PI_ORCHESTRATOR_ASSIGNED:'0',PI_OFFLINE:'1'};
  for(const key of Object.keys(env))if(/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key))delete env[key as keyof typeof env];
  try {const result=await promisify(execFile)(process.execPath,[fixture],{cwd:root,env,timeout:5000});expect(result.stdout).toContain('explicit thread model retained');}
  finally {await rm(root,{recursive:true,force:true});}
},7000);

test('binds child accounts before prompting and resolves canonical model commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-child-startup-'));
  const fixture = join(root, 'fixture.mjs');
  await writeFile(fixture, `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openPiSession} from ${JSON.stringify(process.env.PI_TEST_NATIVE_ENTRY??join(buildRoot,'compiled/threads/pi-session.js'))};
import {Store} from ${JSON.stringify(join(buildRoot,'compiled/store.js'))};
const root=process.env.HOME,agentDir=join(root,'agent');
mkdirSync(agentDir);writeFileSync(join(agentDir,'auth.json'),'{}');
const credential={type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000};
const accounts=Array.from({length:12},(_,i)=>'openai-codex-'+(i+2));
writeFileSync(join(root,'auth.json'),JSON.stringify(Object.fromEntries(accounts.map(id=>[id,credential]))));
const store=Store.open(process.env.PI_ORCHESTRATOR_LEDGER);
for(const id of accounts)store.upsertAccount({id,provider:'openai-codex'});
const sessions=[],events=[];
const options={cwd:root,args:['--extension',${JSON.stringify(routing)},'--provider','openai-codex','--model','gpt-6-astra','--thinking','high'],env:{PI_CODING_AGENT_DIR:agentDir}};
const open=child=>openPiSession({...options,threadId:'child-'+child,sessionFile:join(root,child+'.jsonl')},event=>events.push(event),()=>{});
const state=async session=>{const id=crypto.randomUUID();await session.command({type:'get_state',id});const data=events.find(event=>event.id===id).data;return {...data,provider:data.model?.provider,model:data.model?.id};};
try {
  for(let child=0;child<4;child++) {
    const session=await open(child);
    sessions.push(session);
    assert.equal((await state(session)).provider,'openai-codex-10','child '+child);
  }
  await sessions[0].command({type:'set_model',id:'canonical',provider:'openai-codex',modelId:'gpt-6-sol'});
  const reply=events.find(event=>event.id==='canonical');
  assert.equal(reply?.success,true,JSON.stringify(reply));
  assert.equal((await state(sessions[0])).provider,'openai-codex-10');
  assert.equal((await state(sessions[0])).model,'gpt-6-sol');
  assert.equal((await state(sessions[0])).thinkingLevel,'high');
  accounts.forEach((account,index)=>store.setCooldown(account,Date.now()+600000+index*1000));
  const cooling=await open(5);
  sessions.push(cooling);
  assert.equal((await state(cooling)).provider,accounts[0],'admits the cooling account nearest to expiry');
  await sessions[0].command({type:'set_model',id:'cooling',provider:'openai-codex',modelId:'gpt-6-astra'});
  assert.equal(events.find(event=>event.id==='cooling')?.success,true);
  assert.equal((await state(sessions[0])).model,'gpt-6-astra');
  for(const account of accounts)store.setControl('account-reservation:'+account,JSON.stringify({metadata:{purpose:'fixture'},reason:'no interactive admissions'}));
  await assert.rejects(open(6),/No eligible pooled account/);
  const [runId]=store.createRuns({count:1,source:'direct',prompt:'fixture',cwd:root,profile:'astra',budget:'force'});
  store.assignRun(runId,{accountId:'openai-codex-10',provider:'openai-codex',model:'gpt-6-astra',thinking:'high',unit:'fixture',releasePath:root});
  store.setControl('account-reservation:openai-codex-10',JSON.stringify({metadata:{purpose:'assigned'},reason:'new admissions only'}));
  const assigned=await openPiSession({...options,threadId:runId,sessionFile:join(root,'assigned.jsonl'),env:{...options.env,PI_ORCHESTRATOR_ASSIGNED:'1',PI_ORCHESTRATOR_RUN_ID:runId}},event=>events.push(event),()=>{});
  sessions.push(assigned);
  assert.equal((await state(assigned)).provider,'openai-codex-10');
} finally {
  for(const session of sessions)await session.close();
  store.close();
}
console.log('all child accounts bound');
`);
  const env={...process.env,HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_ORCHESTRATOR_LEDGER:join(root,'ledger.sqlite3'),PI_ORCHESTRATOR_AUTH:join(root,'auth.json'),PI_ORCHESTRATOR_ASSIGNED:'0',PI_OFFLINE:'1'};
  for(const key of Object.keys(env))if(/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key))delete env[key as keyof typeof env];
  try {const result=await promisify(execFile)(process.execPath,[fixture],{cwd:root,env,timeout:5000});expect(result.stdout).toContain('all child accounts bound');}
  finally {await rm(root,{recursive:true,force:true});}
},7000);

test('config-only broker discovery supports native model changes with stale availability and plain CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-broker-startup-'));
  const fixture = join(root, 'fixture.mjs'), probe = join(root, 'probe.mjs');
  await writeFile(fixture, `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openPiSession} from ${JSON.stringify(join(buildRoot,'compiled/threads/pi-session.js'))};
import {ModelRuntime} from ${JSON.stringify(sdk)};
import {modelBrokerUrl,loadConfig} from ${JSON.stringify(join(buildRoot,'compiled/api.js'))};
import {Store} from ${JSON.stringify(join(buildRoot,'compiled/store.js'))};
const root=process.env.HOME,agentDir=join(root,'agent');
mkdirSync(agentDir);writeFileSync(join(agentDir,'auth.json'),'{}');
mkdirSync(join(root,'.config/pi-orchestrator'),{recursive:true});
writeFileSync(join(root,'.config/pi-orchestrator/config.json'),JSON.stringify({modelBrokerUrl:'http://127.0.0.1:2461'}));
assert.equal(process.env.PI_MODEL_BROKER_URL,undefined);
assert.equal(modelBrokerUrl(),'http://127.0.0.1:2461');
assert.equal(loadConfig().modelBrokerUrl,'http://127.0.0.1:2461');
// Registration refreshes availability asynchronously. Hold its observation snapshot
// empty while the actual provider catalog and authentication remain ready.
ModelRuntime.prototype.getAvailableSnapshot=function(){return [];};
const checkAuth=ModelRuntime.prototype.checkAuth;
let refuseAuth=false;
ModelRuntime.prototype.checkAuth=function(provider,options){return refuseAuth?Promise.resolve(undefined):checkAuth.call(this,provider,options);};
const sessions=[],events=[];
async function snapshot(session){const id='state-'+events.length;await session.command({type:'get_state',id});return events.find(event=>event.id===id).data;}
try {
  for(const parentId of [null,'parent']) {
    const id=parentId?'child':'root';
    const session=await openPiSession({cwd:root,threadId:id,sessionFile:join(root,id+'.jsonl'),args:['--provider','openai-codex-11','--model','gpt-6-astra','--thinking','high','--extension',${JSON.stringify(routing)}],env:{}},event=>events.push(event),()=>{});
    sessions.push(session);
    assert.equal((await snapshot(session)).model.provider,'openai-codex');
    assert.equal((await snapshot(session)).model.id,'gpt-6-astra');
    assert.equal((await snapshot(session)).thinkingLevel,'high');
    await session.command({type:'set_model',id:'select-'+id,provider:'openai-codex-10',modelId:'gpt-6-sol'});
    const reply=events.find(event=>event.id==='select-'+id);
    assert.equal(reply?.success,true,JSON.stringify(reply));
    assert.equal((await snapshot(session)).model.provider,'openai-codex');
    assert.equal((await snapshot(session)).model.id,'gpt-6-sol');
    refuseAuth=true;
    await session.command({type:'set_model',id:'refused-'+id,provider:'openai-codex',modelId:'gpt-6-luna'});
    const refused=events.find(event=>event.id==='refused-'+id);
    assert.equal(refused?.success,false,JSON.stringify(refused));
    assert.match(refused?.error??'',/No API key/);
    assert.equal((await snapshot(session)).model.id,'gpt-6-sol');
    refuseAuth=false;
  }
} finally {for(const session of sessions)await session.close();}
const store=Store.open(join(root,'.local/share/pi-orchestrator/ledger.sqlite3'));
assert.equal(store.accounts().length,0);assert.equal(store.runs().length,0);store.close();
console.log('config-only native broker ready');
`);
  await writeFile(probe, `import assert from 'node:assert/strict';
export default function(pi){pi.on('input',async(_event,ctx)=>{
  assert.equal(ctx.model.provider,'openai-codex');
  const result=await ctx.modelRegistry.getProviderAuth('openai-codex');
  assert.equal(result.auth.baseUrl,'http://127.0.0.1:2461/backend-api');
  assert.ok(result.auth.apiKey.endsWith('.not-a-credential'));
  console.log('config-only CLI broker ready');
  return {action:'handled'};
});}
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
  for(const key of Object.keys(env))if(/^PI_ORCHESTRATOR_|^PI_MODEL_BROKER_URL$|^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|_API_KEY$/.test(key))delete env[key];
  try {
    const native=await promisify(execFile)(process.execPath,[fixture],{cwd:root,env,timeout:5000});
    expect(native.stdout).toContain('config-only native broker ready');
    const pending=promisify(execFile)(process.execPath,[cli,'--extension',routing,'--extension',probe,'--provider','openai-codex','--model','gpt-6-luna','-p','--no-session','fixture'],{cwd:root,env,timeout:5000});
    pending.child.stdin!.end();
    const ordinary=await pending;
    expect(ordinary.stdout + ordinary.stderr).toContain('config-only CLI broker ready');
    expect(ordinary.stderr).not.toContain('Extension error');
  } finally {await rm(root,{recursive:true,force:true});}
},12000);

test('activity leases release retained idle children without releasing their active parent or sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-routing-activity-'));
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_ORCHESTRATOR_LEDGER: join(root, 'ledger.sqlite3'), PI_ORCHESTRATOR_AUTH: join(root, 'auth.json'), PI_ORCHESTRATOR_ASSIGNED: '0', PI_OFFLINE: '1', TEST_SDK: sdk, TEST_AI: ai, TEST_STORE: join(buildRoot, 'compiled/store.js'), TEST_ROUTING: routing };
  for (const key of Object.keys(env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key)) delete env[key as keyof typeof env];
  try {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/routing-activity.mjs', import.meta.url))], { cwd: root, env, timeout: 4000 });
    expect(result.stdout).toContain('activity leases released; retained idle child kept affinity');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 6000);

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'pi-routing-build-'));
  await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(buildRoot, 'node_modules'));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', fileURLToPath(new URL('../tsconfig.build.json', import.meta.url)), '--outDir', join(buildRoot, 'compiled')], { timeout: 20_000 });
  await writeFile(join(buildRoot, 'package.json'), '{"type":"module"}');
  routing = process.env.PI_TEST_ROUTING_ENTRY ?? join(buildRoot, 'compiled/extension/routing.js');
  [sdk, ai] = JSON.parse(execFileSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e', `console.log(JSON.stringify(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].map(name => import.meta.resolve(name, process.argv[1]))))`, pathToFileURL(routing).href], { encoding: 'utf8' })) as [string, string];
  cli = join(dirname(fileURLToPath(sdk)), 'bundle/cli.js');
}, 25_000);
afterAll(async () => { if (buildRoot) await rm(buildRoot, { recursive: true, force: true }); });

test.each(['0', '1'])('bundled CLI cleans extension-provider resources on shutdown, assigned=%s', async assigned => {
  const root = await mkdtemp(join(tmpdir(), 'pi-provider-cleanup-'));
  // Match source extensions' Pi import aliases or compiled providers' native ESM registry.
  const fixture = join(root, routing.endsWith('.ts') ? 'fixture.ts' : 'fixture.mjs');
  await writeFile(fixture, `import { registerSessionResourceCleanup } from ${JSON.stringify(routing.endsWith('.ts') ? '@earendil-works/pi-ai' : ai)};
export default function(pi) {
  pi.on('session_start', (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const timer = setInterval(() => {}, 60000);
    const unregister = registerSessionResourceCleanup(sessionId => {
      if (sessionId !== id) return;
      clearInterval(timer); unregister();
      process.stdout.write('provider-resource-closed\\n');
    });
  });
  pi.on('input', () => {
    if (pi.getActiveTools().length) throw new Error('--no-tools was overridden');
    return { action: 'handled' };
  });
}
`);
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_ORCHESTRATOR_LEDGER: join(root, 'ledger.sqlite3'), PI_ORCHESTRATOR_ASSIGNED: assigned, PI_SKIP_VERSION_CHECK: '1' };
  for (const key of Object.keys(env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$/.test(key)) delete env[key as keyof typeof env];
  try {
    const pending = promisify(execFile)(process.execPath, [cli, '--print', '--no-session', '--no-tools', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-approve', '--model', 'openai-codex/gpt-6-astra', '-e', routing, '-e', fixture, 'handled locally'], { cwd: root, env, timeout: 4000 });
    pending.child.stdin!.end();
    const result = await pending;
    expect(result.stdout + result.stderr).toContain('provider-resource-closed');
    expect(result.stderr).not.toContain('Extension error');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 6000);

test.each(['anthropic', 'openai-codex'])('restores saved thinking with late provider registration and account replacement: %s', async family => {
  const root = await mkdtemp(join(tmpdir(), 'pi-routing-thinking-'));
  const fixture = join(root, 'fixture.mjs');
  await writeFile(fixture, `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from ${JSON.stringify(sdk)};
import { Store } from ${JSON.stringify(join(buildRoot, 'compiled/store.js'))};
const family = ${JSON.stringify(family)};
const modelId = family === 'anthropic' ? 'claude-fable-5-1' : 'gpt-6-astra';
const root = process.env.HOME;
const dir = join(root, 'agent');
mkdirSync(dir);
writeFileSync(join(dir, 'auth.json'), '{}');
writeFileSync(join(root, 'auth.json'), JSON.stringify({[family + '-2']: {type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000}}));
const store = Store.open(process.env.PI_ORCHESTRATOR_LEDGER);
store.upsertAccount({id:family + '-2',provider:family});
store.close();
const settingsManager = SettingsManager.inMemory({defaultThinkingLevel:'low'});
for (const account of [family + '-2', family + '-99']) {
  for (const thinking of ['high', 'minimal', 'max']) {
    const sm = SessionManager.inMemory(root);
    sm.appendModelChange(account, modelId);
    sm.appendThinkingLevelChange(thinking);
    sm.appendMessage({role:'assistant',content:[],api:family === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses',provider:account,model:modelId,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
    const modelRuntime = await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json')});
    const resourceLoader = new DefaultResourceLoader({cwd:root,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:[${JSON.stringify(routing)}]});
    await resourceLoader.reload();
    const {session} = await createAgentSession({cwd:root,agentDir:dir,modelRuntime,settingsManager,resourceLoader,sessionManager:sm});
    assert.equal(session.model.reasoning, false);
    assert.equal(session.thinkingLevel, 'off');
    const errors = [];
    try {
      await session.bindExtensions({mode:'print',onError:e=>errors.push(e)});
      assert.deepEqual(errors, []);
      assert.equal(session.getActiveToolNames().includes('image_generation'), family === 'openai-codex');
      assert.equal(session.model.provider, family + '-2');
      assert.equal(session.model.id, modelId);
      assert.equal(session.thinkingLevel, thinking);
      assert.equal(sm.buildSessionContext().thinkingLevel, thinking);
    } finally { await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); session.dispose(); }
    await resourceLoader.reload();
    const {session: overridden} = await createAgentSession({cwd:root,agentDir:dir,modelRuntime,settingsManager,resourceLoader,sessionManager:sm,thinkingLevel:'low',tools:[]});
    try {
      assert.equal(overridden.thinkingLevel, 'low');
      await overridden.bindExtensions({mode:'print',onError:e=>errors.push(e)});
      assert.deepEqual(errors, []);
      assert.equal(overridden.thinkingLevel, 'low');
      assert.deepEqual(overridden.getActiveToolNames(), []);
    } finally { await overridden.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); overridden.dispose(); }
  }
}
console.log('saved thinking restored');
`);
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_ORCHESTRATOR_LEDGER: join(root, 'ledger.sqlite3'), PI_ORCHESTRATOR_AUTH: join(root, 'auth.json'), PI_ORCHESTRATOR_ASSIGNED: '0', PI_OFFLINE: '1' };
  for (const key of Object.keys(env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_SUBAGENT_MODEL$|^PI_THREAD_EXPLICIT_MODEL$|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key)) delete env[key as keyof typeof env];
  try {
    const result = await promisify(execFile)(process.execPath, [fixture], { cwd: root, env, timeout: 4000 });
    expect(result.stdout).toContain('saved thinking restored');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 6000);

