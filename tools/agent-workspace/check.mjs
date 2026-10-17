import { fileURLToPath, pathToFileURL } from "node:url";
import { runJobs } from "../../scripts/run-jobs.mjs";

const shardCount = 24;
export const workspaceChecks = [...['bounded-command','resume-growth','release-custody'].map(name=>[`agent workspace ${name}`,process.execPath,['--test',fileURLToPath(new URL(`./${name}.test.mjs`,import.meta.url))],{timeoutMs:15_000}]), ["agent workspace protected-source cache retirement", process.execPath, ["--test", fileURLToPath(new URL("./cache-retirement.test.mjs", import.meta.url))]], ["agent workspace terminal retained release", process.execPath, ["--test", fileURLToPath(new URL("./terminal-release.test.mjs", import.meta.url))]], ["agent workspace exact source materialization", process.execPath, ["--test", fileURLToPath(new URL("./source-materialization.test.mjs", import.meta.url))]], ["agent workspace supported source retirement CLI", process.execPath, ["--test", fileURLToPath(new URL("./source-materialization-public.test.mjs", import.meta.url))]], ["agent workspace active growth reduction", process.execPath, ["--test", fileURLToPath(new URL("./growth-reduction.test.mjs", import.meta.url))]], ["agent workspace kind-aware job observation", process.execPath, ["--test", fileURLToPath(new URL("./job-observation.test.mjs", import.meta.url))]], ["agent workspace retained growth lifecycle", process.execPath, ["--test", fileURLToPath(new URL("./growth-lifecycle.test.mjs", import.meta.url))]], ["agent workspace capacity recovery", process.execPath,
  ["--test", fileURLToPath(new URL("./capacity-recovery.test.mjs", import.meta.url))]], ["agent workspace component deployment", process.execPath,
  ["--test", fileURLToPath(new URL("./deploy.test.mjs", import.meta.url))]],
  ["agent workspace durable source preparation", process.execPath,
    ["--test", fileURLToPath(new URL("./source-job.test.mjs", import.meta.url))]],
  ["agent workspace atomic durable checkout", process.execPath,
    ["--test", fileURLToPath(new URL("./checkout-job.test.mjs", import.meta.url))], { timeoutMs: 55_000 }], ...Array.from({ length: shardCount }, (_, index) => [
  `agent workspace ${index + 1}/${shardCount}`,
  process.execPath,
  ["--test", fileURLToPath(new URL("./test.mjs", import.meta.url))],
  { timeoutMs: 55_000, env: { AGENT_WORKSPACE_TEST_SHARD: `${index}/${shardCount}` } },
])];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJobs(workspaceChecks);
}
