import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "publication-adoption-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "candidate");
  const installed = join(root, "owner", "publish");
  const units = join(root, "units");
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    PI_STACK_PUBLICATION_CONFIG: publicationConfig(root), PI_STACK_PUBLICATION_COMMAND: installed,
    PI_STACK_PUBLICATION_STATE: state, PI_STACK_PUBLICATION_UNIT_ROOT: units,
    PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox"), SYSTEMCTL_LOG: join(root, "systemctl.log") };
  const run = (command, args) => spawnSync(command, args, { env, encoding: "utf8", timeout: 5000 });
  const checked = (command, args) => {
    const result = run(command, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  cpSync(new URL("../deploy", import.meta.url), join(source, "deploy"), { recursive: true });
  const candidate = join(source, "deploy/publication");
  checked('git', ['-C', source, 'init', '-q']);
  checked('git', ['-C', source, 'add', '.']);
  const commit = message => checked('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', message]);
  commit('Initial immutable owner source');
  checked(process.execPath, [candidate, 'install']);
  writeFileSync(candidate, readFileSync(candidate, "utf8").replace('"release-checkout", "meeting-census"', '"release-checkout", "room-census"'));
  renameSync(join(source, "deploy/meeting-census"), join(source, "deploy/room-census"));
  checked('git', ['-C', source, 'add', '.']);
  commit('Candidate changes installation layout');
  const sha = checked("git", ["-C", source, "rev-parse", "HEAD"]);
  const adopt = (expected = sha) => run("flock", ["--nonblock", join(state, "worker.lock"), process.execPath, "--input-type=module", "-e",
    `import { adoptPublicationOwner } from ${JSON.stringify(pathToFileURL(installed).href)};
     adoptPublicationOwner(${JSON.stringify(source)}, ${JSON.stringify(expected)});`]);
  return { root, source, candidate, installed, units, state, env, adopt, checked, run, sha };
}

test("an installed owner adopts the checked candidate's changed dependency layout under its worker lock", t => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.source, "deploy/meeting-census")), false);
  const result = f.adopt();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.installed, "utf8"), readFileSync(f.candidate, "utf8"));
  assert.equal(readFileSync(join(f.root, "owner/room-census"), "utf8"), readFileSync(join(f.source, "deploy/room-census"), "utf8"));
  assert.match(readFileSync(join(f.units, "pi-stack-publication.service"), "utf8"), new RegExp(`ExecStart=${f.installed} drain`));
  assert.equal(readFileSync(f.env.SYSTEMCTL_LOG, "utf8").split("daemon-reload").length - 1, 2);
});

test("code-only repairs retain source and cannot be overwritten by unrelated owner adoption", t => {
  const f = fixture(t);
  const repository = join(f.state, "repository");
  f.checked("git", ["init", "--quiet", repository]);
  writeFileSync(join(f.source, "deploy/repair-proof"), "cancellation is terminal\n");
  f.checked("git", ["-C", f.source, "add", "."]);
  f.checked("git", ["-C", f.source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "Bootstrap owner repair"]);
  const repairSha = f.checked("git", ["-C", f.source, "rev-parse", "HEAD"]);
  const services = readFileSync(f.env.SYSTEMCTL_LOG, "utf8");
  f.checked(process.execPath, [f.candidate, "install", "--code-only"]);
  const ownerRef = "refs/pi-stack-publication/owner-source";
  assert.equal(f.checked("git", ["-C", repository, "rev-parse", ownerRef]), repairSha);
  assert.equal(readFileSync(f.env.SYSTEMCTL_LOG, "utf8"), services);
  const owner = readFileSync(f.installed, "utf8");
  f.checked("git", ["-C", f.source, "checkout", "--quiet", "--detach", f.sha]);
  // Even a candidate installer without the new guard must never execute.
  writeFileSync(f.candidate, 'throw new Error("unguarded candidate executed");\n');
  const rejected = f.adopt();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /omits bootstrapped owner source/);
  assert.doesNotMatch(rejected.stderr, /unguarded candidate executed/);
  assert.equal(readFileSync(f.installed, "utf8"), owner);
  assert.equal(readFileSync(f.env.SYSTEMCTL_LOG, "utf8"), services);
  f.checked("git", ["-C", f.source, "restore", "deploy/publication"]);
  const direct = f.run(process.execPath, [f.candidate, "install"]);
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /omits bootstrapped owner source/);
  f.checked("git", ["-C", f.source, "checkout", "--quiet", "--detach", repairSha]);
  const adopted = f.adopt(repairSha);
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(f.checked("git", ["-C", repository, "rev-parse", ownerRef]), repairSha);
  writeFileSync(join(f.source, "deploy/repair-proof"), "uncommitted repair\n");
  const dirty = f.run(process.execPath, [f.candidate, "install", "--code-only"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /Commit deployment source/);
  assert.equal(f.checked("git", ["-C", repository, "rev-parse", ownerRef]), repairSha);
  assert.equal(readFileSync(f.installed, "utf8"), owner);
});

for (const retainedState of ['pinned', 'checked', 'selection-failed', 'ambient-checkout']) test(`resumed ${retainedState} publication reselects its own integration after another request moved the checkout`, t => {
  const f = fixture(t);
  const adopted = f.adopt();
  assert.equal(adopted.status, 0, adopted.stderr);
  const repository = join(f.state, 'repository');
  writeFileSync(join(f.source, 'deploy/concurrent-request'), 'another request selected this source\n');
  f.checked('git', ['-C', f.source, 'add', '.']);
  f.checked('git', ['-C', f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Concurrent request']);
  const movedSha = f.checked('git', ['-C', f.source, 'rev-parse', 'HEAD']);
  f.checked('git', ['-C', repository, 'fetch', '--quiet', f.source, movedSha]);
  f.checked('git', ['-C', repository, 'checkout', '--quiet', '--detach', movedSha]);
  f.checked('git', ['-C', f.source, 'checkout', '--quiet', '--detach', f.sha]);
  const foreign = join(f.root, 'foreign-immutable');
  if (retainedState === 'ambient-checkout') {
    f.checked('git', ['clone', '--quiet', '--no-hardlinks', f.source, foreign]);
    f.checked('git', ['-C', foreign, 'checkout', '--quiet', '--detach', movedSha]);
    f.checked('git', ['-C', foreign, 'remote', 'set-url', 'origin', 'https://github.com/hara-seihun/pi-stack.git']);
    writeFileSync(join(foreign, 'preserved-untracked'), 'immutable source evidence\n');
    f.env.PI_STACK_PUBLICATION_CHECKOUT = foreign;
  }
  const proof = join(f.root, 'delivered.json');
  writeFileSync(proof, '{}\n');
  const host = { status: 'passed', integrationSha: f.sha, proof,
    sha256: createHash('sha256').update(readFileSync(proof)).digest('hex') };
  const requestId = 'PUB-0123456789abcdef01234567';
  const request = { version: 3, requestId, sourceSha: f.sha,
    sourceRef: `refs/heads/pi-stack-publications/${requestId}`, integrationSha: f.sha, baseSha: f.sha,
    status: 'queued', step: 'waiting-for-hosts', waiting: { kind: 'hosts' }, attempt: 1,
    integratedAt: new Date().toISOString(), failures: [],
    checks: retainedState === 'checked' ? { status: 'passed' } : { status: 'deferred', phase: 'post-serving' },
    ...(retainedState === 'checked' ? {} : { sourceSelection: { status: 'pinned', sourceSha: f.sha } }),
    hosts: { gmktec: host, converge: host },
    reservations: { gmktec: { state: 'released' }, converge: { state: 'released' } } };
  writeFileSync(join(f.state, 'requests', `${requestId}.json`), JSON.stringify(request));
  writeFileSync(join(f.root, 'bin/git'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(f.root, 'git.log'))}, args.join(' ') + '\\n');
if (args.includes('+refs/heads/main:refs/remotes/origin/main')) process.exit(0);
if (args.includes('cat-file') && args.at(-1).endsWith(':deploy/android-update')) process.exit(1);
if (${retainedState === 'selection-failed'} && args.includes('checkout') && args.at(-1) === ${JSON.stringify(f.sha)}) {
  process.stderr.write('retained integration selection refused\\n'); process.exit(42);
}
const result = spawnSync('/usr/bin/git', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { processRequest } from ${JSON.stringify(pathToFileURL(f.installed).href)};
     processRequest(${JSON.stringify(request)});`], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const resumed = JSON.parse(readFileSync(join(f.state, 'requests', `${requestId}.json`), 'utf8'));
  assert.equal(resumed.status, retainedState === 'selection-failed' ? 'failed' : 'published', JSON.stringify(resumed.failure));
  assert.equal(resumed.integrationSha, f.sha);
  assert.deepEqual(resumed.checks, request.checks);
  assert.deepEqual(resumed.hosts, request.hosts);
  assert.equal(resumed.attempt, request.attempt);
  assert.equal(readFileSync(proof, 'utf8'), '{}\n');
  const commands = readFileSync(join(f.root, 'git.log'), 'utf8');
  if (retainedState === 'ambient-checkout') {
    assert.equal(f.checked('git', ['-C', foreign, 'rev-parse', 'HEAD']), movedSha);
    assert.equal(readFileSync(join(foreign, 'preserved-untracked'), 'utf8'), 'immutable source evidence\n');
    assert.equal(commands.includes(foreign), false, 'coordinator operations cannot target inherited host source');
  }
  assert.doesNotMatch(commands, /fetch-submitted|push|reset --hard [a-f0-9]{40}/);
  if (retainedState === 'selection-failed') {
    assert.equal(resumed.failure.step, 'select-retained-integration');
    assert.equal(resumed.failure.message, 'retained integration selection exited 42');
    assert.match(resumed.failure.excerpt, /retained integration selection refused/);
    assert.equal(resumed.failure.progress.command, 'git');
    assert.doesNotMatch(commands, /worktree add/);
  } else {
    assert.equal(f.checked('git', ['-C', repository, 'rev-parse', 'HEAD']), f.sha);
    assert.match(commands, new RegExp(`checkout --quiet --detach ${f.sha}`));
    assert.equal(readFileSync(f.installed, 'utf8'), readFileSync(f.candidate, 'utf8'));
  }
});

test("adoption rejects the wrong source identity and missing candidate dependencies without replacing the owner", t => {
  const f = fixture(t);
  const before = readFileSync(f.installed, "utf8");
  const services = readFileSync(f.env.SYSTEMCTL_LOG, "utf8");
  const wrongSource = f.adopt("0".repeat(40));
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stderr, /differs from checked integration/);
  assert.equal(readFileSync(f.installed, "utf8"), before);
  rmSync(join(f.source, "deploy/room-census"));
  const incomplete = f.adopt();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /publication installation source is missing: .*room-census/);
  assert.equal(readFileSync(f.installed, "utf8"), before);
  assert.equal(readFileSync(f.env.SYSTEMCTL_LOG, "utf8"), services);
});
