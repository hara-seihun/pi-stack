import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

const configRoot = mkdtempSync(join(tmpdir(), "publication-proof-config-"));
process.env.PI_STACK_PUBLICATION_CONFIG = publicationConfig(configRoot);
process.on("exit", () => rmSync(configRoot, { recursive: true, force: true }));
const { hostProofScript } = await import("../deploy/publication");
const revision = "a".repeat(40);
function fixture(t, environment) {
  const root = mkdtempSync(join(tmpdir(), "publication-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const script = hostProofScript.replaceAll("/srv/pi", root);
  function run(overrides = {}) {
    writeFileSync(trace, "");
    const result = spawnSync("bash", ["-s", "--", revision, environment, environment, hostConfig,
      "http://127.0.0.1:8796/status", resolve("deploy/check-services")], {
      input: script, encoding: "utf8", timeout: 3000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TRACE: trace,
        ROUTER: JSON.stringify(router), HEALTH: JSON.stringify(health), VOICE: JSON.stringify({ releaseCommit: revision }),
        INACTIVE: "pi-remote@kenan.service", FAILED: "", UNREACHABLE: "", ...overrides },
    });
    return { ...result, trace: readFileSync(trace, "utf8") };
  }
  return { run, router, health, root };
}

for (const environment of ["local", "converge"]) {
  test(`${environment}: publication proves unlocked people without opening locked Kenan`, t => {
    const { run, router } = fixture(t, environment);
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

  test(`${environment}: publication rejects missing services, bad health and stale releases`, t => {
    const { run, router, health, root } = fixture(t, environment);
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
