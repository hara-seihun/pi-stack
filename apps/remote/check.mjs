import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { runJobs } from "../../scripts/run-jobs.mjs";

const integration = join("server", "server.integration.test.ts");
const unitFiles = ["server", "web"].flatMap((directory) =>
  readdirSync(new URL(directory, import.meta.url), { recursive: true })
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => join(directory, file)))
  .filter((file) => file !== integration)
  .sort();
const shardCount = Math.min(4, availableParallelism());

await runJobs([
  ["types", join("..", "..", "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"]],
  ["unit", "bun", ["test", ...unitFiles]],
  ...Array.from({ length: shardCount }, (_, index) => [
    `integration ${index + 1}/${shardCount}`,
    "bun",
    ["test", integration],
    { env: { ...process.env, PI_REMOTE_TEST_SHARD: `${index}/${shardCount}` } },
  ]),
]);
