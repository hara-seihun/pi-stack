import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { policy, progressBudgetExhausted } from "../deploy/publication-control.mjs";
import { publicationConfig } from "./publication-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), "publication-meetings-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  for (const dir of ["bin", "persons", "requests"]) mkdirSync(join(state, dir));
  const put = (name, text) => writeFileSync(join(state, name), text);
  const command = (name, text) => writeFileSync(join(state, "bin", name), `#!/bin/sh\n${text}\n`, { mode: 0o700 });
  put("persons/alice.json", JSON.stringify({ user: "alice", port: 1234 }));
  put("host.json", JSON.stringify({ version: 1, fleetUser: "alice" }));
  command("systemctl", 'printf "%s\\n" "${SUPERVISOR_STATE:-active}"');
  command("curl", 'printf "probe\\n" >> "$PROBE_LOG"; [ "${PROBE_FAIL:-0}" = 0 ] || exit "${PROBE_STATUS:-7}"; printf "%s\\n" "$ROOMS"');
  command("ssh", 'exec bash -s');
  command("git", 'printf "unexpected deployment work\\n" >> "$GIT_LOG"; echo "fixture stops resumed checkout" >&2; exit 42');
  const env = { ...process.env, PATH: `${state}/bin:${process.env.PATH}`, PI_STACK_DEPLOY_NO_SUDO: "1",
    PI_REMOTE_PERSONS_DIR: join(state, "persons"), PI_STACK_HOST_FILE: join(state, "host.json"), PI_STACK_PUBLICATION_STATE: state,
    PI_STACK_PUBLICATION_CONFIG: publicationConfig(state), PI_STACK_PUBLICATION_ALERT_INBOX: join(state, "inbox"),
    PROBE_LOG: join(state, "probes"), GIT_LOG: join(state, "git-log"), ROOMS: '{"rooms":[{"id":"live"}]}' };
  const run = (command, args, extra = {}) => spawnSync(command, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 5000 });
  return { state, put, env, run };
}

test("meeting census protects production and development rooms and rejects unknown live state", t => {
  const f = fixture(t);
  const census = extra => f.run("bash", [join(root, "deploy/meeting-census")], extra);
  assert.equal(census().stdout.trim(), "alice:1");
  const viaDeployment = f.run("bash", ["-c", 'source "$1/deploy/lib"; pi_stack_live_meeting_rooms', "census-test", root]);
  assert.equal(viaDeployment.status, 0, viaDeployment.stderr);
  assert.equal(viaDeployment.stdout.trim(), "alice:1");
  assert.equal(census({ ROOMS: '{"rooms":[]}' }).stdout.trim(), "");
  for (const extra of [{ ROOMS: '{}' }, { ROOMS: 'invalid' }, { ROOMS: '{"rooms":null}' }, { PROBE_FAIL: "1" }, { PROBE_FAIL: "1", SUPERVISOR_STATE: "unknown" },
    { PROBE_FAIL: "1", SUPERVISOR_STATE: "inactive\nactive" },
    { PROBE_FAIL: "1", PROBE_STATUS: "22", SUPERVISOR_STATE: "inactive" },
    { PROBE_FAIL: "1", PROBE_STATUS: "28", SUPERVISOR_STATE: "inactive" }]) {
    assert.notEqual(census(extra).status, 0, JSON.stringify(extra));
  }
  for (const state of ["inactive", "failed"]) assert.equal(census({ SUPERVISOR_STATE: state, PROBE_FAIL: "1" }).status, 0);
  assert.equal(census({ SUPERVISOR_STATE: "inactive" }).stdout.trim(), "alice:1", "a development listener still owns its rooms");
});

for (const host of ["gmktec", "converge"]) test(`${host} meeting waits survive budgets and restart, then resume the same attempt`, t => {
  const f = fixture(t);
  const requestId = "PUB-0123456789abcdef01234567";
  const file = `requests/${requestId}.json`;
  const request = { version: 3, requestId, sourceSha: "a".repeat(40), sourceRef: "refs/heads/retained",
    integrationSha: "b".repeat(40), status: "queued", step: "waiting-for-live-meetings", attempt: policy.maxAttempts,
    nextAttemptAt: new Date(0).toISOString(), waiting: { kind: "live-meeting", host, at: new Date(0).toISOString(), log: join(f.state, "wait.log") },
    checks: { status: "passed" }, hosts: { [host === "gmktec" ? "converge" : "gmktec"]: { status: "passed" } },
    reservations: { [host]: { state: "released", integrationSha: "b".repeat(40) } },
    maintenance: { hosts: { [host]: { state: "restored", plan: { intake: "paused" } } } }, failures: [] };
  assert.equal(progressBudgetExhausted(request), false);
  const drain = extra => f.run(process.execPath, [join(root, "deploy/publication"), "drain"], extra);
  const read = () => JSON.parse(readFileSync(join(f.state, file), "utf8"));
  f.put(file, JSON.stringify(request));
  assert.equal(drain().status, 0);
  let waited = read();
  assert.equal(waited.status, "queued");
  assert.equal(waited.attempt, policy.maxAttempts);
  assert.equal(waited.waiting.kind, "hosts", "legacy waits migrate into independent host delivery");
  assert.equal(waited.hosts[host].waiting.probe.rooms, "alice:1");
  assert.equal(waited.hosts[host].ready, false);
  assert.ok(Date.parse(waited.nextAttemptAt) > Date.now());
  for (const field of ["checks", "sourceRef", "integrationSha", "reservations", "maintenance"]) assert.deepEqual(waited[field], request[field]);
  for (const [id, receipt] of Object.entries(request.hosts)) assert.deepEqual(waited.hosts[id], receipt);
  assert.equal(existsSync(f.env.GIT_LOG), false, "waiting must not prepare or deploy");
  assert.equal(existsSync(join(f.state, "repairs", requestId, "receipt.json")), false);
  waited.nextAttemptAt = new Date(0).toISOString();
  f.put(file, JSON.stringify(waited));
  assert.equal(drain().status, 0, "a new worker continues the durable wait");
  waited = read();
  waited.nextAttemptAt = new Date(0).toISOString();
  f.put(file, JSON.stringify(waited));
  const resumed = drain({ ROOMS: '{"rooms":[]}' });
  assert.equal(resumed.status, 0, resumed.stderr);
  const failed = read();
  assert.equal(failed.status, "failed", "actual checkout errors remain terminal");
  assert.equal(failed.attempt, request.attempt, "closure resumes, not spends another attempt");
  assert.equal(failed.failure.message, "checkout preparation exited 42");
  assert.match(readFileSync(failed.failure.log, "utf8"), /fixture stops resumed checkout/);
  assert.equal(failed.hosts[host].waiting.probe.rooms, "");
  assert.ok(failed.hostWait.resumedAt);
});

test("a host meeting census adds the meetings Pi Remote cannot see and never reads failure as idle", t => {
  const f = fixture(t);
  const census = extra => f.run("bash", [join(root, "deploy/meeting-census")], extra);
  const host = extra => f.put("host.json", JSON.stringify({ version: 1, fleetUser: "alice", ...extra }));
  writeFileSync(join(f.state, "bin", "host-census"), '#!/bin/sh\necho "note on stderr" >&2\n[ "${HOST_FAIL:-0}" = 0 ] || exit 3\nprintf "%b" "${HOST_MEETINGS:-}"\n', { mode: 0o700 });
  host({ meetingCensus: [join(f.state, "bin", "host-census")] });
  assert.equal(census({ ROOMS: '{"rooms":[]}' }).stdout.trim(), "", "an idle host census adds nothing, and its stderr is not a meeting");
  assert.equal(census({ ROOMS: '{"rooms":[]}', HOST_MEETINGS: "runtime:2\\nlobby bot\\n" }).stdout.trim(), "runtime:2 lobby_bot");
  assert.equal(census({ HOST_MEETINGS: "runtime:1\\n" }).stdout.trim(), "alice:1 runtime:1");
  const failed = census({ ROOMS: '{"rooms":[]}', HOST_FAIL: "1" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /cannot census host meetings/);
  host({ meetingCensus: "host-census" });
  assert.notEqual(census({ ROOMS: '{"rooms":[]}' }).status, 0, "a malformed meetingCensus is not an empty host");
});

test("native release prerequisites wait for a selected ancestor, then accept the switched source", t => {
  const dir = mkdtempSync(join(tmpdir(), "publication-native-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const native = join(dir, "native");
  mkdirSync(native);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", native, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "old selected");
  const old = git("rev-parse", "HEAD");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "required native");
  const required = git("rev-parse", "HEAD");
  const candidate = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const source = "35961a5ab09c295833853775ecfe474a9d40b32d";
  const host = join(dir, "host.json");
  writeFileSync(host, JSON.stringify({ releasePrerequisites: [{ name: "kenan-meeting-runtime", piStackSource: source,
    nativeSource: required, statusSocket: join(dir, "status.sock"), nativeRepository: native }] }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nprintf \'{"source":{"commit":"%s"}}\\n\' "$SELECTED"\n', { mode: 0o755 });
  const probe = selected => spawnSync("bash", [join(root, "deploy/native-prerequisites"), host, root, candidate],
    { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SELECTED: selected } });
  const waiting = probe(old);
  assert.equal(waiting.status, 75, waiting.stderr);
  assert.match(waiting.stderr, /native source prerequisite kenan-meeting-runtime requires/);
  assert.equal(probe(required).status, 0);
  assert.equal(progressBudgetExhausted({ attempt: policy.maxAttempts, waiting: { kind: "native-source" } }), false);
  writeFileSync(host, JSON.stringify({ releasePrerequisites: "malformed" }));
  assert.notEqual(probe(required).status, 0, "malformed host declaration is not a satisfied dependency");
});

test("publication retains a native-source wait and resumes without consuming an attempt", t => {
  const f = fixture(t);
  const id = "PUB-0123456789abcdef01234567";
  const old = "1".repeat(40), required = "2".repeat(40);
  f.put("host.json", JSON.stringify({ version: 1, fleetUser: "alice", releasePrerequisites: [{ name: "native",
    piStackSource: "a".repeat(40), nativeSource: required, statusSocket: `${f.state}/status.sock`, nativeRepository: `${f.state}/native` }] }));
  writeFileSync(join(f.state, "bin", "curl"), '#!/bin/sh\nprintf \'{"source":{"commit":"%s"}}\\n\' "$SELECTED"\n', { mode: 0o755 });
  writeFileSync(join(f.state, "bin", "git"), `#!/bin/sh\nif [ "$3" = "merge-base" ] && [ "$5" = "${required}" ]; then [ "${"$SELECTED"}" = "${required}" ]; exit; fi\n[ "$3" = "merge-base" ] && exit 0\n[ "$3" = "cat-file" ] && exit 0\necho "fixture stops resumed checkout" >&2\nexit 42\n`, { mode: 0o755 });
  const file = `requests/${id}.json`;
  const request = { requestId: id, sourceSha: "a".repeat(40), integrationSha: "b".repeat(40), status: "queued",
    step: "waiting-for-native-source", attempt: policy.maxAttempts, nextAttemptAt: new Date(0).toISOString(),
    waiting: { kind: "native-source", host: "gmktec", log: join(f.state, "wait.log") },
    checks: { status: "passed" }, hosts: { converge: { status: "passed" } }, failures: [] };
  f.put(file, JSON.stringify(request));
  const drain = selected => f.run(process.execPath, [join(root, "deploy/publication"), "drain"], { SELECTED: selected });
  const read = () => JSON.parse(readFileSync(join(f.state, file), "utf8"));
  assert.equal(drain(old).status, 0);
  const waiting = read();
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.attempt, policy.maxAttempts);
  assert.equal(waiting.waiting.kind, "hosts");
  assert.match(waiting.hosts.gmktec.waiting.probe.selected, /native source prerequisite/);
  waiting.nextAttemptAt = new Date(0).toISOString();
  f.put(file, JSON.stringify(waiting));
  assert.equal(drain(required).status, 0);
  const resumed = read();
  assert.equal(resumed.status, "failed", "the fixture's subsequent checkout fails, not the prerequisite");
  assert.equal(resumed.attempt, request.attempt);
  assert.equal(resumed.hosts.gmktec.waiting.probe.selected, "ready");
  assert.ok(resumed.hostWait.resumedAt);
});

test("ordinary lock and gate waits retain both progress limits", () => {
  assert.equal(progressBudgetExhausted({ attempt: policy.maxAttempts, waiting: { kind: "host-lock" } }), true);
  assert.equal(progressBudgetExhausted({ attempt: 1, blockedSince: new Date(0).toISOString() }), true);
  assert.equal(progressBudgetExhausted({ attempt: 1 }), false);
});

test("cancellation ends a meeting wait without probing or deploying", t => {
  const f = fixture(t);
  const id = "PUB-0123456789abcdef01234567";
  f.put(`requests/${id}.json`, JSON.stringify({ requestId: id, sourceSha: "a".repeat(40), status: "queued", attempt: 1,
    nextAttemptAt: new Date(0).toISOString(), waiting: { kind: "live-meeting", host: "converge", log: join(f.state, "wait.log") }, failures: [] }));
  f.put(`requests/${id}.cancel`, "cancelled\n");
  const result = f.run(process.execPath, [join(root, "deploy/publication"), "drain"], { PROBE_FAIL: "1" });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(readFileSync(join(f.state, "requests", `${id}.json`), "utf8"));
  assert.equal(request.status, "failed");
  assert.match(request.failure.message, /Publication cancelled/);
  assert.equal(existsSync(join(f.state, "repairs", id, "receipt.json")), false, "cancellation is not a repairable defect");
  assert.equal(existsSync(f.env.PROBE_LOG), false);
  assert.equal(existsSync(f.env.GIT_LOG), false);
});

test("a failing meeting probe keeps waiting without deploying, then fails once the probe itself stays broken", t => {
  const f = fixture(t);
  const id = "PUB-0123456789abcdef01234567";
  const file = join(f.state, "requests", `${id}.json`);
  f.put(`requests/${id}.json`, JSON.stringify({ requestId: id, sourceSha: "a".repeat(40), status: "queued", attempt: 1,
    nextAttemptAt: new Date(0).toISOString(), waiting: { kind: "live-meeting", host: "converge", log: join(f.state, "wait.log") },
    hosts: { gmktec: { status: "passed" } }, failures: [] }));
  const drain = () => f.run(process.execPath, [join(root, "deploy/publication"), "drain"], { PROBE_FAIL: "1" });
  assert.equal(drain().status, 0);
  let request = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(request.status, "queued");
  assert.match(request.hosts.converge.waiting.probe.error, /failed/);
  assert.ok(request.hosts.converge.waiting.probeFailingSince);
  assert.equal(request.hosts.converge.ready, false);
  assert.ok(Date.parse(request.nextAttemptAt) > Date.now());
  assert.equal(existsSync(f.env.GIT_LOG), false, "an unknown census must not deploy");
  request.nextAttemptAt = new Date(0).toISOString();
  request.hosts.converge.waiting.probeFailingSince = new Date(Date.now() - policy.meetingProbeFailureLimitMs - 1000).toISOString();
  writeFileSync(file, JSON.stringify(request));
  assert.equal(drain().status, 0);
  request = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(request.status, "failed");
  assert.equal(request.hosts.converge.status, "failed");
  assert.match(request.hosts.converge.failure.message, /readiness probe failed/);
});
