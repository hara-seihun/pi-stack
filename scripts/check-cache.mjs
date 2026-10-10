import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runJob } from './run-jobs.mjs';

const foundation = ['package.json', 'package-lock.json', 'vendor', 'skills', 'scripts/test-node.mjs'];
const packages = ['packages'];
const application = [...packages, 'apps', 'config', 'deploy', 'scripts'];
const deployment = [...application, 'tools'];

export function checkPolicy(name) {
  if (['orchestrator memory build', 'orchestrator types', 'orchestrator shared RPC', 'Kenan build', 'Remote build'].includes(name)) return { kind: 'run' };
  if (name.startsWith('agent workspace ')) return { kind: 'memo', inputs: ['tools/agent-workspace'] };
  if (name.startsWith('orchestrator ')) return { kind: 'memo', inputs: [...packages, 'config', 'apps/remote/shared'] };
  if (['config', 'transport', 'roots', 'core', 'gate', 'bundle', 'source', 'progress', 'proof', 'telephone'].some(suite => name === `publication ${suite}`)) return { kind: 'memo', inputs: deployment };
  const policies = {
    'job lifecycle': deployment,
    'explicit state dispatch': deployment,
    manifests: deployment,
    'account deployment': deployment,
    'deploy lock': deployment,
    'deploy host guest disabled': deployment,
    'deploy host guest enabled': deployment,
    publication: deployment,
    'Android publication': deployment,
    'remote deployment': deployment,
    tools: deployment,
    'user usage': ['tools/user-usage'],
    'Claude reset collector': ['tools/claude-reset'],
    runtime: ['packages/runtime', 'scripts'],
    'runtime dependency closure': deployment,
    'One Kenan deployment': deployment,
    'prompt availability': ['deploy/prompt-availability', 'scripts/prompt-availability.test.py'],
    'Meet recognition protocol': ['apps/meet-recognition'],
    'action journal publication': deployment,
    'mail send boundary': ['tools/mail-send'],
    'Kenan memory': [...packages, 'config'],
    'life import': [...packages, 'scripts/life-import.ts', 'scripts/life-import.test.ts'],
    'Root Kenan': [...packages, 'config', 'scripts'],
    remote: [...packages, 'apps', 'config', 'deploy/android-update', 'deploy/android-native-artifact.mjs', 'deploy/remote-resources.mjs', 'tools/read-condensed-session', 'scripts/migrate-native-history.mjs', 'scripts/build-workspace.mjs'],
    mcp: ['tools/mcp'],
    'mcp-script': ['tools/mcp-script', 'tools/mcp'],
    'session readers': ['tools/read-condensed-session'],
  };
  if (!Object.hasOwn(policies, name)) throw new Error(`No declared check inputs for ${name}`);
  return { kind: 'memo', inputs: policies[name] };
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`Check source inspection failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trimEnd();
}

export function toolchain() {
  const versions = {};
  for (const [command, args] of [['bun', ['--version']], ['python3', ['--version']], ['git', ['--version']], ['npm', ['--version']]]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0) throw new Error(`Cannot identify check tool ${command}`);
    versions[command] = result.stdout.trim();
  }
  return { node: process.version, platform: process.platform, arch: process.arch, ...versions };
}

export function checkKey(root, job, versions) {
  const [name, command, args, options = {}] = job;
  const policy = checkPolicy(name);
  if (policy.kind === 'run') return null;
  const inputs = [...new Set([...foundation, ...policy.inputs])];
  const files = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs]).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  const normalize = value => typeof value === 'string' ? value.replaceAll(root, '$SOURCE') : value;
  hash.update(JSON.stringify({ contract: 'check-pass-v1', name, command: normalize(command), args: args.map(normalize),
    cwd: options.cwd ? relative(root, options.cwd) : '.',
    env: options.checkEnvironment ?? options.env ?? {}, versions }));
  for (const file of files) {
    const path = join(root, file);
    const stat = lstatSync(path);
    hash.update(file).update('\0').update(String(stat.mode)).update('\0')
      .update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

function store(directory, key, receipt) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${key}.json`), temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  renameSync(temporary, target);
}

export function checkExecutor({ root, directory, versions = toolchain(), execute = runJob }) {
  const source = git(root, ['rev-parse', 'HEAD']);
  return async (job, write = text => process.stdout.write(text)) => {
    const key = checkKey(root, job, versions);
    if (key === null) return execute(job, write);
    const path = join(directory, `${key}.json`);
    if (existsSync(path)) {
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.contract !== 'check-pass-v1' || receipt.key !== key || receipt.name !== job[0] || receipt.outcome !== 'passed') throw new Error(`Invalid check receipt ${path}`);
      write(`\n===== ${job[0]}: reused (${key.slice(0, 12)}) =====\n`);
      return { name: job[0], outcome: 'passed', code: 0, signal: null, elapsedMs: 0, reused: path };
    }
    const result = await execute(job, write);
    if (result.outcome === 'passed' && checkKey(root, job, versions) === key) {
      store(directory, key, { contract: 'check-pass-v1', key, name: job[0], source, outcome: 'passed', at: new Date().toISOString(), elapsedMs: result.elapsedMs });
    }
    return result;
  };
}

export async function seedChecks(root, requestPath, directory) {
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  if (!request.integrationSha || !['passed', 'failed'].includes(request.checks?.status) || !request.checks.command.startsWith('npm run check && ')) throw new Error('Request has no completed check command');
  if (git(root, ['rev-parse', 'HEAD']) !== request.integrationSha || git(root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Seed source differs from the actual checked source');
  if (request.workerBootId !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) throw new Error('Seed toolchain custody belongs to another boot');
  for (const command of [process.execPath, 'bun', 'python3', 'git', 'npm']) {
    const located = command.startsWith('/') ? command : spawnSync('which', [command], { encoding: 'utf8', timeout: 1000 }).stdout?.trim();
    if (!located || lstatSync(located).mtimeMs > Date.parse(request.startedAt)) throw new Error(`Seed executable changed after checks: ${command}`);
  }
  const { checkJobs } = await import(pathToFileURL(join(root, 'scripts/test.mjs')).href);
  const log = readFileSync(request.checks.log, 'utf8');
  const versions = toolchain();
  const seeded = [];
  for (const job of checkJobs) {
    const key = checkKey(root, job, versions);
    if (key === null) continue;
    const marker = `===== ${job[0]}: passed (`;
    if (!log.includes(marker)) continue;
    if (log.includes(`===== ${job[0]}: failed (`) || log.includes(`===== ${job[0]}: blocked (`)) continue;
    store(directory, key, { contract: 'check-pass-v1', key, name: job[0], source: request.integrationSha, outcome: 'passed', at: new Date().toISOString(), evidence: { request: resolve(requestPath), log: request.checks.log } });
    seeded.push(job[0]);
  }
  return seeded;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, root, request, directory] = process.argv.slice(2);
  if (action !== 'seed' || !root || !request || !directory) throw new Error('usage: check-cache.mjs seed CHECKED_ROOT REQUEST_JSON CACHE_DIRECTORY');
  console.log(JSON.stringify(await seedChecks(resolve(root), request, directory)));
}
