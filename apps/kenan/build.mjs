import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const destination = join(root, "dist");
const vite = join(root, "../remote/node_modules/.bin/vite");

await rm(destination, { recursive: true, force: true });
const build = spawnSync(vite, ["build", "--config", join(root, "../remote/vite.config.ts"), "--outDir", destination], {
  cwd: join(root, "../remote"),
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
await mkdir(destination, { recursive: true });
await writeFile(join(destination, ".shared-web-source"), "apps/remote/web/src\n");
console.log("Built Kenan from the React client");
