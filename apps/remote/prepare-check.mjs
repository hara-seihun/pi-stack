import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
for (const project of [
  "../../packages/kenan-memory/tsconfig.json",
  "../../packages/kenan-root/tsconfig.json",
  "../../packages/orchestrator/tsconfig.build.json",
]) {
  execFileSync(process.execPath, [compiler, "-p", fileURLToPath(new URL(project, import.meta.url))], { stdio: "inherit" });
}
