import { availableParallelism } from "node:os";
import { runJobs } from "../../scripts/run-jobs.mjs";

const shardCount = Math.min(6, availableParallelism());
await runJobs(Array.from({ length: shardCount }, (_, index) => [
  `agent workspace ${index + 1}/${shardCount}`,
  process.execPath,
  ["--test", "test.mjs"],
  { env: { ...process.env, AGENT_WORKSPACE_TEST_SHARD: `${index}/${shardCount}` } },
]));
