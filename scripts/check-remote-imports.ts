import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";

// Resolve first-party imports from the artifact, not from the checkout. Leave
// npm packages unbundled after resolving them: libraries such as Playwright
// have optional Electron/BiDi imports that are not used by the running server.
const release = resolve(process.argv[2]);
for (const resource of [
  "deploy/lib",
  "deploy/release-checkout",
  "deploy/meeting-census",
  "deploy/smoke",
  "deploy/one-kenan-activate",
  "skills/livedev/SKILL.md",
  "server/voice/delegation-policy.md",
  "server/meet/transcriber.ts",
  "server/write.ts",
  "server/file-edit.py",
  "web/dist/index.html",
  "web/dist/meet.html",
  "web/dist/meet-adapter.js",
  "web/dist/voice.html",
  "web/dist/kenan.png",
  "kenan-root/package.json",
  "kenan-root/instructions.md",
  "kenan-root/src/main.ts",
]) {
  if (!statSync(join(release, resource)).isFile()) throw new Error(`Missing Pi Remote release resource: ${resource}`);
}
const editorRuntime = Bun.spawnSync(["python3", "-c", "import fcntl, os; assert hasattr(os, 'pread') and hasattr(os, 'pwrite')"], { timeout: 5_000 });
if (editorRuntime.exitCode !== 0) throw new Error(`Files editor Python runtime unavailable: ${editorRuntime.stderr.toString()}`);
const result = await Bun.build({
  entrypoints: [
    ...["main.ts", "router.ts", "person-cli.ts", "voice/service.ts", "rooms-main.ts"].map(name => join(release, "server", name)),
    join(release, "kenan-root/src/main.ts"),
  ],
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
