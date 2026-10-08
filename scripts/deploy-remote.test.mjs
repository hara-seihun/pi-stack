import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { remoteEntrypoints, remoteExecutables, remoteRequiredFiles, remoteResources } from "../deploy/remote-resources.mjs";
import { copyRemoteSources } from "./deployment-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseResources = [...remoteRequiredFiles, "shared/state.ts", "shared/value.ts"];
function fixture(resources) {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-deploy-test-"));
  const repo = join(dir, "repo"), dest = join(dir, "remote"), orchestrator = join(dir, "orchestrator");
  const dependencies = join(dir, "dependencies", "node_modules"), bin = join(dir, "bin");
  const put = (path, text, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
  };
  copyRemoteSources(root, repo, resources);
  const manifestPath = join(repo, "deploy/remote-resources.mjs");
  const manifest = readFileSync(manifestPath, "utf8");
  put(manifestPath, manifest.replace(/export const remoteResources = \[[\s\S]*?\n\];/, `export const remoteResources = ${JSON.stringify(resources)};`));
  for (const file of ["scripts/check-remote-imports.ts", "scripts/build-workspace.mjs"]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    cpSync(join(root, file), join(repo, file));
  }
  put(join(bin, "npm"), '#!/bin/sh\nif [ "$3" = --workspace=kenan-root ]; then mkdir -p packages/kenan-root/dist; printf "export {};\\n" > packages/kenan-root/dist/main.js; else mkdir -p apps/remote/web/dist apps/remote/server/phone/dist; cp "$BUILD_ASSETS"/* apps/remote/web/dist/; cp "$BUILD_PHONE_SDK" apps/remote/server/phone/dist/retell-sdk.js; fi\n', 0o755);
  put(join(repo, "apps/remote/package.json"), JSON.stringify({type: "module", dependencies: {"pi-orchestrator": "1.0.0", "playwright-core": "1.0.0"}}));
  cpSync(join(repo, "apps/remote/web/dist"), join(dir, "build-assets"), { recursive: true });
  cpSync(join(repo, "apps/remote/server/phone/dist/retell-sdk.js"), join(dir, "build-phone-sdk.js"));
  for (const entrypoint of remoteEntrypoints) {
    const source = entrypoint.startsWith("server/") ? join(repo, "apps/remote", entrypoint) : join(repo, "packages", entrypoint);
    put(source, "export {};");
  }
  put(join(repo, "apps/remote/shared/state.ts"), 'export { value } from "./value.js";');
  put(join(repo, "apps/remote/shared/value.ts"), 'export const value = true;');
  put(join(repo, "apps/remote/server/main.ts"), 'import { chromium } from "playwright-core"; import { ok } from "pi-orchestrator/api"; import { value } from "../shared/state.js"; console.log(chromium, ok, value);');
  put(join(repo, "packages/kenan-root/package.json"), JSON.stringify({ name: "kenan-root", type: "module" }));
  put(join(repo, "packages/kenan-root/instructions.md"), "Fixed host root instructions\n");
  put(join(repo, "packages/kenan-root/src/main.ts"), 'import { ok } from "pi-orchestrator/api"; console.log(ok);');
  put(join(repo, "packages/kenan-root/dist/main.js"), "export {};");

  put(join(orchestrator, "package.json"), JSON.stringify({name: "pi-orchestrator", exports: {"./api": "./src/api.ts"}}));
  put(join(orchestrator, "src/api.ts"), "export const ok = true;");
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
    ...process.env, PATH: `${bin}:${process.env.PATH}`, BUILD_ASSETS: join(dir, "build-assets"), BUILD_PHONE_SDK: join(dir, "build-phone-sdk.js"), PI_STACK_DEPLOY_NO_SUDO: "1",
    PI_STACK_HOST_LOCK_PATH: join(dir, "host.lock"),
    PI_STACK_ALLOW_DIRTY: "1", PI_STACK_REMOTE_DEST: dest, PI_STACK_ORCHESTRATOR_DEST: orchestrator,
  }});
  return {dir, repo, dest, orchestrator, dependencies, put, run};
}

test("Remote publishes production dependencies and checks the unchanged release", () => {
  const f = fixture(remoteResources);
  try {
    let result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(join(f.dest, "node_modules/playwright-core")), join(f.dependencies, "playwright-core"));
    assert.equal(realpathSync(join(f.dest, "node_modules/pi-orchestrator")), f.orchestrator);
    for (const resource of releaseResources) assert.ok(existsSync(join(f.dest, resource)), resource);
    for (const executable of remoteExecutables) {
      const path = join(f.dest, executable);
      chmodSync(path, 0o644);
      const rejected = f.run();
      assert.notEqual(rejected.status, 0, `${executable} must remain executable on unchanged redeploy`);
      assert.match(rejected.stderr, /EACCES/);
      chmodSync(path, 0o755);
    }
    result = f.run();
    assert.equal(result.status, 0, result.stderr);
    rmSync(join(f.dest, "node_modules/playwright-core"));
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /playwright-core/);
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

test("Remote rejects an incomplete release even on unchanged redeploy", () => {
  const f = fixture(remoteResources);
  try {
    const deployed = f.run();
    assert.equal(deployed.status, 0, deployed.stderr);
    for (const resource of releaseResources) {
      const path = join(f.dest, resource), saved = join(f.dir, "resource");
      cpSync(path, saved);
      rmSync(path);
      const result = f.run();
      assert.notEqual(result.status, 0, resource);
      const missing = resource.startsWith("shared/") ? `${basename(resource, ".ts")}.js` : resource;
      assert.ok(result.stderr.includes(missing), result.stderr);
      cpSync(saved, path);
    }
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

test("one new owner declaration extends fixture construction, staging and unchanged-release rejection", () => {
  const resource = {
    source: "apps/remote/server/pi-editor-launch", destination: "server/additional-launcher", kind: "file",
  };
  const f = fixture([...remoteResources, resource]);
  try {
    const deployed = f.run();
    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(readFileSync(join(f.dest, resource.destination)), readFileSync(join(root, resource.source)));
    rmSync(join(f.dest, resource.destination));
    const incomplete = f.run();
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /Missing Pi Remote release resource: server\/additional-launcher/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Remote prefers workspace-local dependencies", () => {
  const f = fixture(remoteResources);
  try {
    const nested = join(f.dependencies, "../apps/remote/node_modules/playwright-core");
    cpSync(join(f.dependencies, "playwright-core"), nested, {recursive: true});
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(join(f.dest, "node_modules/playwright-core")), realpathSync(nested));
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

test("Remote rejects missing source and generated resources before publication", () => {
  for (const source of ["repo/apps/remote/server/pi-editor-launch", "build-assets/meet-adapter.js"]) {
    const f = fixture(remoteResources);
    try {
      rmSync(join(f.dir, source));
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Missing Pi Remote release resource:/);
      assert.equal(existsSync(f.dest), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test("Remote rejects missing declared or transitive first-party imports before publication", () => {
  for (const entrypoint of [null, "main.ts", "voice/service.ts"]) {
    const f = fixture(remoteResources);
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
