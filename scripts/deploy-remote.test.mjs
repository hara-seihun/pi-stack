import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const releaseResources = [
  "deploy/lib", "deploy/release-checkout", "deploy/smoke", "skills/livedev/SKILL.md", "server/voice/delegation-policy.md",
  "server/meet/asr/worker.py", "server/meet/asr/model.json", "server/meet/asr/requirements.lock",
  "web/dist/index.html", "web/dist/meet.html", "web/dist/meet-adapter.js", "web/dist/voice.html", "web/dist/kenan.png",
];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-deploy-test-"));
  const repo = join(dir, "repo"), dest = join(dir, "remote"), orchestrator = join(dir, "orchestrator");
  const dependencies = join(dir, "dependencies", "node_modules"), bin = join(dir, "bin");
  const put = (path, text, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
  };
  for (const file of ["deploy/remote", "deploy/lib", "deploy/release-checkout", "deploy/smoke", "scripts/check-remote-imports.ts", "scripts/build-workspace.mjs"]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    cpSync(join(root, file), join(repo, file));
  }
  put(join(bin, "npm"), '#!/bin/sh\nmkdir -p apps/remote/web/dist\ncp "$BUILD_ASSETS"/* apps/remote/web/dist/\n', 0o755);
  put(join(repo, "apps/remote/package.json"), JSON.stringify({type: "module", dependencies: {"pi-orchestrator": "1.0.0", "playwright-core": "1.0.0"}}));
  for (const resource of releaseResources.filter((path) => !path.startsWith("deploy/"))) {
    put(join(repo, "apps/remote", resource), "fixture\n");
  }
  cpSync(join(repo, "apps/remote/web/dist"), join(dir, "build-assets"), { recursive: true });
  put(join(repo, "apps/remote/server/main.ts"), 'import { chromium } from "playwright-core"; import { ok } from "pi-orchestrator/api"; console.log(chromium, ok);');
  for (const entry of ["router.ts", "person-cli.ts", "voice/service.ts"]) put(join(repo, "apps/remote/server", entry), "export {};");
  for (const entry of ["pi-remote", "pi-remote-launch", "pi-remote-supervise"]) put(join(repo, "apps/remote/server", entry), "#!/bin/sh\nexit 0\n", 0o755);
  put(join(orchestrator, "package.json"), JSON.stringify({name: "pi-orchestrator", exports: {"./api": "./src/api.ts"}}));
  put(join(orchestrator, "src/api.ts"), "export const ok = true;");
  put(join(orchestrator, "src/boost.ts"), "export {};");
  put(join(dependencies, "playwright-core/package.json"), JSON.stringify({name: "playwright-core", main: "index.js"}));
  // An optional dependency must not be eagerly bundled or executed by the check.
  put(join(dependencies, "playwright-core/index.js"), 'exports.chromium = true; if (false) require("optional-electron");');
  symlinkSync(dependencies, join(orchestrator, "node_modules"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  put(join(orchestrator, ".pi-stack-commit"), commit + "\n");
  const run = () => spawnSync("bash", [join(repo, "deploy/remote")], {encoding: "utf8", env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, BUILD_ASSETS: join(dir, "build-assets"), PI_STACK_DEPLOY_NO_SUDO: "1",
    PI_STACK_HOST_LOCK_PATH: join(dir, "host.lock"),
    PI_STACK_ALLOW_DIRTY: "1", PI_STACK_REMOTE_DEST: dest, PI_STACK_ORCHESTRATOR_DEST: orchestrator,
  }});
  return {dir, repo, dest, orchestrator, dependencies, put, run};
}

test("Remote publishes production dependencies and checks the unchanged release", () => {
  const f = fixture();
  try {
    let result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(join(f.dest, "node_modules/playwright-core")), join(f.dependencies, "playwright-core"));
    assert.equal(realpathSync(join(f.dest, "node_modules/pi-orchestrator")), f.orchestrator);
    for (const resource of releaseResources) assert.ok(existsSync(join(f.dest, resource)), resource);
    result = f.run();
    assert.equal(result.status, 0, result.stderr);
    rmSync(join(f.dest, "node_modules/playwright-core"));
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /playwright-core/);
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

test("Remote rejects an incomplete release even on unchanged redeploy", () => {
  const f = fixture();
  try {
    const deployed = f.run();
    assert.equal(deployed.status, 0, deployed.stderr);
    for (const resource of releaseResources) {
      const path = join(f.dest, resource), saved = join(f.dir, "resource");
      cpSync(path, saved);
      rmSync(path);
      const result = f.run();
      assert.notEqual(result.status, 0, resource);
      assert.ok(result.stderr.includes(resource), result.stderr);
      cpSync(saved, path);
    }
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

test("Remote prefers workspace-local dependencies", () => {
  const f = fixture();
  try {
    const nested = join(f.dependencies, "../apps/remote/node_modules/playwright-core");
    cpSync(join(f.dependencies, "playwright-core"), nested, {recursive: true});
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(join(f.dest, "node_modules/playwright-core")), realpathSync(nested));
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

test("Remote rejects missing declared or transitive first-party imports before publication", () => {
  for (const entrypoint of [null, "main.ts", "voice/service.ts"]) {
    const f = fixture();
    try {
      if (entrypoint === null) rmSync(join(f.dependencies, "playwright-core"), {recursive: true});
      else {
        f.put(join(f.repo, "apps/remote/server", entrypoint), `import "${entrypoint === "main.ts" ? "./" : "../"}meet/browser";`);
        f.put(join(f.repo, "apps/remote/server/meet/browser.ts"), 'import "missing-meet-dependency";');
      }
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, entrypoint === null ? /playwright-core/ : /missing-meet-dependency/);
      assert.equal(existsSync(f.dest), false);
    } finally { rmSync(f.dir, {recursive: true, force: true}); }
  }
});
