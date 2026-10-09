import { pathToFileURL } from "node:url";
import { runJobs } from "./run-jobs.mjs";
import { orchestratorTestChecks } from "../packages/orchestrator/scripts/check.mjs";
import { checkExecutor } from './check-cache.mjs';
import { fileURLToPath } from 'node:url';

const jobs = [
  ["job lifecycle", "node", ["--test", "scripts/run-jobs.test.mjs", "scripts/check-cache.test.mjs", "scripts/orchestrator-check.test.mjs", "scripts/check-state-dispatch.test.mjs"]],
  ["explicit state dispatch", "node", ["scripts/check-state-dispatch.mjs"]],
  ...orchestratorTestChecks([
    { name: "orchestrator routing runtime", args: ["tests/routing-runtime.test.ts"] },
    ...Array.from({ length: 6 }, (_, index) => ({
      name: `orchestrator ${index + 1}/6`,
      args: ["--exclude=tests/routing-runtime.test.ts", `--shard=${index + 1}/6`],
    })),
  ]),
  ["Remote build", "node", ["scripts/build-workspace.mjs", "remote"]],
  ["Kenan build", "npm", ["run", "build", "--workspace=kenan"], { dependsOn: ["Remote build"] }],
  ["manifests", "node", ["scripts/check-manifests.mjs"]],
  ["account deployment", "node", ["--test", "scripts/deploy-skills.test.mjs", "scripts/deploy-account.test.mjs", "scripts/deploy-person-configs.test.mjs"]],
  ["deploy lock", "node", ["--test", "--test-skip-pattern=^host deployment activates Pi Remote", "scripts/deploy-lock.test.mjs", "scripts/deploy-runtime.test.mjs", "scripts/deploy-build.test.mjs", "scripts/deploy-prepare.test.mjs", "scripts/deploy-download.test.mjs", "scripts/deploy-retain.test.mjs", "scripts/release-checkout.test.mjs", "scripts/check-services.test.mjs"]],
  ...["disabled", "enabled"].map(guest => [
    `deploy host guest ${guest}`, "node", ["--test",
      `--test-name-pattern=^host deployment activates Pi Remote and reconciles daemons with guest ${guest}$`,
      "scripts/deploy-lock.test.mjs"],
  ]),
  ["publication", "node", ["--test", "scripts/publication-config.test.mjs", "scripts/publication-transport.test.mjs", "scripts/publication-roots.test.mjs", "scripts/publication.test.mjs", "scripts/publication-gate.test.mjs", "scripts/publication-bundle.test.mjs", "scripts/publication-source.test.mjs", "scripts/publication-progress.test.mjs", "scripts/publication-proof.test.mjs"]],
  ["Android publication", "node", ["--test", "scripts/android-update.test.mjs", "scripts/android-prepared-native.test.mjs"]],
  ["remote deployment", "node", ["--test", "scripts/deploy-remote.test.mjs", "scripts/deploy-voice.test.mjs", "scripts/deploy-phone.test.mjs", "scripts/meet-recognition-service.test.mjs", "scripts/meet-recognition-host.test.mjs", "scripts/meet-recognition-retain.test.mjs", "scripts/supervisor-health.test.mjs"]],
  ["tools", "node", ["scripts/check-tools.mjs"]],
  ["user usage", "node", ["--test", "tools/user-usage/usage.test.mjs"]],
  ["Claude reset collector", "node", ["--test", "tools/claude-reset/collect.test.mjs"]],
  ["runtime", "npm", ["test", "--workspace=@hara-seihun/pi-runtime"]],
  ["One Kenan deployment", "python3", ["-B", "scripts/one-kenan-deploy.test.py"]],
  ["Meet recognition protocol", "python3", ["-B", "-m", "unittest", "discover", "-s", "apps/meet-recognition", "-p", "test_protocol.py"]],
  ["action journal publication", "bun", ["test", "deploy/action-journal.test.ts"]],
  ["mail send boundary", "python3", ["-B", "tools/mail-send/test_send.py"]],
  ["Kenan memory", "npm", ["test", "--workspace=kenan-memory"]],
  ["life import", "bun", ["test", "scripts/life-import.test.ts"]],
  ["Root Kenan", "npm", ["test", "--workspace=kenan-root"]],
  ["remote", "npm", ["test", "--workspace=pi-remote"], { dependsOn: ["Remote build"] }],
  ["mcp", "npm", ["test", "--workspace=@hara-seihun/mcp-cli"]],
  ["mcp-script", "npm", ["test", "--workspace=@hara-seihun/mcp-script"]],
  ["session readers", "npm", ["test", "--workspace=@hara-seihun/read-condensed-session"]],
];

export const checkJobs = jobs.map(([name, command, args, ...options]) => [
  name, command, args[0] === "--test" ? ["scripts/test-node.mjs", ...args.slice(1)] : args, ...options,
]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.PI_STACK_CHECK_CACHE_DIR;
  if (directory !== undefined && !directory.startsWith('/')) throw new Error('PI_STACK_CHECK_CACHE_DIR must be absolute');
  await runJobs(checkJobs, directory === undefined ? {} : {
    execute: checkExecutor({ root: fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''), directory }),
  });
}
