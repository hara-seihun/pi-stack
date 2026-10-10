import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { policy, progressBudgetExhausted } from "../deploy/publication-control.mjs";
import { publicationConfig } from "./publication-fixture.mjs";
import { readHostLane, rollForwardHosts } from '../deploy/publication-hosts.mjs';

const root = resolve(import.meta.dirname, "..");
function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), "publication-meetings-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  for (const dir of ["bin", "persons", "requests"]) mkdirSync(join(state, dir));
  const put = (name, text) => writeFileSync(join(state, name), text);
  const command = (name, text) => writeFileSync(join(state, "bin", name), `#!/bin/sh\n${text}\n`, { mode: 0o700 });
  put("persons/alice.json", JSON.stringify({ user: "alice", port: 1234 }));
  put("host.json", JSON.stringify({ version: 1, fleetUser: "alice" }));
  command("systemctl", 'case "$*" in *pi-stack-publication-host@*) printf "%s\\n" "${HOST_WORKER_STATE:-inactive}" ;; *) printf "%s\\n" "${SUPERVISOR_STATE:-active}" ;; esac');
  command("curl", 'printf "%s\\n" "$*" >> "$PROBE_LOG"; [ "${PROBE_FAIL:-0}" = 0 ] || exit "${PROBE_STATUS:-7}"; case "$*" in */v1/health*) printf "%s\\n" "$HEALTH" ;; *) [ "${ROOMS_FAIL:-0}" = 0 ] || exit "$ROOMS_FAIL"; printf "%s\\n" "$ROOMS" ;; esac');
  command("ssh", 'while [ "$#" -gt 0 ] && [ "$1" != bash ]; do shift; done; [ "$#" -gt 0 ] || exit 64; shift; exec bash "$@"');
  command("git", 'printf "unexpected deployment work\\n" >> "$GIT_LOG"; echo "fixture stops resumed checkout" >&2; exit 42');
  const env = { ...process.env, PATH: `${state}/bin:${process.env.PATH}`, PI_STACK_DEPLOY_NO_SUDO: "1",
    PI_REMOTE_PERSONS_DIR: join(state, "persons"), PI_STACK_HOST_FILE: join(state, "host.json"), PI_STACK_PUBLICATION_STATE: state,
    PI_STACK_PUBLICATION_CONFIG: publicationConfig(state), PI_STACK_PUBLICATION_ALERT_INBOX: join(state, "inbox"),
    PROBE_LOG: join(state, "probes"), GIT_LOG: join(state, "git-log"), ROOMS: '{"rooms":[{"id":"live"}]}', HEALTH: '{"ok":true}' };
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

test("a supervisor retired by native-history maintenance has no rooms; any other silent active supervisor stays unknown", t => {
  const f = fixture(t);
  f.put("persons/alice.json", JSON.stringify({ user: "alice", port: 1234, environment: { PI_REMOTE_DATA: "/home/alice/work/.pi-remote" } }));
  const command = (name, text) => writeFileSync(join(f.state, "bin", name), `#!/bin/sh\n${text}\n`, { mode: 0o700 });
  command("systemctl", 'case "$*" in *MainPID*) printf "%s\\n" "${MAIN_PID:-4242}" ;; *pi-remote-dev-supervisor@*) printf "%s\\n" "${DEV_STATE:-inactive}" ;; *) printf "%s\\n" "${SUPERVISOR_STATE:-active}" ;; esac');
  command("id", 'echo 1010');
  command("nsenter", 'printf "%s\\n" "$*" >> "$NSENTER_LOG"; [ "${RECEIPT_FAIL:-0}" = 0 ] || exit 1; printf "%s\\n" "${PHASE:-migrated}"');
  const census = extra => f.run("bash", [join(root, "deploy/meeting-census")], { PROBE_FAIL: "1", NSENTER_LOG: join(f.state, "nsenter"), ...extra });
  for (const phase of ["migrated", "owners-closed", "migration-pending"]) {
    const result = census({ PHASE: phase });
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "");
  }
  assert.match(readFileSync(join(f.state, "nsenter"), "utf8"), /-t 4242 -m -S 1010 -G 1010 jq -er \.phase \| strings \/home\/alice\/work\/\.pi-remote\/native-history-maintenance\.json/);
  for (const extra of [{ PHASE: "draining" }, { PHASE: "restored" }, { RECEIPT_FAIL: "1" }, { MAIN_PID: "0" }, { DEV_STATE: "active" }, { SUPERVISOR_STATE: "activating" }]) {
    assert.notEqual(census(extra).status, 0, JSON.stringify(extra));
  }
  f.put("persons/alice.json", JSON.stringify({ user: "alice", port: 1234 }));
  assert.notEqual(census({}).status, 0, "no data directory means no proof");
});

test("restart admission permits independent meeting runtimes but protects the first upgrade and unknown health", t => {
  const f = fixture(t);
  const census = extra => f.run("bash", [join(root, "deploy/meeting-census"), "--restart-blockers"], extra);
  const supported = JSON.stringify({ ok: true, meetingRuntime: { protocol: "meet-runtime-v1", lifetime: "person-service" } });
  assert.equal(census({ HEALTH: '{"ok":true}' }).stdout.trim(), "alice:1", "an old in-process room still blocks the first upgrade");
  rmSync(f.env.PROBE_LOG);
  const independent = census({ HEALTH: supported, ROOMS_FAIL: "28" });
  assert.equal(independent.status, 0, independent.stderr);
  assert.equal(independent.stdout.trim(), "", "independent custody needs no application room-list request");
  assert.match(readFileSync(f.env.PROBE_LOG, "utf8"), /\/v1\/health/);
  assert.doesNotMatch(readFileSync(f.env.PROBE_LOG, "utf8"), /\/v1\/meet/);
  assert.notEqual(census({ HEALTH: '{"ok":true}', ROOMS_FAIL: "28" }).status, 0, "in-process rooms still require a successful room census");
  assert.notEqual(f.run("bash", [join(root, "deploy/meeting-census"), "--all"], { HEALTH: supported, ROOMS_FAIL: "28" }).status, 0, "diagnostics still require the full census");
  assert.equal(census({ HEALTH: '{"ok":true,"meetingRuntime":{"protocol":"unknown","lifetime":"person-service"}}' }).stdout.trim(), "alice:1");
  for (const health of ["invalid", "{}", '{"ok":false}']) assert.notEqual(census({ HEALTH: health }).status, 0);
  writeFileSync(join(f.state, "bin", "host-census"), '#!/bin/sh\necho scheduler:live\n', { mode: 0o700 });
  f.put("host.json", JSON.stringify({ version: 1, fleetUser: "alice", meetingCensus: [join(f.state, "bin", "host-census")] }));
  assert.equal(census({ HEALTH: supported }).stdout.trim(), "", "scheduler rooms attach through a preserving supervisor");
  assert.equal(census({ HEALTH: '{"ok":true}' }).stdout.trim(), "alice:1 scheduler:live");
  assert.equal(f.run("bash", [join(root, "deploy/meeting-census"), "--all"], { HEALTH: supported }).stdout.trim(), "alice:1 scheduler:live", "diagnostics still report live rooms");
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

test('active host delivery keeps immutable custody without repeating source preparation or live-room probes', t => {
  const f = fixture(t);
  const requestId = 'PUB-0123456789abcdef01234567';
  const integrationSha = 'b'.repeat(40);
  const request = { version: 3, requestId, sourceSha: 'a'.repeat(40), sourceRef: 'refs/heads/retained',
    integrationSha, integratedAt: '2026-01-01T00:00:00Z', checks: { status: 'passed' },
    status: 'queued', step: 'waiting-for-hosts', attempt: policy.maxAttempts,
    progress: { command: 'central-checks', deadlineAt: new Date(0).toISOString() }, failures: [] };
  const laneRoot = join(f.state, 'host-lanes');
  const targets = [{ id: 'gmktec' }, { id: 'converge' }];
  rollForwardHosts(request, targets, { laneRoot, active: () => false, launch: () => ({ ok: true }), save() {} });
  for (const target of targets) {
    const lane = readHostLane(laneRoot, requestId, integrationSha, target.id);
    writeFileSync(join(laneRoot, requestId, integrationSha, target.id, 'journal.json'), JSON.stringify({
      ...lane, state: 'running', startedAt: '2026-01-01T00:00:00Z',
      fields: lane.fields.map((field, index) => index === 1 ? { present: true, value: { state: 'restore-required', integrationSha } } : field),
    }));
  }
  request.waiting = { kind: 'hosts', hosts: targets.map(target => target.id), at: new Date(0).toISOString() };
  request.nextAttemptAt = new Date(0).toISOString();
  f.put(`requests/${requestId}.json`, JSON.stringify(request));
  const result = f.run(process.execPath, [join(root, 'deploy/publication'), 'drain'], { HOST_WORKER_STATE: 'active', PROBE_FAIL: '1' });
  assert.equal(result.status, 0, result.stderr);
  const waited = JSON.parse(readFileSync(join(f.state, `requests/${requestId}.json`), 'utf8'));
  assert.equal(waited.status, 'queued');
  assert.equal(waited.attempt, policy.maxAttempts);
  for (const target of targets) {
    assert.equal(waited.hosts[target.id].waiting.kind, 'host-delivery');
    assert.equal(waited.hosts[target.id].ready, false);
    assert.equal(waited.reservations[target.id].state, 'restore-required');
    assert.equal(waited.hostDelivery[target.id].state, 'running');
  }
  assert.deepEqual(waited.progress, request.progress);
  assert.deepEqual(waited.checks, request.checks);
  assert.equal(existsSync(f.env.GIT_LOG), false, 'host worker owns prepared immutable source; coordinator must not reset it');
  assert.equal(existsSync(f.env.PROBE_LOG), false, 'an active host worker is not a live-meeting wait');
});

test("a preserving publication resumes its durable wait while the meeting is still live", t => {
  const f = fixture(t);
  const id = "PUB-0123456789abcdef01234567";
  const file = `requests/${id}.json`;
  f.put(file, JSON.stringify({ requestId: id, sourceSha: "a".repeat(40), sourceRef: "refs/heads/retained", status: "queued", attempt: 1,
    meetingRuntimeProtocol: "meet-runtime-v1", nextAttemptAt: new Date(0).toISOString(),
    waiting: { kind: "live-meeting", host: "converge", log: join(f.state, "wait.log") }, failures: [] }));
  const result = f.run(process.execPath, [join(root, "deploy/publication"), "drain"], {
    HEALTH: '{"ok":true,"meetingRuntime":{"protocol":"meet-runtime-v1","lifetime":"person-service"}}',
  });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(readFileSync(join(f.state, file), "utf8"));
  assert.equal(request.attempt, 1);
  assert.equal(request.hosts.converge.waiting.probe.rooms, "");
  assert.ok(request.hostWait.resumedAt);
  assert.equal(request.status, "failed", "the subsequent fixture checkout fails, not live-meeting admission");
  assert.equal(request.failure.message, "checkout preparation exited 42");
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
