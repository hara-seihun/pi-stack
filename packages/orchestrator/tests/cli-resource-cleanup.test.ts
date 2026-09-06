import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [agentEntry, aiEntry] = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `console.log(JSON.stringify(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].map(name => import.meta.resolve(name))))`], { encoding: 'utf8' })) as string[];
const cli = join(dirname(fileURLToPath(agentEntry!)), 'bundle/cli.js');
const ai = fileURLToPath(aiEntry!);
let buildRoot: string, routing: string;
beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'pi-routing-build-'));
  await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(buildRoot, 'node_modules'));
  await promisify(execFile)('tsc', ['-p', fileURLToPath(new URL('../tsconfig.build.json', import.meta.url)), '--outDir', join(buildRoot, 'compiled')], { timeout: 5000 });
  await writeFile(join(buildRoot, 'package.json'), '{"type":"module"}');
  routing = join(buildRoot, 'compiled/extension/routing.js');
});
afterAll(async () => { if (buildRoot) await rm(buildRoot, { recursive: true, force: true }); });

test.each(['0', '1'])('bundled CLI cleans extension-provider resources on shutdown, assigned=%s', async assigned => {
  const root = await mkdtemp(join(tmpdir(), 'pi-provider-cleanup-'));
  const fixture = join(root, 'fixture.mjs');
  await writeFile(fixture, `import { registerSessionResourceCleanup } from ${JSON.stringify(ai)};
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
