import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const snapshot = directory => readdirSync(directory).sort().flatMap(name => {
  const path = join(directory, name), stat = lstatSync(path);
  return [[path, stat.mtimeMs, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? readFileSync(path, "utf8") : null],
    ...(stat.isDirectory() ? snapshot(path) : [])];
});

test("service-environment onboarding reconciles one account without global Git trust or changing shared releases", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-stack-account-"));
  const home = join(scratch, "home"), shared = join(scratch, "shared");
  const roots = Object.fromEntries(["runtime", "orchestrator", "remote", "tools", "skills"].map(name => [name, join(shared, name)]));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
  function file(path, contents = "") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); }
  const deployed = path => path.replace("/srv/pi/pi-orchestrator", roots.orchestrator).replace("/srv/pi/pi-remote", roots.remote).replace("/srv/pi/runtime", roots.runtime);
  const env = { ...process.env, HOME: home, PI_STACK_ALLOW_DIRTY: "1", PI_STACK_DEPLOY_NO_SUDO: "1", PI_STACK_HOME_OVERRIDE: home,
    PI_STACK_HOST_FILE: join(scratch, "host.json"), PI_STACK_HOST_LOCK_FILE: join(scratch, "deploy.lock"),
    ...Object.fromEntries(Object.entries(roots).map(([name, path]) => [`PI_STACK_${name.toUpperCase()}_DEST`, path])),
  };
  delete env.HOME;
  delete env.SUDO_UID;
  env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  const run = script => spawnSync(join(root, "deploy", script), [user], { cwd: root, env, encoding: "utf8", timeout: 5_000 });
  try {
    mkdirSync(home);
    const sharedModels = join(scratch, "models.json");
    const sharedProvider = { baseUrl: "http://127.0.0.1:8471/v1", api: "openai-completions", apiKey: "local", models: [{ id: "bonsai", name: "Bonsai", icon: "🌳" }] };
    file(sharedModels, JSON.stringify({ providers: { local: sharedProvider } }));
    file(env.PI_STACK_HOST_FILE, JSON.stringify({ version: 1, packages: [], skills: [], models: sharedModels }));
    for (const path of Object.values(roots)) file(join(path, ".pi-stack-commit"), commit);
    for (const name of ["pi", "agent-browser", "pi-agent-browser-doctor"]) {
      const path = join(roots.runtime, "node_modules/.bin", name);
      file(path, "#!/bin/sh\necho 'onboarding must not invoke package installers or browsers' >&2\nexit 99\n");
      chmodSync(path, 0o755);
    }
    const manifest = json(join(root, "config/packages.json"));
    const expectedPackages = manifest.packages.map(entry => {
      if (!entry.source.startsWith("npm:")) { mkdirSync(deployed(entry.deployed), { recursive: true }); return deployed(entry.deployed); }
      const split = entry.source.lastIndexOf("@"), name = entry.source.slice(4, split), version = entry.source.slice(split + 1);
      const path = join(roots.runtime, "node_modules", name);
      file(join(path, "package.json"), JSON.stringify({ name, version }));
      return path;
    });
    const lockfile = join(roots.runtime, "node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile");
    mkdirSync(dirname(lockfile), { recursive: true });
    symlinkSync(join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile"), lockfile);
    file(join(roots.orchestrator, "dist/models.json"), JSON.stringify({ providers: {} }));
    for (const skill of json(join(root, "config/skills.json")).skills) file(join(roots.skills, skill, "SKILL.md"), `# ${skill}\n`);
    const settings = join(home, ".pi/agent/settings.json");
    file(settings, JSON.stringify({ theme: "personal", packages: ["replaced"] }));
    const models = join(home, ".pi/agent/models.json");
    const personalProvider = { models: [{ id: "personal", icon: "🧪" }] };
    file(models, JSON.stringify({ providers: { personal: personalProvider, local: { baseUrl: "wrong", models: [{ id: "bonsai", name: "Wrong" }, { id: "extra", icon: "🔬" }] } } }));
    file(join(home, ".pi/agent/skills/personal/SKILL.md"), "# personal\n");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    symlinkSync(join(roots.tools, "removed/command"), join(home, ".local/bin/removed"));
    const before = snapshot(shared);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run("account");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(snapshot(shared), before);
    }
    assert.deepEqual(json(settings).packages, expectedPackages);
    assert.equal(json(settings).theme, "personal");
    assert.deepEqual(json(models).providers, { personal: personalProvider, local: { ...sharedProvider, models: [{ id: "extra", icon: "🔬" }, ...sharedProvider.models] } });
    assert.equal(readlinkSync(join(home, ".local/bin/pi")), join(roots.runtime, "node_modules/.bin/pi"));
    for (const tool of json(join(root, "config/tools.json")).tools) for (const command of tool.commands) {
      assert.equal(readlinkSync(join(home, ".local/bin", command.name)), join(roots.tools, tool.id, command.entry));
    }
    assert.equal(readdirSync(join(home, ".local/bin")).includes("removed"), false);
    assert.equal(readFileSync(join(home, ".pi/agent/skills/personal/SKILL.md"), "utf8"), "# personal\n");
    const accountBefore = snapshot(home);
    file(join(roots.remote, ".pi-stack-commit"), "different-release");
    const mismatch = run("account");
    assert.equal(mismatch.status, 66, mismatch.stderr);
    assert.deepEqual(snapshot(home), accountBefore);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("settings resolves exact npm pins and rejects mismatches without changing the account", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-stack-settings-"));
  const source = join(scratch, "source"), home = join(scratch, "home"), runtime = join(scratch, "runtime");
  const orchestrator = join(scratch, "orchestrator"), remote = join(scratch, "remote");
  const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
  const name = "@pi-stack-test/extension", version = "1.2.3";
  const external = join(runtime, "node_modules", name);
  function file(path, contents) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); }
  try {
    mkdirSync(join(source, "deploy"), { recursive: true });
    for (const script of ["settings", "lib", "release-checkout"]) copyFileSync(join(root, "deploy", script), join(source, "deploy", script));
    file(join(source, "config/packages.json"), JSON.stringify({ version: 2, contextObserver: "remote", packages: [
      { id: "external", source: `npm:${name}@${version}` },
      { id: "remote", source: "apps/remote", deployed: "/srv/pi/pi-remote" },
    ] }));
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--no-gpg-sign", "-qm", "Fixture"], { cwd: source });
    file(join(scratch, "host.json"), JSON.stringify({ version: 1, packages: [] }));
    file(join(external, "package.json"), JSON.stringify({ name, version }));
    const lockfile = join(runtime, "node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile");
    mkdirSync(dirname(lockfile), { recursive: true });
    symlinkSync(join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile"), lockfile);
    mkdirSync(remote);
    file(join(orchestrator, "dist/models.json"), JSON.stringify({ providers: {} }));
    const settings = join(home, ".pi/agent/settings.json");
    file(settings, JSON.stringify({ theme: "personal", packages: ["replaced"] }));
    const env = { ...process.env, HOME: home, PI_STACK_ALLOW_DIRTY: "1", PI_STACK_DEPLOY_NO_SUDO: "1", PI_STACK_HOME_OVERRIDE: home,
      PI_STACK_HOST_FILE: join(scratch, "host.json"), PI_STACK_HOST_LOCK_PATH: join(scratch, "deploy.lock"),
      PI_STACK_RUNTIME_DEST: runtime, PI_STACK_ORCHESTRATOR_DEST: orchestrator, PI_STACK_REMOTE_DEST: remote };
    const run = () => spawnSync(join(source, "deploy/settings"), [user], { cwd: source, env, encoding: "utf8", timeout: 5_000 });
    const installed = run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(json(settings).packages, [external, remote]);
    assert.equal(json(settings).theme, "personal");
    const before = snapshot(home);
    for (const mismatch of [{ name, version: "0.0.0" }, { name: "wrong-package", version }]) {
      file(join(external, "package.json"), JSON.stringify(mismatch));
      const rejected = run();
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /shared runtime package does not match/);
      assert.deepEqual(snapshot(home), before);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("deployment grants process-local Git trust only to the executed checkout", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-stack-git-trust-"));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const env = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1", PI_STACK_ALLOW_DIRTY: "1", PI_STACK_DEPLOY_NO_SUDO: "1", PI_STACK_HOST_LOCK_FILE: join(scratch, "lock") };
    delete env.HOME;
    delete env.SUDO_UID;
    const result = spawnSync("bash", ["-c", 'set -e; source "$1/deploy/lib"; pi_stack_enter_deployment "$1/deploy/account" "$1"; git -C "$1" rev-parse HEAD; git -C "$2" status --porcelain', "fixture", root, scratch], { env, encoding: "utf8", timeout: 3_000 });
    assert.equal(result.status, 128);
    assert.match(result.stdout, /^[a-f0-9]{40}\n$/);
    assert.match(result.stderr, /dubious ownership/);
    assert.ok(result.stderr.includes(scratch));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
