import { fileURLToPath, pathToFileURL } from "node:url";
import { runJobs } from "../../scripts/run-jobs.mjs";

const shardCount = 6;
export const workspaceChecks = Array.from({ length: shardCount }, (_, index) => [
  `agent workspace ${index + 1}/${shardCount}`,
  process.execPath,
  ["--test", fileURLToPath(new URL("./test.mjs", import.meta.url))],
  { env: { AGENT_WORKSPACE_TEST_SHARD: `${index}/${shardCount}` } },
]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJobs(workspaceChecks);
}
