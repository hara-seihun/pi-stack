import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { runJobs } from "../../../scripts/run-jobs.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cwd = join(root, "packages/orchestrator");
const memory = ["orchestrator memory build", "npm", ["run", "build", "--workspace=kenan-memory"], { cwd: root }];
const types = ["orchestrator types", process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--incremental", "--tsBuildInfoFile", join(root, "node_modules/.cache/orchestrator.tsbuildinfo")],
  { cwd, dependsOn: [memory[0]] }];

export function orchestratorTypeChecks() {
  return [memory, types];
}

export function orchestratorBuildChecks() {
  return [memory, ["orchestrator build", process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    { cwd, dependsOn: [memory[0]] }]];
}

export function orchestratorTestChecks(suites) {
  const patch = ["orchestrator shared RPC", process.execPath,
    [join(root, "packages/runtime/patch-shared-rpc.mjs"), join(root, "node_modules")],
    { cwd: root, dependsOn: [types[0]] }];
  return [...orchestratorTypeChecks(), patch, ...suites.map(({ name, args }) => [
    name, process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1", ...args],
    { cwd, dependsOn: [patch[0]] },
  ])];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  let jobs;
  switch (mode) {
    case "test": jobs = orchestratorTestChecks([{ name: "orchestrator tests", args }]); break;
    case "typecheck":
    case "build":
      if (args.length) throw new Error(`${mode} does not accept arguments`);
      jobs = mode === "build" ? orchestratorBuildChecks() : orchestratorTypeChecks();
      break;
    default: throw new Error(`unknown Orchestrator check mode: ${mode}`);
  }
  await runJobs(jobs);
}
