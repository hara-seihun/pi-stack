import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";
import { ownerScopes, sourceKeys } from '../deploy/source-scopes.mjs';

const configRoot = mkdtempSync(join(tmpdir(), "publication-proof-config-"));
process.env.PI_STACK_PUBLICATION_CONFIG = publicationConfig(configRoot);
process.on("exit", () => rmSync(configRoot, { recursive: true, force: true }));
const { hostProofScript } = await import("../deploy/publication");
function fixture(t, environment) {
  const root = mkdtempSync(join(tmpdir(), "publication-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'source');
  mkdirSync(join(repository, 'deploy'), { recursive: true });
  mkdirSync(join(repository, 'apps/remote/server'), { recursive: true });
  for (const name of ['host-plan.mjs', 'source-scopes.mjs', 'prepared-components.mjs']) copyFileSync(resolve('deploy', name), join(repository, 'deploy', name));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Host proof fixture');
  git('config', 'user.email', 'proof@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(repository, 'apps/remote/server/fixture.ts'), 'export const version = 1;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'stale owner source');
  const stale = git('rev-parse', 'HEAD');
  writeFileSync(join(repository, 'apps/remote/server/fixture.ts'), 'export const version = 2;\n');
  git('commit', '--quiet', '-am', 'running owner source');
  const equivalent = git('rev-parse', 'HEAD');
  writeFileSync(join(repository, 'README.md'), 'Documentation-only candidate\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'unrelated source advances');
  const revision = git('rev-parse', 'HEAD');
  const keys = sourceKeys(repository, revision, { remote: ownerScopes.remote, voice: ownerScopes.voice });
  const planPath = join(root, '.pi-stack-release-plan.json');
  writeFileSync(planPath, JSON.stringify({ protocol: 'pi-host-plan-v1', state: 'accepted', candidate: revision,
    owners: Object.fromEntries(Object.entries(keys).map(([owner, candidateKey]) => [owner, { candidateKey }])) }));
  const trace = join(root, "trace");
  const hostConfig = join(root, "host.json");
  writeFileSync(hostConfig, JSON.stringify({ fleetUser: "kenan" }));
  for (const component of ["pi-remote", "pi-orchestrator"]) {
    mkdirSync(join(root, component, "deploy"), { recursive: true });
    writeFileSync(join(root, component, ".pi-stack-commit"), revision);
  }
  writeFileSync(join(root, "pi-remote/deploy/lib"), `
pi_stack_as_root() { "$@"; }
pi_stack_supervisor_health() {
  echo "health $1" >> "$TRACE"
  [[ $1 != "$UNREACHABLE" ]] || return 22
  printf '%s\\n' "$HEALTH"
}
`);
  writeFileSync(join(root, "curl"), `#!/usr/bin/env bash
echo "curl $*" >> "$TRACE"
case "\${!#}" in
  */v1/router-health) printf '%s\\n' "$ROUTER"; exit "\${ROUTER_STATUS:-0}";;
  */status) printf '%s\\n' "$VOICE";;
  *) exit 90;;
esac
`, { mode: 0o755 });
  writeFileSync(join(root, "systemctl"), `#!/usr/bin/env bash
echo "systemctl $*" >> "$TRACE"
case "$1" in
  is-active) [[ "$3" != "$INACTIVE" ]];;
  --failed) printf '%s\\n' "$FAILED"; exit "\${SYSTEMCTL_STATUS:-0}";;
  show) echo 'PrivateMounts=yes';;
  *) exit 91;;
esac
`, { mode: 0o755 });
  const router = { ok: true, environmentId: environment, people: [
    { user: "kenan", unlocked: false }, { user: "sybil", unlocked: true },
  ] };
  const health = { ok: true, releaseCommit: revision, environmentId: environment };
  writeFileSync(join(repository, 'deploy/one-kenan-activate'), `import pathlib, sys\nsource = pathlib.Path(__file__).resolve().parent.parent\nassert (source / '.git').exists(), 'owner equivalence requires retained Git source'\nassert sys.argv[1] == 'proof'\nprint('source-bound owner proof')\n`);
  const script = hostProofScript.replaceAll("/srv/pi", root);
  function run(overrides = {}, requiredUnits = []) {
    writeFileSync(trace, "");
    const result = spawnSync("bash", ["-s", "--", revision, environment, environment, hostConfig,
      "http://127.0.0.1:8796/status", resolve("deploy/check-services"), repository, ...requiredUnits], {
      input: script, encoding: "utf8", timeout: 3000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TRACE: trace,
        ROUTER: JSON.stringify(router), HEALTH: JSON.stringify(health), VOICE: JSON.stringify({ releaseCommit: revision }),
        INACTIVE: "pi-remote@kenan.service", FAILED: "", UNREACHABLE: "", ...overrides },
    });
    return { ...result, trace: readFileSync(trace, "utf8") };
  }
  return { run, router, health, root, repository, revision, equivalent, stale, planPath };
}

for (const environment of ["local", "converge"]) {
  test(`${environment}: publication proves unlocked people without opening locked Kenan`, t => {
    const { run, router, revision } = fixture(t, environment);
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.environmentId, environment);
    assert.deepEqual(proof.router, router);
    assert.deepEqual(proof.supervisors.map(person => person.user), ["sybil"]);
    assert.equal(proof.units["pi-remote@sybil.service"], "active");
    assert.equal(proof.units["pi-remote@kenan.service"], undefined);
    assert.equal(proof.remoteCommit, revision);
    assert.equal(proof.orchestratorCommit, revision);
    assert.equal(proof.voiceCommit, revision);
    assert.doesNotMatch(result.trace, /health kenan|pi-remote@kenan|\b(start|restart|unlock)\b/);
    router.people.forEach(person => { person.unlocked = false; });
    result = run({ ROUTER: JSON.stringify(router) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).supervisors, []);
    assert.equal(Object.keys(JSON.parse(result.stdout).units).length, 3);
    assert.doesNotMatch(result.trace, /health |pi-remote@/);
    router.people[0].unlocked = true;
    assert.notEqual(run({ ROUTER: JSON.stringify(router) }).status, 0);
    result = run({ ROUTER: JSON.stringify(router), INACTIVE: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).supervisors.map(person => person.user), ["kenan"]);
  });

  test(`${environment}: host failures are retained and explicit host dependencies still gate publication`, t => {
    const { run } = fixture(t, environment);
    const unit = "pi-claude-reset-read.service";
    const overrides = { FAILED: `${unit} loaded failed failed Collector`, INACTIVE: unit };
    const result = run(overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).otherFailedPiUnits, [unit]);
    assert.match(result.stderr, /host owner/);
    assert.doesNotMatch(result.trace, /reset-failed|\b(start|restart|stop)\b/);
    const required = run(overrides, [unit]);
    assert.equal(required.status, 1);
    assert.ok(required.stderr.includes(`${unit} is not active`));
    assert.equal(required.stdout, "");
  });

  test(`${environment}: One Kenan proof runs from retained Git source, not installed component bytes`, t => {
    const { run, root } = fixture(t, environment);
    writeFileSync(join(root, 'host.json'), JSON.stringify({ fleetUser: 'kenan', oneKenan: true }));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.trace, /health sybil/);
    assert.equal(JSON.parse(result.stdout).environmentId, environment);
  });

  test(`${environment}: publication accepts unchanged running source with explicit equivalence evidence`, t => {
    const { run, health, revision, equivalent } = fixture(t, environment);
    const result = run({ HEALTH: JSON.stringify({ ...health, releaseCommit: equivalent }), VOICE: JSON.stringify({ releaseCommit: equivalent }) });
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.integrationSha, revision);
    assert.equal(proof.remoteCommit, revision);
    assert.equal(proof.orchestratorCommit, revision);
    assert.equal(proof.voiceCommit, equivalent, 'proof retains actual running source rather than pretending it restarted');
    assert.equal(proof.supervisors[0].health.releaseCommit, equivalent);
    assert.deepEqual(proof.runtimeEquivalence.map(item => [item.ok, item.value.owner, item.value.runningCommit, item.value.candidate, item.value.equivalent]),
      [[true, 'voice', equivalent, revision, true], [true, 'remote', equivalent, revision, true]]);
    assert.ok(proof.runtimeEquivalence.every(item => /^[a-f0-9]{64}$/.test(item.value.sourceKey)));
    assert.doesNotMatch(result.trace, /\b(start|restart|unlock)\b/);
  });

  test(`${environment}: changed running source or forged host-plan identity never yields success proof`, t => {
    const { run, health, stale, equivalent, planPath } = fixture(t, environment);
    for (const overrides of [
      { HEALTH: JSON.stringify({ ...health, releaseCommit: stale }) },
      { VOICE: JSON.stringify({ releaseCommit: stale }) },
    ]) {
      const result = run(overrides);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    }
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.owners.voice.candidateKey = 'f'.repeat(64);
    writeFileSync(planPath, JSON.stringify(plan));
    const forged = run({ VOICE: JSON.stringify({ releaseCommit: equivalent }) });
    assert.notEqual(forged.status, 0);
    assert.equal(forged.stdout, '');
    rmSync(planPath);
    const absent = run({ HEALTH: JSON.stringify({ ...health, releaseCommit: equivalent }) });
    assert.notEqual(absent.status, 0, 'source equivalence cannot be inferred without its host plan');
    assert.equal(absent.stdout, '');
  });

  test(`${environment}: publication rejects missing services, bad health and stale releases`, t => {
    const { run, router, health, root, revision } = fixture(t, environment);
    const cases = [
      { INACTIVE: "pi-remote@sybil.service" },
      { INACTIVE: "pi-orchestrator@kenan.service" },
      { INACTIVE: "pi-remote-router.service" },
      { INACTIVE: "pi-stack-voice.service" },
      { ROUTER: "{}" }, { ROUTER: "invalid" }, { ROUTER_STATUS: "22" },
      { ROUTER: JSON.stringify({ ...router, environmentId: "wrong" }) },
      { ROUTER: JSON.stringify({ ...router, people: [{ user: "sybil" }] }) },
      { HEALTH: JSON.stringify({ ...health, releaseCommit: "b".repeat(40) }) },
      { HEALTH: JSON.stringify({ ...health, environmentId: "wrong" }) },
      { HEALTH: JSON.stringify({ ...health, ok: false }) },
      { HEALTH: "invalid" }, { UNREACHABLE: "sybil" },
      { VOICE: JSON.stringify({ releaseCommit: "b".repeat(40) }) },
      { FAILED: "pi-remote@kenan.service loaded failed failed Remote" },
      { SYSTEMCTL_STATUS: "1" },
    ];
    for (const overrides of cases) {
      const result = run(overrides);
      assert.notEqual(result.status, 0, JSON.stringify(overrides));
      assert.equal(result.stdout, "", "no success proof on failure");
    }
    for (const component of ["pi-remote", "pi-orchestrator"]) {
      const marker = join(root, component, ".pi-stack-commit");
      writeFileSync(marker, "b".repeat(40));
      assert.notEqual(run().status, 0, component);
      writeFileSync(marker, revision);
    }
  });
}
