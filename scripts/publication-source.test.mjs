import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    android: { directory: "/retained/android", release: { revision: integrationSha } }, failures: [] };
  function publish(requeue = false, environment = {}) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { publishIntegration, requeueMovedIntegration } from ${JSON.stringify(publication)};
      const request = ${JSON.stringify(request)};
      const log = ${JSON.stringify(join(f.root, "integration.log"))};
      const result = publishIntegration(request, log);
      if (${requeue} && result.kind === "main-moved") requeueMovedIntegration(request, result.remoteMain, log);
      console.log(JSON.stringify({ result, request }));
    `], { encoding: "utf8", timeout: 5000, env: { ...process.env, PI_STACK_PUBLICATION_STATE: f.root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(f.root, f.source), ...environment } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { ...f, remote, contender, integrationSha, request, publish };
}

for (const timing of ["before-refresh", "during-push"]) test(`main movement ${timing} retains proof and queues rechecking without overwriting either writer`, t => {
  const f = integrationFixture(t);
  if (timing === "before-refresh") f.git(f.remote, "update-ref", "refs/heads/main", f.contender);
  else writeFileSync(join(f.checkout, ".git/hooks/pre-push"), `#!/bin/sh\ngit -C '${f.remote}' update-ref refs/heads/main ${f.contender}\n`, { mode: 0o700 });
  assert.equal(f.git(f.checkout, "rev-parse", "origin/main"), f.commit);
  const { result, request } = f.publish(true);
  assert.deepEqual(result, { ok: false, kind: "main-moved", remoteMain: f.contender });
  assert.equal(request.status, "queued");
  assert.equal(request.step, "main-moved-recheck-required");
  for (const key of ["checks", "integrationSha", "baseSha", "android", "hosts", "integratedAt"]) assert.equal(request[key], undefined);
  assert.equal(request.sourceSha, f.integrationSha);
  assert.equal(request.sourceRef, f.request.sourceRef);
  assert.equal(request.attempt, 1);
  assert.deepEqual(request.failures, []);
  const [retained] = request.mainMovements;
  assert.equal(retained.integrationSha, f.integrationSha);
  assert.deepEqual(retained.checks, f.request.checks);
  assert.deepEqual(retained.android, f.request.android);
  assert.equal(f.git(f.checkout, "rev-parse", retained.ref), f.integrationSha);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.contender);
  assert.equal(f.git(f.checkout, "show", `${retained.ref}:submission`), "submitted work");
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "requests", `${request.requestId}.json`), "utf8")), request);
});

test("requeue restores both hosts and retains their restoration plans", t => {
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
  const { request } = f.publish(true, { PATH: `${bin}:${process.env.PATH}`, RESTORE_LOG: join(f.root, "restore.log") });
  assert.equal(request.status, "queued");
  for (const kind of ["bootstrap", "maintenance"]) for (const host of ["gmktec", "converge"]) {
    assert.equal(request[kind].hosts[host].state, "restored");
    assert.deepEqual(request[kind].hosts[host].plan, f.request[kind].hosts[host].plan);
    assert.deepEqual(request.mainMovements[0][kind], request[kind]);
  }
  assert.ok(readFileSync(join(f.root, "restore.log"), "utf8").length > 0);
});

for (const alreadyIntegrated of [false, true]) test(`confirmed exact integration is recorded, already integrated=${alreadyIntegrated}`, t => {
  const f = integrationFixture(t);
  if (alreadyIntegrated) {
    f.git(f.source, "push", "--quiet", "origin", `${f.integrationSha}:refs/heads/main`);
    writeFileSync(join(f.checkout, ".git/hooks/pre-push"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  }
  const { result, request } = f.publish();
  assert.equal(result.ok, true);
  assert.equal(request.step, "integrated");
  assert.ok(request.integratedAt);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.integrationSha);
});

test("main advancing after an accepted push still requires checks of the new tip", t => {
  const f = integrationFixture(t);
  f.git(f.source, "checkout", "--quiet", "--detach", f.integrationSha);
  writeFileSync(join(f.source, "next"), "later integration\n");
  f.git(f.source, "add", ".");
  f.git(f.source, "commit", "--quiet", "-m", "Next main");
  const next = f.git(f.source, "rev-parse", "HEAD");
  f.git(f.source, "push", "--quiet", "origin", "HEAD:refs/heads/next");
  writeFileSync(join(f.remote, "hooks/post-receive"), `#!/bin/sh\ngit update-ref refs/heads/main ${next}\n`, { mode: 0o700 });
  const { result, request } = f.publish(true);
  assert.equal(result.kind, "main-moved");
  assert.equal(result.remoteMain, next);
  assert.equal(request.status, "queued");
  assert.equal(request.checks, undefined);
  assert.equal(f.git(f.remote, "rev-parse", "main"), next);
});

test("unavailable main fails before a push or requeue", t => {
  const f = integrationFixture(t);
  f.git(f.checkout, "remote", "set-url", "origin", join(f.root, "absent.git"));
  const { result, request } = f.publish(true);
  assert.equal(result.ok, false);
  assert.equal(result.kind, undefined);
  assert.equal(request.step, "refresh-integration-base");
  assert.equal(request.mainMovements, undefined);
  assert.equal(request.integrationSha, f.integrationSha);
  assert.equal(f.git(f.remote, "rev-parse", "main"), f.commit);
});

test("a rejected push with unchanged main remains a failure, not a rebuild", t => {
  const f = integrationFixture(t);
  writeFileSync(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\necho 'repository policy rejects push' >&2\nexit 1\n", { mode: 0o700 });
  const { result, request } = f.publish(true);
  assert.equal(result.ok, false);
  assert.equal(result.kind, undefined);
  assert.equal(request.step, "integrate-main");
  assert.equal(request.mainMovements, undefined);
  assert.equal(request.integrationSha, f.integrationSha);
  assert.match(readFileSync(join(f.root, "integration.log"), "utf8"), /repository policy rejects push/);
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
