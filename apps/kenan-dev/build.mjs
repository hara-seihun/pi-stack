import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "../remote/web");
const destination = join(root, "dist");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: (path) => !path.endsWith(".test.ts"),
});
await writeFile(join(destination, ".shared-web-source"), "apps/remote/web\n");
console.log("Built kenan-dev from apps/remote/web");
