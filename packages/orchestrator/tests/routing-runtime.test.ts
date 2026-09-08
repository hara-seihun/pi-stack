import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let buildRoot: string, routing: string, ai: string, sdk: string, cli: string;
beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'pi-routing-build-'));
  await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(buildRoot, 'node_modules'));
  await promisify(execFile)('tsc', ['-p', fileURLToPath(new URL('../tsconfig.build.json', import.meta.url)), '--outDir', join(buildRoot, 'compiled')], { timeout: 5000 });
  await writeFile(join(buildRoot, 'package.json'), '{"type":"module"}');
  routing = process.env.PI_TEST_ROUTING_ENTRY ?? join(buildRoot, 'compiled/extension/routing.js');
  [sdk, ai] = JSON.parse(execFileSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e', `console.log(JSON.stringify(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].map(name => import.meta.resolve(name, process.argv[1]))))`, pathToFileURL(routing).href], { encoding: 'utf8' })) as [string, string];
  cli = join(dirname(fileURLToPath(sdk)), 'bundle/cli.js');
});
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
  pi.on('input', () => ({ action: 'handled' }));
}
`);
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_ORCHESTRATOR_LEDGER: join(root, 'ledger.sqlite3'), PI_ORCHESTRATOR_ASSIGNED: assigned, PI_SKIP_VERSION_CHECK: '1' };
  for (const key of Object.keys(env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_ORCHESTRATOR_RUN_ID$/.test(key)) delete env[key as keyof typeof env];
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
      assert.equal(session.model.provider, family + '-2');
      assert.equal(session.model.id, modelId);
      assert.equal(session.thinkingLevel, thinking);
      assert.equal(sm.buildSessionContext().thinkingLevel, thinking);
    } finally { await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); session.dispose(); }
    await resourceLoader.reload();
    const {session: overridden} = await createAgentSession({cwd:root,agentDir:dir,modelRuntime,settingsManager,resourceLoader,sessionManager:sm,thinkingLevel:'low'});
    try {
      assert.equal(overridden.thinkingLevel, 'low');
      await overridden.bindExtensions({mode:'print',onError:e=>errors.push(e)});
      assert.deepEqual(errors, []);
      assert.equal(overridden.thinkingLevel, 'low');
    } finally { await overridden.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); overridden.dispose(); }
  }
}
console.log('saved thinking restored');
`);
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_ORCHESTRATOR_LEDGER: join(root, 'ledger.sqlite3'), PI_ORCHESTRATOR_AUTH: join(root, 'auth.json'), PI_ORCHESTRATOR_ASSIGNED: '0', PI_OFFLINE: '1' };
  for (const key of Object.keys(env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_ORCHESTRATOR_RUN_ID$|_API_KEY$/.test(key)) delete env[key as keyof typeof env];
  try {
    const result = await promisify(execFile)(process.execPath, [fixture], { cwd: root, env, timeout: 4000 });
    expect(result.stdout).toContain('saved thinking restored');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 6000);

