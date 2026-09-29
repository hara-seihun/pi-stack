import { spawnSync } from "node:child_process";
import { checkParallelism } from "./run-jobs.mjs";

// This is a new runner, even when a test invokes it as a subprocess fixture.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${checkParallelism()}`, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  timeout: 120_000,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
