import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { runJobs } from "../../scripts/run-jobs.mjs";

const shardCount = Math.min(6, availableParallelism());
await runJobs(Array.from({ length: shardCount }, (_, index) => [
  `agent workspace ${index + 1}/${shardCount}`,
  process.execPath,
  ["--test", fileURLToPath(new URL("./test.mjs", import.meta.url))],
  { env: { ...process.env, AGENT_WORKSPACE_TEST_SHARD: `${index}/${shardCount}` } },
]));
