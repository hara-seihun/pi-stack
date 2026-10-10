import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const destination = join(root, "dist");
const build = spawnSync(process.execPath, [join(root, '../../scripts/build-workspace.mjs'), 'remote'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
await rm(destination, { recursive: true, force: true });
// Precompressed .br/.gz twins serve the router only; Android's asset merger treats x.gz as x and rejects the duplicate.
await cp(join(root, '../remote/web/dist'), destination, { recursive: true, filter: source => !/\.(?:br|gz)$/.test(source) });
await mkdir(destination, { recursive: true });
await writeFile(join(destination, ".shared-web-source"), "apps/remote/web/src\n");
console.log("Built Kenan from the React client");
