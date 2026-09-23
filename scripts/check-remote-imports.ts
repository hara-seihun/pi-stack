import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";

// Resolve first-party imports from the artifact, not from the checkout. Leave
// npm packages unbundled after resolving them: libraries such as Playwright
// have optional Electron/BiDi imports that are not used by the running server.
const release = resolve(process.argv[2]);
for (const resource of [
  "deploy/lib",
  "deploy/release-checkout",
  "deploy/smoke",
  "skills/livedev/SKILL.md",
  "server/voice/delegation-policy.md",
  "server/meet/asr/worker.py",
  "server/meet/asr/model.json",
  "server/meet/asr/requirements.lock",
  "web/dist/index.html",
  "web/dist/meet.html",
  "web/dist/meet-adapter.js",
  "web/dist/voice.html",
  "web/dist/kenan.png",
]) {
  if (!statSync(join(release, resource)).isFile()) throw new Error(`Missing Pi Remote release resource: ${resource}`);
}
const result = await Bun.build({
  entrypoints: ["main.ts", "router.ts", "person-cli.ts", "voice/service.ts"].map(name => join(release, "server", name)),
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
