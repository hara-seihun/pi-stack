import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

export const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
const sourceExtension = /\.[cm]?[jt]sx?$/;
const excluded = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', '__pycache__']);

export function sourceFiles(root, areas) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...areas], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`check-source-inspection: ${result.error?.message ?? result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))].filter(file => !file.split('/').some(part => excluded.has(part))).sort();
}

export function testFiles(root, area, pattern) {
  return sourceFiles(root, [area]).filter(file => pattern.test(file));
}

const shipping = {
  'job lifecycle': ['scripts/run-jobs.mjs', 'scripts/test.mjs', 'scripts/check-plan.mjs', 'scripts/check-cache.mjs', 'packages/runtime'],
  'explicit state dispatch': ['apps', 'packages', 'scripts/check-state-dispatch.mjs'],
  manifests: ['config/packages.json', 'config/skills.json', 'skills'],
  'account deployment': ['deploy', 'config', 'skills'],
  'deploy lock': ['deploy', 'config', 'skills'],
  'deploy host guest disabled': ['deploy', 'config', 'skills', 'apps/remote/server', 'apps/remote/shared', 'apps/meet-recognition', 'packages/kenan-root'],
  'deploy host guest enabled': ['deploy', 'config', 'skills', 'apps/remote/server', 'apps/remote/shared', 'apps/meet-recognition', 'packages/kenan-root'],
  'Android publication': ['deploy', 'apps/kenan/android', 'apps/kenan/release-info.mjs'],
  'remote deployment': ['deploy', 'config', 'apps/remote/server', 'apps/remote/shared', 'apps/remote/skills', 'apps/meet-recognition', 'packages/kenan-root', 'scripts/migrate-native-history.mjs'],
  tools: ['config/tools.json', 'tools'],
  'user usage': ['tools/user-usage'],
  'Claude reset collector': ['tools/claude-reset'],
  'runtime dependency closure': ['deploy/runtime', 'packages/runtime', 'packages/orchestrator', 'packages/kenan-memory', 'packages/kenan-root'],
  'One Kenan deployment': ['deploy', 'config', 'scripts/one-kenan-deploy.test.py'],
  'One Kenan activation': ['deploy/one-kenan-activate', 'deploy/host-plan.mjs', 'deploy/source-scopes.mjs'],
  'prompt availability': ['deploy/prompt-availability', 'scripts/prompt-availability.test.py'],
  'Meet recognition protocol': ['apps/meet-recognition'],
  'action journal publication': ['deploy'],
  'mail send boundary': ['tools/mail-send'],
  'life import': ['scripts/life-import.ts', 'scripts/life-import.test.ts', 'packages/kenan-memory'],
  mcp: ['tools/mcp'],
  'mcp-script': ['tools/mcp-script', 'tools/mcp'],
  'session readers': ['tools/read-condensed-session'],
};
const buildPolicies = {
  'Kenan build': { inputs: ['apps/kenan/build.mjs', 'apps/kenan/package.json', 'apps/remote/web/dist'], outputs: ['apps/kenan/dist'] },
  'orchestrator memory build': { inputs: ['packages/kenan-memory/src', 'packages/kenan-memory/tsconfig.json', 'packages/kenan-memory/package.json'], outputs: ['packages/kenan-memory/dist'], completeScope: true, typeProgram: true },
  'orchestrator types': { inputs: ['packages/orchestrator', 'packages/kenan-memory/src', 'packages/kenan-memory/package.json'], outputs: [], completeScope: true, typeProgram: true },
  'remote prepare': { inputs: ['apps/remote/prepare-check.mjs', 'packages/orchestrator/src', 'packages/orchestrator/tsconfig.build.json', 'packages/orchestrator/tsconfig.json', 'packages/orchestrator/package.json', 'packages/kenan-memory/src', 'packages/kenan-memory/package.json', 'packages/kenan-memory/tsconfig.json', 'packages/kenan-root/src', 'packages/kenan-root/package.json', 'packages/kenan-root/tsconfig.json'], outputs: ['packages/orchestrator/dist', 'packages/kenan-memory/dist', 'packages/kenan-root/dist'], completeScope: true, typeProgram: true },
};

const generatedRuntimeFixtures = new Set([
  'anthropic-narration', 'anthropic-tool-schema', 'bash-cancellation', 'bash-spill', 'codex-service-recovery',
  'extensions/anthropic-beta-guard/guard', 'extensions/browser/browser', 'extensions/codex-compaction/lifecycle',
  'extensions/web-search/web-search', 'model-selection', 'patch-browser-batch-timeout', 'patch-browser-managed-close',
  'patch-browser-semantic-fill', 'session-thinking', 'stack-pi', 'summary-recovery',
].map(path => `runtime test: packages/runtime/${path}.test.mjs`));

export function checkPolicy(name, job) {
  if (name === 'Remote build') return { kind: 'run', reason: 'build-workspace owns compiled-artifact reuse and exact revision metadata reconciliation' };
  if (Object.hasOwn(buildPolicies, name)) return { kind: 'memo', ...buildPolicies[name] };
  if (['orchestrator shared RPC', 'orchestrator tool schemas'].includes(name)) return { kind: 'run', reason: 'idempotent dependency/generated-input reconciliation' };
  if (name.startsWith('publication ')) {
    const suite = name.slice('publication '.length);
    if (!['config', 'transport', 'roots', 'core', 'gate', 'bundle', 'source', 'progress', 'proof', 'telephone', 'continuation', 'preflight', 'host lanes'].includes(suite)) throw new Error(`No declared check inputs for ${name}`);
    return { kind: 'memo', inputs: suite === 'continuation' ? ['deploy/publication-continuation.mjs', 'deploy/publication-timings.mjs'] : suite === 'host lanes' ? ['deploy/publication-hosts.mjs'] : ['deploy', 'config', 'scripts/publication-fixture.mjs', 'apps/meet-recognition'], completeScope: true };
  }
  if (name.startsWith('orchestrator test: ') || name.startsWith('remote test: ') || name.startsWith('runtime test: ') || name.startsWith('memory test: ') || name.startsWith('root test: ')) {
    if (!job?.[3]?.checkInputs?.length) throw new Error(`No declared check entrypoint for ${name}`);
    const generatedOrchestratorFixture = name.startsWith('orchestrator test: ') && /tests\/(?:routing-runtime|runner-browser-budget|runner-budget-cleanup|runner-budget|runner-service|runner-startup|thread-runner)\.test\.ts$/.test(name);
    const fixtures = generatedOrchestratorFixture || ['runtime test: packages/runtime/stack-pi.test.mjs', 'runtime test: packages/runtime/extensions/browser/browser.test.mjs'].includes(name)
      ? ['packages/orchestrator/src', 'packages/kenan-memory/src'] : [];
    return { kind: 'memo', inputs: [...fixtures, ...job[3].checkInputs],
      completeScope: generatedRuntimeFixtures.has(name) || generatedOrchestratorFixture };
  }
  if (name === 'remote types') return { kind: 'memo', inputs: ['apps/remote/server', 'apps/remote/tsconfig.json', 'packages/orchestrator/src', 'packages/kenan-memory/src', 'packages/kenan-root/src'], completeScope: true, typeProgram: true };
  if (Object.hasOwn(shipping, name)) return { kind: 'memo', inputs: shipping[name], completeScope: ['job lifecycle', 'explicit state dispatch', 'manifests', 'tools', 'deploy lock', 'deploy host guest disabled', 'deploy host guest enabled', 'remote deployment', 'runtime dependency closure'].includes(name) };
  throw new Error(`No declared check inputs for ${name}`);
}

export function inputGraph(root) {
  const files = sourceFiles(root, ['.']);
  const available = new Set(files);
  const packages = new Map();
  for (const file of files.filter(file => /^(?:apps|packages|tools)\/[^/]+\/package\.json$/.test(file))) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
    packages.set(manifest.name, { directory: dirname(file), manifest });
  }
  const parsed = new Map();
  const area = prefix => files.filter(file => file === prefix || file.startsWith(`${prefix}/`));
  const local = path => {
    const candidate = relative(root, resolve(root, path));
    const alternatives = [candidate, candidate.replace(/\.js$/, '.ts'), candidate.replace(/\.js$/, '.tsx'), candidate.replace(/\.mjs$/, '.mts'), ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'].map(extension => candidate + extension)];
    return alternatives.find(file => available.has(file));
  };
  function inspect(file) {
    if (parsed.has(file)) return parsed.get(file);
    const info = { files: [], reasons: [], environment: [] };
    parsed.set(file, info);
    if (!sourceExtension.test(file) || !existsSync(join(root, file))) return info;
    if (['scripts/check-plan.mjs', 'scripts/check-cache.mjs', 'scripts/test.mjs'].includes(file)) return info;
    for (let parent = dirname(file); ; parent = dirname(parent)) {
      const manifest = join(parent, 'package.json');
      if (available.has(manifest)) { info.files.push(manifest); break; }
      if (parent === '.') break;
    }
    const source = readFileSync(join(root, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const addImport = specifier => {
      if (specifier.startsWith('node:')) return;
      if (specifier.startsWith('.')) {
        const target = local(join(dirname(file), specifier.replace(/\?(?:raw|url)$/, '')));
        if (target) info.files.push(target);
        else info.reasons.push(`unresolved import ${file}: ${specifier}`);
        return;
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      const workspace = packages.get(name);
      if (!workspace) return;
      const exportName = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
      const exported = workspace.manifest.exports?.[exportName];
      const targets = typeof exported === 'string' ? [exported] : exported && typeof exported === 'object' ? Object.values(exported).filter(value => typeof value === 'string') : [];
      const resolved = targets.map(target => local(join(workspace.directory, target.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts')))).filter(Boolean);
      info.files.push(`${workspace.directory}/package.json`, ...resolved);
      if (!resolved.length) info.files.push(...area(workspace.directory));
    };
    function generatedDestination(node) {
      let child = node;
      for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (!ts.isCallExpression(parent) || parent.arguments[0] !== child) continue;
        const callee = parent.expression.getText(ast);
        if (['writeFileSync', 'writeFile', 'mkdirSync', 'mkdir', 'rmSync', 'rm', 'chmodSync', 'chmod'].includes(callee)) return true;
        if (['scripts/deploy-build.test.mjs', 'scripts/deploy-remote.test.mjs'].includes(file) && callee === 'put') return true;
      }
      return false;
    }
    function readsEnvironment(node) {
      const parent = node.parent;
      if (ts.isDeleteExpression(parent)) return false;
      if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
      return true;
    }
    function visit(node) {
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) addImport(node.argument.literal.text);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) addImport(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        let arg = node.arguments[0];
        while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg))) arg = arg.expression;
        if (arg && ts.isStringLiteralLike(arg)) addImport(arg.text);
        else if (!(file === 'packages/orchestrator/src/threads/pi-session.ts' && arg?.getText(ast) === 'pathToFileURL(join(sdk, "modes/rpc/shared-rpc-mode.js")).href') && !(file === 'packages/orchestrator/tests/thread-http.test.ts' && /^`\$\{release\}\/threads\/[a-z-]+\.js`$/.test(arg?.getText(ast)))) info.reasons.push(`dynamic import ${file}`);
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === 'process.env' && readsEnvironment(node)) info.environment.push(node.name.text);
      if (ts.isElementAccessExpression(node) && node.expression.getText(ast) === 'process.env' && readsEnvironment(node)) {
        if (node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) info.environment.push(node.argumentExpression.text);
        else info.reasons.push(`dynamic environment ${file}`);
      }
      if (ts.isStringLiteralLike(node) && !generatedDestination(node)) {
        const text = node.text;
        if (text.includes('/') && !text.startsWith('/') && !text.includes('://') && !text.includes('\n') && text.split('/').some(part => part && part !== '.' && part !== '..')) {
          const parents = [text];
          for (let parent = dirname(file); parent !== '.'; parent = dirname(parent)) parents.push(join(parent, text));
          for (const candidate of parents) {
            const path = relative(root, resolve(root, candidate));
            if (!path.startsWith('../') && available.has(path)) info.files.push(path);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return info;
  }
  return { files, area, closure(inputs) {
    const pending = inputs.flatMap(input => area(input));
    const found = new Set(), reasons = new Set(), environment = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (found.has(file)) continue;
      found.add(file);
      const info = inspect(file);
      pending.push(...info.files);
      info.reasons.forEach(reason => reasons.add(reason));
      info.environment.forEach(name => environment.add(name));
    }
    return { files: [...found].sort(), reasons: [...reasons].sort(), environment: [...environment].sort() };
  } };
}

export function planCheck(root, job, graph = inputGraph(root)) {
  const policy = checkPolicy(job[0], job);
  if (policy.kind === 'run') return { ...policy, name: job[0], coverage: 'always-run', files: [] };
  const entrypoints = job[2].map(arg => relative(root, resolve(job[3]?.cwd ?? root, arg))).filter(file => graph.files.includes(file));
  const inputs = [...new Set([...policy.inputs, ...entrypoints, 'package.json', 'package-lock.json', 'scripts/check-plan.mjs', 'scripts/check-cache.mjs', 'scripts/run-jobs.mjs', ...(job[3]?.checkInputs ?? [])])];
  const closure = graph.closure([...entrypoints, ...(job[3]?.checkInputs ?? []), ...(policy.typeProgram ? policy.inputs : [])]);
  const declared = inputs.flatMap(input => graph.area(input));
  const unknown = !policy.completeScope && closure.reasons.some(reason => !reason.startsWith('dynamic environment '));
  const unknownEnvironment = !policy.typeProgram && closure.reasons.some(reason => reason.startsWith('dynamic environment '));
  return { ...policy, name: job[0], inputs, files: unknown ? graph.files : [...new Set([...declared, ...closure.files])].sort(),
    coverage: unknown ? 'full-source-proof' : unknownEnvironment ? 'full-environment-proof' : policy.completeScope ? 'complete-declared-scope' : 'declared-import-closure', reasons: closure.reasons, environment: policy.typeProgram ? [] : closure.environment,
    fullEnvironment: unknownEnvironment, memoizable: !unknown && !unknownEnvironment };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync(process.execPath, [join(repository, 'scripts/test.mjs'), '--plan'], { stdio: 'inherit', timeout: 55_000 });
  process.exitCode = result.status === 0 ? 0 : 1;
}
