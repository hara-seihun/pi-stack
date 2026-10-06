import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

const publication = new URL("../deploy/publication", import.meta.url).pathname;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root, name, contents) {
  writeFileSync(join(root, name), contents);
  git(root, "add", name);
  git(root, "commit", "--quiet", "-m", name);
  return git(root, "rev-parse", "HEAD");
}

test("submit rejects foreign roots before push, even behind a merge; a public descendant transfers custody", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-roots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "public.git"), source = join(root, "source"), privateRepo = join(root, "private");
  mkdirSync(source);
  mkdirSync(privateRepo);
  git(root, "init", "--quiet", "--bare", remote);
  git(source, "init", "--quiet", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  const publicRoot = commit(source, "public.txt", "published root\n");
  git(source, "remote", "add", "origin", "https://github.com/hara-seihun/pi-stack.git");
  git(source, "config", `url.${remote}.insteadOf`, "https://github.com/hara-seihun/pi-stack.git");
  git(source, "push", "--quiet", "origin", "main");
  git(privateRepo, "init", "--quiet");
  git(privateRepo, "config", "user.name", "Fixture");
  git(privateRepo, "config", "user.email", "fixture@example.test");
  const privateRoot = commit(privateRepo, "private.txt", "private history\n");
  git(source, "fetch", "--quiet", privateRepo, privateRoot);
  const owner = join(root, "installed-owner");
  writeFileSync(owner, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OWNER_LOG"\necho "{\\"status\\":\\"queued\\"}"\n', { mode: 0o700 });
  const configPath = publicationConfig(root, source);
  const environment = {
    ...process.env,
    PI_STACK_PUBLICATION_CONFIG: configPath,
    PI_STACK_PUBLICATION_COMMAND: owner,
    PI_STACK_PUBLICATION_STATE: join(root, "state"),
    OWNER_LOG: join(root, "owner.log"),
    PI_STACK_PUBLICATION_REPORT_URL: "",
    PI_STACK_PUBLICATION_REPORT_SESSION: "",
    PI_REMOTE_SERVER_URL: "",
    PI_REMOTE_SESSION_ID: "",
    PI_SESSION_FILE: "",
  };
  const submit = sha => spawnSync(process.execPath, [publication, "submit", sha], {
    cwd: source, encoding: "utf8", timeout: 5000, env: environment,
  });
  const submitted = () => git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/pi-stack-publications");

  let result = submit(privateRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /introduces Git root\(s\).*replay the changes onto current main/);
  assert.equal(submitted(), "");

  git(source, "checkout", "--quiet", "-b", "mixed", publicRoot);
  git(source, "merge", "--quiet", "--allow-unrelated-histories", "-s", "ours", "--no-ff", "-m", "mixed roots", privateRoot);
  result = submit(git(source, "rev-parse", "HEAD"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(privateRoot));
  assert.equal(submitted(), "");

  git(source, "checkout", "--quiet", "main");
  const descendant = commit(source, "change.txt", "safe public descendant\n");
  result = submit(descendant);
  assert.equal(result.status, 0, result.stderr);
  assert.match(submitted(), /refs\/heads\/pi-stack-publications\/PUB-/);
  assert.match(readFileSync(environment.OWNER_LOG, "utf8"), new RegExp(`enqueue PUB-[a-f0-9]{24} ${descendant}`));
});

test("source without the installed owner's retained ancestry cannot enter the publication queue or push a request ref", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-owner-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), state = join(root, "state"), checkout = join(state, "repository"), remote = join(root, "public.git");
  mkdirSync(source);
  mkdirSync(checkout, { recursive: true });
  git(root, "init", "--quiet", "--bare", remote);
  git(source, "init", "--quiet", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  const base = commit(source, "public.txt", "public root\n");
  git(source, "remote", "add", "origin", "https://github.com/hara-seihun/pi-stack.git");
  git(source, "config", `url.${remote}.insteadOf`, "https://github.com/hara-seihun/pi-stack.git");
  git(source, "push", "--quiet", "origin", "main");
  const ownerSource = commit(source, "owner-repair.txt", "installed publication repair\n");
  git(checkout, "init", "--quiet");
  git(checkout, "fetch", "--quiet", source, `${ownerSource}:refs/pi-stack-publication/owner-source`);
  git(source, "checkout", "--quiet", "-b", "writer", base);
  const candidate = commit(source, "feature.txt", "new feature\n");
  const owner = join(root, "owner");
  writeFileSync(owner, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OWNER_LOG"\necho "{\\"status\\":\\"queued\\"}"\n', { mode: 0o700 });
  const env = { ...process.env, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root, source),
    PI_STACK_PUBLICATION_COMMAND: owner, PI_STACK_PUBLICATION_STATE: state, OWNER_LOG: join(root, "owner.log"),
    PI_STACK_PUBLICATION_REPORT_URL: "", PI_STACK_PUBLICATION_REPORT_SESSION: "", PI_REMOTE_SERVER_URL: "",
    PI_REMOTE_SESSION_ID: "", PI_SESSION_FILE: "" };
  const submit = sha => spawnSync(process.execPath, [publication, "submit", sha], { cwd: source, encoding: "utf8", timeout: 5000, env });
  const rejected = submit(candidate);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /omits bootstrapped owner source/);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/pi-stack-publications"), "");
  assert.equal(git(source, "rev-parse", "HEAD"), candidate);
  git(source, "merge", "--quiet", "--no-ff", "-m", "Include installed owner", ownerSource);
  const integrated = git(source, "rev-parse", "HEAD");
  const accepted = submit(integrated);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(readFileSync(env.OWNER_LOG, "utf8"), new RegExp(`enqueue PUB-[a-f0-9]{24} ${integrated}`));
});
