import { dirname, join, resolve } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { remoteEntrypoints, remoteExecutables, remoteRequiredFiles } from "../deploy/remote-resources.mjs";

// Resolve first-party imports from the artifact, not from the checkout. Leave
// npm packages unbundled after resolving them: libraries such as Playwright
// have optional Electron/BiDi imports that are not used by the running server.
const release = resolve(process.argv[2]);
for (const resource of remoteRequiredFiles) {
  if (!statSync(join(release, resource), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing Pi Remote release resource: ${resource}`);
}
for (const executable of remoteExecutables) {
  accessSync(join(release, executable), constants.X_OK);
}
const editorRuntime = Bun.spawnSync(["python3", "-c", "import fcntl, os; assert hasattr(os, 'pread') and hasattr(os, 'pwrite')"], { timeout: 5_000 });
if (editorRuntime.exitCode !== 0) throw new Error(`Files editor Python runtime unavailable: ${editorRuntime.stderr.toString()}`);
const result = await Bun.build({
  entrypoints: remoteEntrypoints.map(path => join(release, path)),
  target: "bun",
  write: false,
  plugins: [{
    name: "resolve-installed-packages",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => ({
        path: Bun.resolveSync(path, dirname(importer)),
        external: true,
      }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
