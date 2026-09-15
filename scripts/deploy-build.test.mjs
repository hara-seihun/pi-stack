import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "pi-build-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  for (const file of ["scripts/build-workspace.mjs", "deploy/lib", "deploy/release-checkout"]) {
    put(file, "");
    copyFileSync(join(root, file), join(repo, file));
  }
  for (const file of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) put(file, "{}\n");
  put("packages/orchestrator/src/main.ts", "source\n");
  put("apps/remote/web/main.ts", "source\n");
  put(".gitignore", "node_modules/\ndist/\n");
  put("bin/npm", `#!/usr/bin/env node
const fs = require('node:fs');
const name = process.argv.at(-1).replace('--workspace=pi-', '');
fs.appendFileSync('calls', name + '\\n');
fs.writeFileSync(name + '.started', '');
async function run() {
  if (process.env.BUILD_BARRIER) {
    const other = name === 'remote' ? 'orchestrator' : 'remote';
    const deadline = Date.now() + 1000;
    while (!fs.existsSync(other + '.started')) {
      if (Date.now() > deadline) process.exit(91);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  if (process.env.BUILD_FAIL === name) process.exit(42);
  const out = name === 'remote' ? 'apps/remote/web/dist' : 'packages/orchestrator/dist';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(out + '/main.js', 'built');
}
run();
`);
  spawnSync("chmod", ["+x", join(repo, "bin/npm")]);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const env = { ...process.env, PATH: `${repo}/bin:${process.env.PATH}` };
  const run = (name, extra = {}) => spawnSync(process.execPath, [join(repo, "scripts/build-workspace.mjs"), name], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8", timeout: 3000 });
  return { repo, put, env, run, calls: () => readFileSync(join(repo, "calls"), "utf8").trim().split("\n") };
}

test("deployment builds overlap after dependency preparation and both failures are joined", t => {
  const f = fixture(t);
  const run = extra => spawnSync("bash", ["-c", `
    source "$1/deploy/lib"
    pi_stack_prepare_dependencies() { printf ready > "$1/dependencies-ready"; }
    pi_stack_prepare_builds "$1"
  `, "build-test", f.repo], { cwd: f.repo, env: { ...f.env, BUILD_BARRIER: "1", ...extra }, encoding: "utf8", timeout: 3000 });
  let result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.repo, "dependencies-ready")));
  assert.deepEqual(f.calls().sort(), ["orchestrator", "remote"]);
  f.put("package-lock.json", "changed");
  result = run({ BUILD_FAIL: "orchestrator" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(join(f.repo, "node_modules/.pi-stack-build-orchestrator.json")), false);
  assert.ok(existsSync(join(f.repo, "node_modules/.pi-stack-build-remote.json")), "the sibling finished before returning failure");
});

test("build reuse requires unchanged source, dependencies and complete output", t => {
  const f = fixture(t);
  const build = () => {
    const result = f.run("remote");
    assert.equal(result.status, 0, result.stderr);
  };
  build(); build();
  assert.equal(f.calls().length, 1);
  f.put("unrelated", "a new release need not rebuild the frontend");
  build();
  assert.equal(f.calls().length, 1);
  f.put("apps/remote/web/main.ts", "changed source"); build();
  f.put("apps/remote/web/new.ts", "new source"); build();
  f.put("node_modules/.package-lock.json", "changed dependencies"); build();
  f.put("apps/remote/web/dist/main.js", "corrupted output"); build();
  rmSync(join(f.repo, "apps/remote/web/dist/main.js")); build();
  assert.equal(f.calls().length, 6);
  f.put("package-lock.json", "changed lock");
  assert.equal(f.run("remote", { BUILD_FAIL: "remote" }).status, 42);
  assert.equal(existsSync(join(f.repo, "node_modules/.pi-stack-build-remote.json")), false);
  build();
  assert.equal(f.calls().length, 8);
});
