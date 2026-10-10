import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runJob } from './run-jobs.mjs';
import { inputGraph, planCheck, sourceFiles } from './check-plan.mjs';
export { checkPolicy } from './check-plan.mjs';

const contract = 'check-pass-v2';
const digest = value => createHash('sha256').update(value).digest('hex');
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`check-source-inspection: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trimEnd();
}
function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function fingerprintTree(root, { indexPath, skip = () => false } = {}) {
  const index = indexPath && existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { contract: 'content-index-v1', files: {} };
  if (index.contract !== 'content-index-v1') throw new Error('invalid-content-index');
  const next = { contract: 'content-index-v1', files: {} }, visited = new Set(), hash = createHash('sha256');
  function visit(path, name) {
    if (skip(name, path)) return;
    const stat = lstatSync(path, { bigint: true });
    const identity = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    hash.update(name).update('\0').update(String(stat.mode)).update('\0');
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      hash.update(target).update('\0');
      const actual = realpathSync(path);
      if (!skip(name, actual) && !visited.has(actual)) { visited.add(actual); visit(actual, `${name}@target`); }
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (stat.isFile()) {
      const previous = index.files[path];
      const content = previous?.identity === identity ? previous.content : digest(readFileSync(path));
      next.files[path] = { identity, content };
      hash.update(content).update('\0');
    } else throw new Error(`unsupported-check-input: ${path}`);
  }
  if (!existsSync(root)) return { state: 'absent' };
  visit(root, '');
  if (indexPath) atomicJson(indexPath, next);
  return { state: 'present', digest: hash.digest('hex'), files: Object.keys(next.files).length };
}

export function toolchain(root, directory) {
  const tools = {};
  for (const [command, args] of [[process.execPath, ['--version']], ['bun', ['--version']], ['python3', ['--version']], ['git', ['--version']], ['npm', ['--version']]]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 });
    const located = command.startsWith('/') ? command : spawnSync('which', [command], { encoding: 'utf8', timeout: 1000 }).stdout?.trim();
    if (result.status !== 0 || !located) throw new Error(`unidentified-check-tool: ${command}`);
    tools[command === process.execPath ? 'node' : command] = { version: result.stdout.trim(), executable: digest(readFileSync(realpathSync(located))) };
  }
  const source = resolve(root);
  const skip = (name, path) => name.split('/').some(part => ['.cache', '.vite'].includes(part)) || name.startsWith('.pi-stack-') ||
    ['apps', 'packages', 'tools'].some(area => path.startsWith(`${source}/${area}/`) && !path.split('/').includes('node_modules'));
  const dependencyAreas = ['node_modules', ...sourceFiles(root, ['apps', 'packages', 'tools'])
    .filter(file => /^(?:apps|packages|tools)\/[^/]+\/package\.json$/.test(file))
    .map(file => join(dirname(file), 'node_modules')).filter(path => existsSync(join(root, path)))];
  const dependencies = dependencyAreas.map(area => ({ area, ...fingerprintTree(join(root, area), {
    indexPath: directory ? join(directory, `toolchain-${digest(area).slice(0, 16)}-content-index.json`) : undefined, skip,
  }) })).filter(dependency => dependency.area === 'node_modules' || dependency.files > 0);
  if (dependencies[0].state !== 'present') throw new Error('check-toolchain-unset: node_modules');
  return { platform: process.platform, arch: process.arch, tools, dependencies };
}

const contentCache = new Map();
function fileContent(root, file) {
  const path = join(root, file);
  if (!existsSync(path)) return { path: file, state: 'absent' };
  const stat = lstatSync(path, { bigint: true });
  const identity = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const previous = contentCache.get(path);
  if (previous?.identity === identity && !stat.isSymbolicLink()) return previous.value;
  const value = { path: file, state: 'present', mode: Number(stat.mode),
    digest: stat.isSymbolicLink() ? digest(JSON.stringify(fingerprintTree(path))) : digest(readFileSync(path)) };
  contentCache.set(path, { identity, value });
  return value;
}
function outputs(root, paths) {
  return paths.map(path => ({ path, ...fingerprintTree(join(root, path)) }));
}
function usableOutputs(value) {
  return value.every(output => output.state === 'present' && output.files > 0);
}

export function checkKey(root, job, versions, { graph = inputGraph(root), plan = planCheck(root, job, graph) } = {}) {
  if (plan.kind === 'run') return null;
  const [, command, args, options = {}] = job;
  const normalize = value => typeof value === 'string' ? value.replaceAll(root, '$SOURCE') : value;
  const effective = { ...process.env, ...options.env };
  const names = plan.fullEnvironment ? Object.keys(effective) : [...plan.environment, 'NODE_OPTIONS', 'TZ', 'LANG', 'LC_ALL', 'PATH'];
  const environment = Object.fromEntries([...new Set(names)].sort().map(name => [name, normalize(effective[name] ?? null)]));
  const generated = plan.inputs.filter(path => path.split('/').some(part => part === 'dist')).map(path => ({ path, ...fingerprintTree(join(root, path)) }));
  return digest(JSON.stringify({ contract, name: job[0], command: normalize(command), args: args.map(normalize),
    cwd: options.cwd ? relative(root, options.cwd) : '.', environment, declaredEnvironment: options.checkEnvironment ?? options.env ?? {}, versions,
    coverage: plan.coverage, inputs: plan.inputs, sourceIdentity: plan.sourceIdentity ? git(root, ['rev-parse', 'HEAD']) : undefined,
    files: plan.files.map(file => fileContent(root, file)), generated,
    environmentArtifacts: ['PI_THREAD_TEST_RELEASE'].filter(name => plan.environment.includes(name) && effective[name]).map(name => ({ name, input: fingerprintTree(effective[name]) })) }));
}

export function checkExecutor({ root, directory, versions, execute = runJob }) {
  if (!directory?.startsWith('/')) throw new Error('check-cache-directory-unset-or-relative');
  if (versions === undefined && (resolve(directory) === resolve(root) || resolve(directory).startsWith(`${resolve(root)}/`))) throw new Error('check-cache-must-live-outside-source');
  const source = git(root, ['rev-parse', 'HEAD']);
  const identified = versions ?? toolchain(root, directory);
  const pending = new Map();
  let graph = inputGraph(root);
  const plans = new Map();
  const signature = files => digest(JSON.stringify(files.map(file => fileContent(root, file))));
  let state = signature(graph.files);
  const initialState = state;
  function refresh() {
    const files = sourceFiles(root, ['.']);
    const current = signature(files);
    if (current !== state) {
      graph = inputGraph(root);
      state = current;
      plans.clear();
    }
  }
  const executor = async (job, write = text => process.stdout.write(text)) => {
    const started = performance.now();
    refresh();
    const plan = plans.get(job[0]) ?? planCheck(root, job, graph);
    plans.set(job[0], plan);
    const key = checkKey(root, job, identified, { graph, plan });
    if (key === null) return execute(job, write);
    const path = join(directory, `${key}.json`);
    if (plan.memoizable && existsSync(path)) {
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.contract !== contract || receipt.key !== key || receipt.name !== job[0] || receipt.outcome !== 'passed' || !Array.isArray(receipt.outputs)) throw new Error(`Invalid check receipt ${path}`);
      const actual = outputs(root, plan.outputs ?? []);
      if (usableOutputs(actual) && JSON.stringify(actual) === JSON.stringify(receipt.outputs)) {
        write(`\n===== ${job[0]}: reused (${key.slice(0, 12)}; ${plan.coverage}) =====\n`);
        return { name: job[0], outcome: 'passed', code: 0, signal: null, elapsedMs: performance.now() - started, reused: path, key, coverage: plan.coverage };
      }
    }
    if (['full-source-proof', 'full-environment-proof'].includes(plan.coverage)) write(`\n===== ${job[0]}: ${plan.coverage.replaceAll('-', ' ')} (${plan.reasons.join('; ')}) =====\n`);
    const result = await execute(job, write);
    if (result.outcome === 'passed') {
      refresh();
      const after = planCheck(root, job, graph);
      const produced = outputs(root, plan.outputs ?? []);
      if (checkKey(root, job, identified, { graph, plan: after }) !== key) return { ...result, outcome: 'failed', code: 1, error: 'check-inputs-mutated-during-execution', key, coverage: plan.coverage };
      if (!usableOutputs(produced)) return { ...result, outcome: 'failed', code: 1, error: 'check-output-unset', key, coverage: plan.coverage };
      const receipt = { contract, key, name: job[0], source, outcome: 'passed', coverage: plan.coverage, at: new Date().toISOString(), elapsedMs: result.elapsedMs, outputs: produced };
      if (plan.memoizable) {
        if (versions !== undefined) atomicJson(path, receipt);
        else pending.set(key, { path, receipt, job, plan });
      }
    }
    return { ...result, key, coverage: plan.coverage };
  };
  executor.finalize = () => {
    refresh();
    if (state !== initialState) { pending.clear(); return { state: 'changed-source', error: 'check-source-mutated-during-plan' }; }
    if (versions === undefined && JSON.stringify(toolchain(root, directory)) !== JSON.stringify(identified)) { pending.clear(); return { state: 'changed-toolchain', error: 'check-toolchain-mutated-during-plan' }; }
    const stored = [];
    for (const [key, item] of pending) {
      if (checkKey(root, item.job, identified, { graph, plan: item.plan }) !== key || JSON.stringify(outputs(root, item.plan.outputs ?? [])) !== JSON.stringify(item.receipt.outputs)) {
        pending.clear(); return { state: 'changed-product', error: `check-products-mutated-after-stage: ${item.job[0]}` };
      }
      atomicJson(item.path, item.receipt);
      stored.push(item.receipt.name);
    }
    pending.clear();
    return { state: 'validated', source, stored };
  };
  executor.inspect = job => {
    const plan = planCheck(root, job, graph);
    const key = checkKey(root, job, identified, { graph, plan });
    if (key === null) return { ...plan, key, receipt: null, state: 'always-run' };
    if (!plan.memoizable) return { ...plan, key, receipt: null, state: 'requires-cold-proof' };
    const path = join(directory, `${key}.json`);
    if (!existsSync(path)) return { ...plan, key, receipt: null, state: 'needs-execution' };
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.contract !== contract || receipt.key !== key || receipt.name !== job[0] || receipt.outcome !== 'passed' || !Array.isArray(receipt.outputs)) throw new Error(`Invalid check receipt ${path}`);
    const actual = outputs(root, plan.outputs ?? []);
    return { ...plan, key, receipt: path, state: usableOutputs(actual) && JSON.stringify(actual) === JSON.stringify(receipt.outputs) ? 'reusable' : 'needs-output-repair' };
  };
  return executor;
}

export async function seedChecks() {
  throw new Error('check-receipt-seeding-refused: historical logs do not establish v2 input/toolchain/output custody; execute the cold plan');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('check-receipt-seeding-refused: use scripts/test.mjs with PI_STACK_CHECK_CACHE_DIR');
}
