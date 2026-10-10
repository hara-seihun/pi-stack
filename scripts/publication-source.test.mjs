import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

const publication = new URL("../deploy/publication", import.meta.url).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "publication-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "host"), checkout = join(root, "repository");
  function git(path, ...args) {
    const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  for (const path of [source, checkout]) {
    mkdirSync(path);
    git(path, "init", "--quiet");
  }
  git(source, "config", "user.name", "Publication test");
  git(source, "config", "user.email", "publication@example.test");
  mkdirSync(join(source, "packages/orchestrator/src/threads"), { recursive: true });
  const contract = join(source, "packages/orchestrator/src/threads/contracts.ts");
  writeFileSync(contract, 'export const THREAD_EXECUTION_CONTRACT = "unified-threads-v1";\n');
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Host-only release");
  const commit = git(source, "rev-parse", "HEAD");
  const ssh = join(root, "ssh");
  writeFileSync(ssh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SSH_LOG"\nfor arg do command=$arg; done\nexec sh -c "$command"\n', { mode: 0o700 });
  function inspect(selectedCommit = commit, remoteHost) {
    return spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { retainSelectedSource, hasExecutionContract } from ${JSON.stringify(publication)};
      const census = { selectedCommit: ${JSON.stringify(selectedCommit)} };
      retainSelectedSource(census, ${JSON.stringify(remoteHost)});
      console.log(JSON.stringify({ census, contract: census.selectedCommit ? hasExecutionContract(census.selectedCommit) : null }));
    `], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root, source),
        GIT_SSH_COMMAND: ssh, SSH_LOG: join(root, "ssh.log") },
    });
  }
  function ancestry(census, target, remoteHost) {
    return spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { inspectReleaseAncestry } from ${JSON.stringify(publication)};
      console.log(JSON.stringify(inspectReleaseAncestry(${JSON.stringify(census)}, ${JSON.stringify(target)}, ${JSON.stringify(remoteHost)})));
    `], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root, source),
        GIT_SSH_COMMAND: ssh, SSH_LOG: join(root, "ssh.log") },
    });
  }
  return { root, source, checkout, commit, contract, git, inspect, ancestry };
}

for (const remoteHost of [undefined, "converge-kenan"]) {
  test(`contract inspection retains a host-only commit via ${remoteHost ?? "local repository"}`, t => {
    const f = fixture(t);
    const missing = spawnSync("git", ["-C", f.checkout, "cat-file", "-e", f.commit]);
    assert.notEqual(missing.status, 0);
    const result = f.inspect(f.commit, remoteHost);
    assert.equal(result.status, 0, result.stderr);
    const { census, contract } = JSON.parse(result.stdout);
    assert.equal(contract, true);
    assert.equal(census.selectedSource.commit, f.commit);
    assert.equal(f.git(f.checkout, "rev-parse", census.selectedSource.ref), f.commit);
    if (remoteHost) assert.match(readFileSync(join(f.root, "ssh.log"), "utf8"), /converge-kenan/);
    rmSync(f.source, { recursive: true });
    const retained = f.inspect(f.commit, remoteHost);
    assert.equal(retained.status, 0, retained.stderr);
    assert.equal(JSON.parse(retained.stdout).contract, true);
    assert.equal(f.git(f.checkout, "status", "--porcelain"), "");
  });
}

for (const remoteHost of [undefined, "converge-kenan"]) {
  test(`ancestry rejects divergent live and checkout source until merged via ${remoteHost ?? "local repository"}`, t => {
    const f = fixture(t);
    writeFileSync(join(f.source, "host-repair"), "retain this repair\n");
    f.git(f.source, "add", ".");
    f.git(f.source, "commit", "--quiet", "-m", "Host recovery");
    const hostRepair = f.git(f.source, "rev-parse", "HEAD");
    f.git(f.source, "checkout", "--quiet", "-b", "submission", f.commit);
    writeFileSync(join(f.source, "submitted-change"), "new publication\n");
    f.git(f.source, "add", ".");
    f.git(f.source, "commit", "--quiet", "-m", "Submitted change");
    const target = f.git(f.source, "rev-parse", "HEAD");
    f.git(f.checkout, "fetch", "--quiet", f.source, target);
    const before = f.git(f.checkout, "for-each-ref", "--format=%(refname)");
    for (const kind of ["selectedCommit", "checkoutCommit"]) {
      const census = { host: remoteHost ?? "gmktec", selectedCommit: f.commit, checkoutCommit: f.commit, [kind]: hostRepair };
      const rejected = f.ancestry(census, target, remoteHost);
      assert.equal(rejected.status, 0, rejected.stderr);
      const proof = JSON.parse(rejected.stdout);
      assert.equal(proof.ok, false);
      assert.deepEqual(proof.baselines.filter(baseline => !baseline.included).map(baseline => baseline.commit), [hostRepair]);
      for (const baseline of proof.baselines) assert.equal(f.git(f.checkout, "rev-parse", baseline.ref), baseline.commit);
    }
    assert.equal(before, "");
    f.git(f.source, "merge", "--quiet", "--no-ff", "-m", "Retain host repair", hostRepair);
    const merged = f.git(f.source, "rev-parse", "HEAD");
    f.git(f.checkout, "fetch", "--quiet", f.source, merged);
    const passed = f.ancestry({ host: remoteHost ?? "gmktec", selectedCommit: hostRepair, checkoutCommit: target }, merged, remoteHost);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).ok, true);
    assert.equal(f.git(f.source, "show", `${merged}:host-repair`), "retain this repair");
    assert.equal(f.git(f.source, "show", `${merged}:submitted-change`), "new publication");
    assert.equal(f.git(f.source, "rev-parse", "HEAD"), merged);
    assert.equal(f.git(f.checkout, "status", "--porcelain"), "");
  });
}

test("typed host waits retain the integration, while unrelated exit 75 remains a failure", t => {
  const f = fixture(t);
  const release = join(f.root, "release");
  const log = join(f.root, "deployment.log");
  const request = { requestId: "PUB-0123456789abcdef01234567", integrationSha: f.commit,
    attempt: 1, status: "running", progress: { step: "deploy-converge" },
    hosts: { gmktec: { status: "passed" } } };
  const run = message => {
    writeFileSync(release, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(message)} >&2\nexit 75\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { deployTarget, requeueBusyHost } from ${JSON.stringify(publication)};
      const request = ${JSON.stringify(request)};
      const target = { id: "converge", sshHost: null, releaseCommand: ${JSON.stringify(release)} };
      const result = deployTarget(request, target, ${JSON.stringify(log)});
      if (result.kind === "host-lock-busy") requeueBusyHost(request, target, ${JSON.stringify(log)}, result.liveMeeting ? "live-meeting" : result.liveTelephone ? "live-telephone" : result.nativePrerequisite ? "native-source" : result.nativeHistory ? "native-history" : "host-lock");
      console.log(JSON.stringify({ result, request }));
    `], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      PI_STACK_PUBLICATION_STATE: f.root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(f.root, f.source) } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const busy = run("another Pi stack deployment owns /srv/pi/.pi-stack-deploy.lock");
  assert.equal(busy.result.kind, "host-lock-busy");
  assert.equal(busy.request.status, "queued");
  assert.equal(busy.request.waiting.host, "converge");
  assert.equal(busy.request.waiting.kind, "host-lock");
  assert.equal(busy.request.step, "waiting-for-host-deployment-lock");
  assert.ok(busy.request.blockedSince);
  assert.equal(busy.request.attempt, 1);
  assert.deepEqual(busy.request.hosts, request.hosts);
  assert.equal(busy.request.integrationSha, f.commit);
  assert.ok(Date.parse(busy.request.nextAttemptAt) > Date.now());
  assert.equal(JSON.parse(readFileSync(join(f.root, "requests", `${request.requestId}.json`), "utf8")).status, "queued");
  const meeting = run("live meeting rooms on this host (kenan:1); deploying now would end them");
  assert.equal(meeting.result.kind, "host-lock-busy");
  assert.equal(meeting.request.status, "queued");
  assert.equal(meeting.request.waiting.kind, "live-meeting");
  assert.equal(meeting.request.step, "waiting-for-live-meetings");
  assert.equal(meeting.request.blockedSince, undefined);
  assert.equal(meeting.request.attempt, 1);
  assert.deepEqual(meeting.request.hosts, request.hosts);
  assert.equal(meeting.request.integrationSha, f.commit);
  const unavailable = run("meeting census unavailable on this host: see the census error above");
  assert.equal(unavailable.result.kind, "host-lock-busy");
  assert.equal(unavailable.request.waiting.kind, "live-meeting");
  assert.equal(unavailable.request.attempt, 1);
  assert.deepEqual(unavailable.request.hosts, request.hosts);
  const native = run(`native source prerequisite meeting-runtime requires ${"a".repeat(40)} before Pi Stack ${f.commit}; selected ${"b".repeat(40)}`);
  assert.equal(native.result.kind, "host-lock-busy");
  assert.equal(native.request.status, "queued");
  assert.equal(native.request.waiting.kind, "native-source");
  assert.equal(native.request.step, "waiting-for-native-source");
  assert.equal(native.request.blockedSince, undefined);
  assert.equal(native.request.attempt, 1);
  assert.deepEqual(native.request.hosts, request.hosts);
  assert.equal(native.request.integrationSha, f.commit);
  const history = run("native history boundary waiting: old generation has admitted errands");
  assert.equal(history.result.kind, "host-lock-busy");
  assert.equal(history.request.waiting.kind, "native-history");
  assert.equal(history.request.step, "waiting-for-native-history");
  assert.equal(history.request.attempt, 1);
  assert.equal(history.request.blockedSince, undefined);
  assert.deepEqual(history.request.hosts, request.hosts);
  const telephone = run("Live telephone calls; defer deployment");
  assert.equal(telephone.result.liveTelephone, true);
  assert.equal(telephone.request.waiting.kind, "live-telephone");
  assert.equal(telephone.request.step, "waiting-for-live-telephone-calls");
  assert.equal(telephone.request.blockedSince, undefined);
  assert.equal(telephone.request.attempt, 1);
  assert.deepEqual(telephone.request.hosts, request.hosts);
  const phoneError = run("Phone census unavailable");
  assert.equal(phoneError.result.kind, undefined);
  assert.equal(phoneError.request.status, "running");
  const unrelated = run("release checkout failed for another reason");
  assert.equal(unrelated.result.kind, undefined);
  assert.equal(unrelated.request.status, "running");
});

function integrationFixture(t) {
  const f = fixture(t);
  const remote = join(f.root, "remote.git");
  f.git(f.root, "init", "--quiet", "--bare", remote);
  f.git(f.source, "remote", "add", "origin", remote);
  f.git(f.source, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  f.git(f.checkout, "remote", "add", "origin", remote);
  f.git(f.checkout, "fetch", "--quiet", "origin");
  writeFileSync(join(f.source, "submission"), "submitted work\n");
  f.git(f.source, "add", ".");
  f.git(f.source, "commit", "--quiet", "-m", "Checked source");
  const integrationSha = f.git(f.source, "rev-parse", "HEAD");
  f.git(f.checkout, "fetch", "--quiet", f.source, integrationSha);
  f.git(f.source, "checkout", "--quiet", "--detach", f.commit);
  writeFileSync(join(f.source, "concurrent"), "other writer\n");
  f.git(f.source, "add", ".");
  f.git(f.source, "commit", "--quiet", "-m", "Concurrent source");
  const contender = f.git(f.source, "rev-parse", "HEAD");
  f.git(f.source, "push", "--quiet", "origin", "HEAD:refs/heads/contender");
  const request = { requestId: "PUB-0123456789abcdef01234567", sourceSha: integrationSha,
    sourceRef: "refs/heads/submission", baseSha: f.commit, integrationSha, attempt: 1,
    status: "running", checks: { status: "passed", log: "/retained/checks.log" },
    android: { directory: "/retained/android", release: { revision: integrationSha } },
    hosts: { gmktec: { status: "passed", integrationSha } },
    reservations: { converge: { state: "reserved", integrationSha } },
    nativeHistory: { hosts: { converge: { state: "sealed", integrationSha } } },
    actionJournal: { source: { state: "completed", integrationSha } }, failures: [] };
  function publish(environment = {}) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { publishIntegration } from ${JSON.stringify(publication)};
      const request = ${JSON.stringify(request)};
      const log = ${JSON.stringify(join(f.root, "integration.log"))};
      const result = publishIntegration(request, log);
      console.log(JSON.stringify({ result, request }));
    `], { encoding: "utf8", timeout: 5000, env: { ...process.env, PI_STACK_PUBLICATION_STATE: f.root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(f.root, f.source), ...environment } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { ...f, remote, contender, integrationSha, request, publish };
}

function assertPublishedSource(f, result, request) {
  assert.equal(result.ok, true, result.stderr);
  assert.equal(request.status, "running", "main contention must not requeue source work");
  assert.equal(request.step, "integrated");
  assert.ok(Number.isFinite(Date.parse(request.integratedAt)));
  for (const key of ["sourceSha", "sourceRef", "baseSha", "integrationSha", "attempt", "checks", "android", "hosts", "reservations", "nativeHistory", "actionJournal", "failures"]) {
    assert.deepEqual(request[key], f.request[key], `${key} survives main contention`);
  }
  assert.equal(request.mainMovements, undefined);
  assert.deepEqual(request.deliverySource, {
    sourceSha: f.integrationSha,
    sourceRef: `refs/heads/pi-stack-publications/${request.requestId}-delivery-${f.integrationSha}`,
  });
  const ref = request.deliverySource.sourceRef;
  assert.equal(f.git(f.remote, "rev-parse", ref), f.integrationSha);
  assert.equal(f.git(f.remote, "show", `${ref}:submission`), "submitted work");
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "requests", `${request.requestId}.json`), "utf8")), request);
  return ref;
}

for (const timing of ["before-publish", "during-push"]) test(`main movement ${timing} preserves immutable integration and checked serving evidence`, t => {
  const f = integrationFixture(t);
  f.request.attemptLimit = f.request.attempt;
  if (timing === "before-publish") f.git(f.remote, "update-ref", "refs/heads/main", f.contender);
  else writeFileSync(join(f.checkout, ".git/hooks/pre-push"), `#!/bin/sh
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = refs/heads/main ]; then git -C '${f.remote}' update-ref refs/heads/main ${f.contender}; fi
done
`, { mode: 0o700 });
  assert.equal(f.git(f.checkout, "rev-parse", "origin/main"), f.commit);
  const { result, request } = f.publish();
  const ref = assertPublishedSource(f, result, request);
  assert.equal(request.mainPublication.status, "not-advanced");
  assert.equal(request.mainPublication.sourceSha, f.integrationSha);
  assert.ok(request.mainPublication.message);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.contender);
  rmSync(f.checkout, { recursive: true, force: true });
  rmSync(f.source, { recursive: true, force: true });
  mkdirSync(f.checkout);
  f.git(f.checkout, "init", "--quiet");
  f.git(f.checkout, "fetch", "--quiet", f.remote, ref);
  assert.equal(f.git(f.checkout, "rev-parse", "FETCH_HEAD"), f.integrationSha, "a host can recover the immutable source without the worker checkout");
});

test("main movement does not restore or release either host's active custody", t => {
  const f = integrationFixture(t);
  f.git(f.remote, "update-ref", "refs/heads/main", f.contender);
  f.request.bootstrap = { hosts: {} };
  f.request.maintenance = { hosts: {} };
  for (const host of ["gmktec", "converge"]) {
    f.request.bootstrap.hosts[host] = { state: "sealed", plan: { host, intake: "preserved" } };
    f.request.maintenance.hosts[host] = { state: "paused", plan: { host, launches: "paused" } };
  }
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  for (const command of ["bash", "ssh"]) writeFileSync(join(bin, command), '#!/bin/sh\ncat >> "$RESTORE_LOG"\n', { mode: 0o700 });
  const restoreLog = join(f.root, "restore.log");
  const { result, request } = f.publish({ PATH: `${bin}:${process.env.PATH}`, RESTORE_LOG: restoreLog });
  assertPublishedSource(f, result, request);
  for (const key of ["bootstrap", "maintenance"]) assert.deepEqual(request[key], f.request[key]);
  assert.equal(existsSync(restoreLog), false, "publishing source must not run host restoration commands");
});

for (const alreadyIntegrated of [false, true]) test(`exact source is retained and main fast-forwards, already integrated=${alreadyIntegrated}`, t => {
  const f = integrationFixture(t);
  if (alreadyIntegrated) f.git(f.source, "push", "--quiet", "origin", `${f.integrationSha}:refs/heads/main`);
  const { result, request } = f.publish();
  assertPublishedSource(f, result, request);
  assert.equal(request.mainPublication.status, "advanced");
  assert.equal(request.mainPublication.sourceSha, f.integrationSha);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.integrationSha);
});

test("main advancing after an accepted push preserves the checked immutable source", t => {
  const f = integrationFixture(t);
  f.git(f.source, "checkout", "--quiet", "--detach", f.integrationSha);
  writeFileSync(join(f.source, "next"), "later integration\n");
  f.git(f.source, "add", ".");
  f.git(f.source, "commit", "--quiet", "-m", "Next main");
  const next = f.git(f.source, "rev-parse", "HEAD");
  f.git(f.source, "push", "--quiet", "origin", "HEAD:refs/heads/next");
  writeFileSync(join(f.remote, "hooks/post-receive"), `#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/main ]; then git update-ref refs/heads/main ${next}; fi
done
`, { mode: 0o700 });
  const { result, request } = f.publish();
  assertPublishedSource(f, result, request);
  assert.equal(request.mainPublication.status, "advanced", "main accepted the source even though a subsequent writer advanced it");
  assert.equal(request.mainPublication.sourceSha, f.integrationSha);
  assert.equal(f.git(f.remote, "rev-parse", "main"), next);
});

test("unavailable origin cannot claim durable integration", t => {
  const f = integrationFixture(t);
  f.git(f.checkout, "remote", "set-url", "origin", join(f.root, "absent.git"));
  const { result, request } = f.publish();
  assert.equal(result.ok, false);
  assert.equal(request.integratedAt, undefined);
  assert.equal(request.mainMovements, undefined);
  assert.equal(request.integrationSha, f.integrationSha);
  assert.deepEqual(request.checks, f.request.checks);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.commit);
});

test("rejected immutable ref is a source publication failure", t => {
  const f = integrationFixture(t);
  writeFileSync(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\necho 'repository policy rejects push' >&2\nexit 1\n", { mode: 0o700 });
  const { result, request } = f.publish();
  assert.equal(result.ok, false);
  assert.equal(request.integratedAt, undefined);
  assert.equal(request.mainMovements, undefined);
  assert.equal(request.integrationSha, f.integrationSha);
  assert.match(readFileSync(join(f.root, "integration.log"), "utf8"), /repository policy rejects push/);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.commit);
});

test("rejected main-only update still succeeds with an immutable source and truthful status", t => {
  const f = integrationFixture(t);
  writeFileSync(join(f.remote, "hooks/pre-receive"), `#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/main ]; then echo 'main policy rejects push' >&2; exit 1; fi
done
`, { mode: 0o700 });
  const { result, request } = f.publish();
  assertPublishedSource(f, result, request);
  assert.equal(request.mainPublication.status, "not-advanced");
  assert.equal(request.mainPublication.sourceSha, f.integrationSha);
  assert.ok(request.mainPublication.message);
  assert.match(readFileSync(join(f.root, "integration.log"), "utf8"), /main policy rejects push/);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.commit);
});

test("ancestry reports Git inspection errors rather than a valid deployment", t => {
  const f = fixture(t);
  const result = f.ancestry({ selectedCommit: f.commit }, "f".repeat(40));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot inspect release ancestry/);
});

test("missing and malformed selected source fail instead of classifying a host as pre-contract", t => {
  const f = fixture(t);
  const missing = f.inspect("f".repeat(40));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /git failed:/);
  const malformed = f.inspect("--all");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /invalid source SHA/);
  assert.equal(f.git(f.checkout, "for-each-ref", "--format=%(refname)"), "");
});

test("retained pre-contract source remains distinguishable from an absent installation", t => {
  const f = fixture(t);
  writeFileSync(f.contract, 'export const unrelated = true;\n');
  f.git(f.source, "commit", "--quiet", "-am", "Release without thread contract");
  const result = f.inspect(f.git(f.source, "rev-parse", "HEAD"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).contract, false);
  const absent = f.inspect(null);
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(JSON.parse(absent.stdout), { census: { selectedCommit: null }, contract: null });
});
