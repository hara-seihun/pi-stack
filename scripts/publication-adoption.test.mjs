import assert from "node:assert/strict";
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
