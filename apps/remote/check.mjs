import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { runJobs } from "../../scripts/run-jobs.mjs";

execFileSync(process.execPath, [
  fileURLToPath(new URL("../../packages/runtime/patch-shared-rpc.mjs", import.meta.url)),
  fileURLToPath(new URL("../../node_modules", import.meta.url)),
], { stdio: "inherit" });

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
