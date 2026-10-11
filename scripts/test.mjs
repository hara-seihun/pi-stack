import { pathToFileURL } from "node:url";
import { checkParallelism, runJobs } from "./run-jobs.mjs";
import { orchestratorTestChecks } from "../packages/orchestrator/scripts/check.mjs";
import { checkExecutor } from './check-cache.mjs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { repository as root, testFiles } from './check-plan.mjs';

const jobs = [
  ["job lifecycle", "node", ["--test", "scripts/run-jobs.test.mjs", "scripts/check-cache.test.mjs", "scripts/check-plan.test.mjs", "scripts/orchestrator-check.test.mjs", "scripts/check-state-dispatch.test.mjs"]],
  ["explicit state dispatch", "node", ["scripts/check-state-dispatch.mjs"]],
  ...orchestratorTestChecks(testFiles(root, 'packages/orchestrator/tests', /\.test\.tsx?$/).map(file => ({
    name: `orchestrator test: ${relative('packages/orchestrator', file)}`,
    args: [relative('packages/orchestrator', file)],
  }))).map(job => job[0].startsWith('orchestrator test: ') ? [job[0], job[1], job[2], {
    ...job[3], checkInputs: ['packages/orchestrator/' + job[2].at(-1), 'packages/orchestrator/tests/setup.ts', 'packages/orchestrator/vitest.config.ts'],
  }] : job),
  ["Remote build", "node", ["scripts/build-workspace.mjs", "remote"]],
  ["Kenan build", "npm", ["run", "build", "--workspace=kenan"], { dependsOn: ["Remote build"] }],
  ["manifests", "node", ["scripts/check-manifests.mjs"]],
  ["account deployment", "node", ["--test", "scripts/deploy-skills.test.mjs", "scripts/deploy-account.test.mjs", "scripts/deploy-person-configs.test.mjs"]],
  ["deploy lock", "node", ["--test", "--test-skip-pattern=^host deployment activates Pi Remote", "scripts/deploy-lock.test.mjs", "scripts/deploy-runtime.test.mjs", "scripts/deploy-runtime-prepared.test.mjs", "scripts/prepared-components.test.mjs", "scripts/host-fast-path.test.mjs", "scripts/doctor-cache.test.mjs", "scripts/deploy-build.test.mjs", "scripts/deploy-prepare.test.mjs", "scripts/deploy-download.test.mjs", "scripts/deploy-retain.test.mjs", "scripts/release-checkout.test.mjs", "scripts/check-services.test.mjs"]],
  ...["disabled", "enabled"].map(guest => [
    `deploy host guest ${guest}`, "node", ["--test",
      `--test-name-pattern=^host deployment activates Pi Remote and reconciles daemons with guest ${guest}$`,
      "scripts/deploy-lock.test.mjs"],
  ]),
  ...["config", "transport", "roots", "core", "gate", "bundle", "source", "progress", "proof", "continuation", "preflight", "post"].map(suite => [
    `publication ${suite}`, "node", ["--test", ...(suite === 'continuation' ? ['scripts/publication-continuation.test.mjs', 'scripts/publication-timings.test.mjs'] : [suite === "core" ? "scripts/publication.test.mjs" : `scripts/publication-${suite}.test.mjs`])],
    { timeoutMs: 55_000 },
  ]),
  ["publication telephone", "node", ["--test", "--test-name-pattern=live-telephone|telephone phone-census", "scripts/publication-hosts.test.mjs"], { timeoutMs: 55_000 }],
  ['publication host lanes', 'node', ['--test', 'scripts/publication-host-lanes.test.mjs'], { timeoutMs: 55_000 }],
  ["Android publication", "node", ["--test", "scripts/android-update.test.mjs", "scripts/android-prepared-native.test.mjs"]],
  ["remote deployment", "node", ["--test", "scripts/deploy-remote.test.mjs", "scripts/deploy-voice.test.mjs", "scripts/deploy-phone.test.mjs", "scripts/phone-census.test.mjs", "scripts/meet-recognition-service.test.mjs", "scripts/meet-recognition-host.test.mjs", "scripts/meet-recognition-retain.test.mjs", "scripts/supervisor-health.test.mjs", "scripts/native-history-owner-status.test.mjs"]],
  ["tools", "node", ["scripts/check-tools.mjs"]],
  ["user usage", "node", ["--test", "tools/user-usage/usage.test.mjs"]],
  ["Claude reset collector", "node", ["--test", "tools/claude-reset/collect.test.mjs"]],
  ...testFiles(root, 'packages/runtime', /\.test\.mjs$/).map(file => [`runtime test: ${file}`, 'node', ['--test', file], { checkInputs: [file] }]),
  ['runtime dependency closure', 'node', ['--test', 'scripts/deploy-runtime-closure.test.mjs'], { dependsOn: ['orchestrator memory build'], timeoutMs: 55_000 }],
  ['core host bindings', 'node', ['--test', 'scripts/core-host.test.mjs']],
  ['core writer custody bindings', 'python3', ['-B', 'scripts/core-writer-bindings.test.py']],
  ['core helper artifact immutability', 'python3', ['-B', 'scripts/core-helper-immutability.test.py']],
  ['core generation adoption', 'python3', ['-B', 'scripts/core-adopt.test.py']],
  ['publication dependency retention', 'python3', ['-B', 'scripts/integration-retain.test.py']],
  ["prompt availability", "python3", ["-B", "scripts/prompt-availability.test.py"]],
  ["Meet recognition protocol", "python3", ["-B", "-m", "unittest", "discover", "-s", "apps/meet-recognition", "-p", "test_protocol.py"]],
  ["action journal publication", "bun", ["test", "deploy/action-journal.test.ts"]],
  ["mail send boundary", "python3", ["-B", "tools/mail-send/test_send.py"]],
  ["raw outbound boundary", "python3", ["-B", "tools/raw-outbound-guard/test_guard.py"]],
  ["provider rollback boundary", "node", ["--test", "scripts/remote-rollback-compatible.test.mjs"]],
  ...testFiles(root, 'packages/kenan-memory/tests', /\.test\.tsx?$/).map(file => [`memory test: ${file}`, 'bun', ['test', file], { checkInputs: [file] }]),
  ["memory adoption", "bun", ["test", "packages/kenan-memory/tests/adoption.test.ts", "packages/orchestrator/tests/permissions.test.ts"]],
  ...testFiles(root, 'packages/kenan-root/tests', /\.test\.tsx?$/).map(file => [`root test: ${file}`, 'bun', ['test', file], { checkInputs: [file] }]),
  ['remote prepare', 'node', ['apps/remote/prepare-check.mjs'], { dependsOn: ['orchestrator memory build'] }],
  ['remote types', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: join(root, 'apps/remote'), dependsOn: ['remote prepare'] }],
  ...['server', 'web', 'shared'].flatMap(area => testFiles(root, `apps/remote/${area}`, /\.test\.tsx?$/)).map(file => [
    `remote test: ${file}`, 'bun', ['test', relative('apps/remote', file)],
    { cwd: join(root, 'apps/remote'), checkInputs: [file], dependsOn: ['Remote build', 'remote prepare', 'orchestrator shared RPC'] },
  ]),
  ["mcp", "npm", ["test", "--workspace=@hara-seihun/mcp-cli"]],
  ["mcp-script", "npm", ["test", "--workspace=@hara-seihun/mcp-script"]],
  ["session readers", "npm", ["test", "--workspace=@hara-seihun/read-condensed-session"]],
];

export const checkJobs = jobs.map(([name, command, args, options = {}]) => [
  name, command, args[0] === "--test" ? ["scripts/test-node.mjs", ...args.slice(1)] : args, { cwd: root, ...options },
]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.PI_STACK_CHECK_CACHE_DIR;
  if (directory !== undefined && !directory.startsWith('/')) throw new Error('PI_STACK_CHECK_CACHE_DIR must be absolute');
  if (process.argv.slice(2).some(arg => arg !== '--plan')) throw new Error('usage: node scripts/test.mjs [--plan]');
  for (const patch of ['patch-shared-rpc.mjs', 'patch-anthropic-tool-schema.mjs']) {
    execFileSync(process.execPath, [join(root, 'packages/runtime', patch), join(root, 'node_modules')], { stdio: 'inherit', timeout: 10_000 });
  }
  const execute = directory === undefined ? undefined : checkExecutor({ root, directory });
  if (process.argv.includes('--plan')) {
    if (!execute) throw new Error('check-plan-requires-PI_STACK_CHECK_CACHE_DIR');
    const concurrency = checkParallelism();
    const childBudget = String(Math.max(1, Math.floor(concurrency / Math.max(1, Math.min(concurrency, checkJobs.length)))));
    console.log(JSON.stringify(checkJobs.map(job => execute.inspect([job[0], job[1], job[2], { ...job[3], env: { ...process.env, ...job[3]?.env, PI_STACK_CHECK_CONCURRENCY: childBudget }, checkEnvironment: job[3]?.env ?? {} }])), null, 2));
  } else {
    try { await runJobs(checkJobs, execute ? { execute } : {}); }
    finally {
      if (execute) {
        const custody = execute.finalize();
        if (custody.state !== 'validated') { console.error(custody.error); process.exitCode = 1; }
      }
    }
  }
}
