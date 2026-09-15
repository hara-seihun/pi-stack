import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
      env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_RELEASE_REPOSITORY: source,
        GIT_SSH_COMMAND: ssh, SSH_LOG: join(root, "ssh.log") },
    });
  }
  return { root, source, checkout, commit, contract, git, inspect };
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
