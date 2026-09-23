import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runJobs } from "../../scripts/run-jobs.mjs";

execFileSync(process.execPath, [
  fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)),
  "-p", fileURLToPath(new URL("../../packages/orchestrator/tsconfig.build.json", import.meta.url)),
], { stdio: "inherit" });

execFileSync(process.execPath, [
  fileURLToPath(new URL("../../packages/runtime/patch-shared-rpc.mjs", import.meta.url)),
  fileURLToPath(new URL("../../node_modules", import.meta.url)),
], { stdio: "inherit" });

const testFiles = ["server", "web"].flatMap((directory) =>
  readdirSync(new URL(directory, import.meta.url), { recursive: true })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => join(directory, file)))
  .sort();

await runJobs([
  ["types", join("..", "..", "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"]],
  ["tests", "bun", ["test", ...testFiles]],
]);
