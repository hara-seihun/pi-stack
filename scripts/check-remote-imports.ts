import { dirname, join, resolve } from "node:path";

// Resolve first-party imports from the artifact, not from the checkout. Leave
// npm packages unbundled after resolving them: libraries such as Playwright
// have optional Electron/BiDi imports that are not used by the running server.
const release = resolve(process.argv[2]);
const result = await Bun.build({
  entrypoints: ["main.ts", "router.ts", "person-cli.ts"].map(name => join(release, "server", name)),
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
