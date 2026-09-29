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
    checks: { status: "passed" }, hosts: { other: { status: "passed" } },
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
  assert.equal(waited.waiting.probe.rooms, "alice:1");
  assert.ok(Date.parse(waited.nextAttemptAt) > Date.now());
  for (const field of ["checks", "hosts", "sourceRef", "integrationSha", "reservations", "maintenance"]) assert.deepEqual(waited[field], request[field]);
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
  assert.equal(failed.meetingWait.probe.rooms, "");
  assert.ok(failed.meetingWait.resumedAt);
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
  assert.equal(existsSync(f.env.PROBE_LOG), false);
  assert.equal(existsSync(f.env.GIT_LOG), false);
});

test("a failing meeting probe keeps waiting without deploying, then fails once the probe itself stays broken", t => {
  const f = fixture(t);
  const id = "PUB-0123456789abcdef01234567";
  const file = join(f.state, "requests", `${id}.json`);
  f.put(`requests/${id}.json`, JSON.stringify({ requestId: id, sourceSha: "a".repeat(40), status: "queued", attempt: 1,
    nextAttemptAt: new Date(0).toISOString(), waiting: { kind: "live-meeting", host: "converge", log: join(f.state, "wait.log") }, failures: [] }));
  const drain = () => f.run(process.execPath, [join(root, "deploy/publication"), "drain"], { PROBE_FAIL: "1" });
  assert.equal(drain().status, 0);
  let request = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(request.status, "queued");
  assert.match(request.waiting.probe.error, /failed/);
  assert.ok(request.waiting.probeFailingSince);
  assert.ok(Date.parse(request.nextAttemptAt) > Date.now());
  assert.equal(existsSync(f.env.GIT_LOG), false, "an unknown census must not deploy");
  request.nextAttemptAt = new Date(0).toISOString();
  request.waiting.probeFailingSince = new Date(Date.now() - policy.meetingProbeFailureLimitMs - 1000).toISOString();
  writeFileSync(file, JSON.stringify(request));
  assert.equal(drain().status, 0);
  request = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(request.status, "failed");
  assert.match(request.failure.message, /Meeting wait probe failed/);
  assert.equal(existsSync(f.env.GIT_LOG), false);
});
