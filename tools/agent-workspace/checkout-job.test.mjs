import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const entry = new URL("./workspace.mjs", import.meta.url).pathname;
const realGit = execFileSync("which", ["git"], { encoding: "utf8", timeout: 2000 }).trim();
const manager = spawnSync("systemctl", ["--user", "show", "basic.target", "--property=ActiveState", "--value"],
  { encoding: "utf8", timeout: 2000 });
const options = { skip: manager.status !== 0 || manager.stdout.trim() !== "active", timeout: 25_000 };
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do {
    const value = read();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${description}`);
}

function jsonFile(filename) {
  return existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) : undefined;
}

function fixture(mode = "hold") {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-checkout-job-"));
  const source = path.join(root, "source");
  const workspaces = path.join(root, "workspaces");
  const state = path.join(root, "state", "registry.sqlite3");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "checkout-held");
  const release = path.join(root, "release");
  const modeFile = path.join(root, "mode");
  mkdirSync(source);
  mkdirSync(bin);
  const git = (directory, ...args) => execFileSync(realGit, ["-C", directory, ...args],
    { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Workspace regression");
  git(source, "config", "user.email", "workspace@example.invalid");
  for (const [file, content] of [["README.md", "root documentation\n"], ["docs/guide.md", "nested documentation\n"],
    ["requirements.txt", "small dependency list\n"], ["src/main.txt", "excluded source\n"],
    ["fixtures/archive.dat", "excluded archive\n"]]) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), content);
  }
  git(source, "add", ".");
  git(source, "commit", "-m", "tiny checkout fixture");
  const commit = git(source, "rev-parse", "HEAD");
  writeFileSync(modeFile, mode);
  // Only the private staging checkout is slowed. Source preparation and every other Git read stay real.
  writeFileSync(path.join(bin, "git"), `#!/bin/bash
staging=''
checkout=no
for argument in "$@"; do
  case "$argument" in
    ${shellQuote(workspaces)}/*.creating-*) staging="$argument" ;;
    checkout) checkout=yes ;;
  esac
done
if [ "$checkout" != yes ] || [ -z "$staging" ]; then exec ${shellQuote(realGit)} "$@"; fi
${shellQuote(realGit)} "$@" || exit $?
printf '%s\\n%s\\n%s\\n' "$$" "$PPID" "$staging" > ${shellQuote(marker)}
mode=$(<${shellQuote(modeFile)})
if [ "$mode" = interrupt ]; then kill -KILL "$PPID"; exit 137; fi
if [ "$mode" = hold ]; then
  while [ ! -e ${shellQuote(release)} ]; do sleep 0.025; done
fi
`, { mode: 0o700 });
  const env = { ...process.env, PI_WORKSPACE_STATE: state, PI_WORKSPACE_TEST_EXTERNAL_SAFETY: "empty",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: `${bin}:${process.env.PATH}` };
  delete env.PI_WORKSPACE_CREATE_CHILD;
  delete env.PI_WORKSPACE_CHECKOUT_JOB;
  delete env.PI_WORKSPACE_SOURCE_JOB_DIR;
  const args = (budget = 20, extra = []) => ["create", "--root", workspaces, "--name", "checkout", "--repo", source,
    "--owner", "isolated-checkout-test", "--min-free-gib", "0", "--creation-timeout-seconds", String(budget), ...extra, "--json"];
  const cli = argv => {
    const result = spawnSync(process.execPath, [entry, ...argv], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return { ...result, receipt: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
  };
  const status = () => cli(["status", "--json"]).receipt.records;
  const attempts = () => {
    const found = [];
    const visit = directory => {
      if (!existsSync(directory)) return;
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) visit(filename);
        else if (item.name === "attempt.json") found.push({ directory, ...jsonFile(filename) });
      }
    };
    visit(path.dirname(state));
    return found;
  };
  return { root, source, workspaces, destination: path.join(workspaces, "checkout"), state, marker, release,
    git, commit, env, args, cli, status, attempts,
    mode: value => writeFileSync(modeFile, value),
    async start(budget = 20, extra = []) {
      const deadline = Date.now() + 10_000;
      do {
        const result = cli(args(budget, extra));
        assert.equal(result.status, 75, `${result.stdout}\n${result.stderr}`);
        assert.equal(result.receipt.ok, true);
        if (result.receipt.state === "creating") {
          assert.equal(result.receipt.path, path.join(workspaces, "checkout"));
          assert.ok(path.isAbsolute(result.receipt.progressPath));
          return result.receipt;
        }
        assert.equal(result.receipt.state, "preparing");
        await delay(25);
      } while (Date.now() < deadline);
      assert.fail("source preparation never admitted checkout");
    },
    async held() {
      const content = await until(() => existsSync(marker) && readFileSync(marker, "utf8"), "private staging checkout");
      const [pid, parent, staging] = content.trim().split("\n");
      assert.ok(staging.startsWith(`${workspaces}/.checkout.creating-`));
      return { pid: Number(pid), parent: Number(parent), staging };
    },
    async terminal(receipt) {
      return until(() => jsonFile(path.join(path.dirname(receipt.progressPath), "result.json")), "checkout terminal result");
    },
    close() {
      for (const attempt of attempts()) {
        const stopped = spawnSync("systemctl", ["--user", "stop", attempt.unit], { encoding: "utf8", timeout: 3000 });
        assert.equal(stopped.error, undefined, stopped.error?.message);
        assert.ok([0, 5].includes(stopped.status), stopped.stderr);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertPublished(f, reserved) {
  const observed = f.cli(f.args());
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(observed.receipt.state, "active");
  assert.equal(observed.receipt.id, reserved.id);
  assert.equal(observed.receipt.sourceCommit, f.commit);
  assert.equal(f.git(f.destination, "rev-parse", "HEAD"), f.commit);
  assert.equal(f.git(f.destination, "status", "--porcelain"), "");
  assert.equal(readFileSync(path.join(f.destination, "README.md"), "utf8"), "root documentation\n");
  assert.deepEqual(readdirSync(f.workspaces), ["checkout"]);
}

async function retry(f, reserved) {
  f.mode("normal");
  const repeated = await f.start();
  assert.equal(repeated.id, reserved.id);
  assert.equal((await f.terminal(repeated)).state, "ready");
  assertPublished(f, reserved);
}

test("checkout budget expiry cleans private staging, never publishes a partial destination, and retries the reservation", options, async () => {
  const f = fixture();
  try {
    const reserved = await f.start(4);
    const held = await f.held();
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(path.join(held.staging, "README.md")), true);
    assert.equal(statSync(held.staging).mode & 0o077, 0);
    assert.equal(f.status()[0].state, "creating");
    const failed = await f.terminal(reserved);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "checkout-materialization-failed");
    assert.match(failed.error.message, /budget|timed out/);
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(held.staging), false);
    assert.equal(f.status()[0].id, reserved.id);
    await retry(f, reserved);
  } finally { f.close(); }
});

test("workspace child SIGKILL cleans staging and exact retry starts a fresh materialization", options, async () => {
  const f = fixture("interrupt");
  try {
    const reserved = await f.start();
    const held = await f.held();
    const failed = await f.terminal(reserved);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "checkout-materialization-failed");
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(held.staging), false);
    const observed = f.cli(f.args());
    assert.notEqual(observed.status, 0);
    assert.match(observed.stderr, /checkout failed/);
    await retry(f, reserved);
  } finally { f.close(); }
});

for (const scope of ["main", "all"]) test(`systemd ${scope}-process SIGKILL automatically resumes clean staging and preserves the reservation`, options, async () => {
  const f = fixture();
  try {
    const reserved = await f.start();
    const held = await f.held();
    const jobDirectory = path.dirname(reserved.progressPath);
    const before = jsonFile(path.join(jobDirectory, "attempt.json"));
    f.mode("normal");
    const killed = spawnSync("systemctl", ["--user", "kill", `--kill-whom=${scope}`, "--signal=SIGKILL", before.unit],
      { encoding: "utf8", timeout: 3000 });
    assert.equal(killed.status, 0, killed.stderr);
    const terminal = await f.terminal(reserved);
    await until(() => !existsSync(`/proc/${held.pid}`), "Git wrapper cgroup retirement");
    assert.equal(existsSync(held.staging), false);
    assert.equal(jsonFile(path.join(jobDirectory, "attempt.json")).number, before.number);
    if (terminal.state === "failed") {
      assert.equal(scope, "main");
      assert.equal(existsSync(f.destination), false);
      assert.match(f.cli(f.args()).stderr, /checkout failed/);
      await retry(f, reserved);
    } else {
      assert.equal(terminal.state, "ready");
      assertPublished(f, reserved);
    }
  } finally { f.close(); }
});

test("foreground process-group death cannot kill its real durable systemd checkout", options, async () => {
  const f = fixture();
  let foreground;
  try {
    foreground = spawn(process.execPath, ["--input-type=module", "-e", `
      import {spawnSync} from 'node:child_process';
      const end=Date.now()+15000;
      while(Date.now()<end) {
        const result=spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify([entry, ...f.args()])},
          {env:process.env,encoding:'utf8',timeout:10000});
        if(result.status!==75) {process.stderr.write(result.stderr);process.exit(2);}
        const receipt=JSON.parse(result.stdout);
        if(receipt.state==='creating') {process.stdout.write(JSON.stringify(receipt)+'\\n');break;}
        if(receipt.state!=='preparing') process.exit(3);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      }
      setTimeout(()=>process.exit(4),20000);
    `], { env: f.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    foreground.stdout.on("data", bytes => { stdout += bytes; });
    foreground.stderr.on("data", bytes => { stderr += bytes; });
    const exited = new Promise(resolve => foreground.once("close", (code, signal) => resolve({ code, signal })));
    const reserved = await until(() => stdout.includes("\n") && JSON.parse(stdout.trim()), `foreground admission (${stderr})`);
    const held = await f.held();
    assert.equal(existsSync(f.destination), false);
    const unit = jsonFile(path.join(path.dirname(reserved.progressPath), "attempt.json")).unit;
    const cgroup = execFileSync("systemctl", ["--user", "show", unit, "--property=ControlGroup", "--value"],
      { encoding: "utf8", timeout: 2000 }).trim();
    assert.ok(cgroup.length > 0);
    assert.ok(readFileSync(`/proc/${held.pid}/cgroup`, "utf8").includes(cgroup));
    process.kill(-foreground.pid, "SIGKILL");
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
    assert.equal(existsSync(`/proc/${held.pid}`), true);
    assert.equal(existsSync(held.staging), true);
    writeFileSync(f.release, "publish");
    assert.equal((await f.terminal(reserved)).state, "ready");
    assertPublished(f, reserved);
  } finally {
    if (foreground && foreground.exitCode === null && foreground.signalCode === null) process.kill(-foreground.pid, "SIGKILL");
    f.close();
  }
});

for (const mode of ["writer", "review"]) test(`atomic sparse ${mode} checkout preserves Git selection and branch mode`, options, async () => {
  const f = fixture();
  const extra = ["--mode", mode, "--sparse-pattern", "*.md", "--sparse-pattern", "requirements.txt"];
  try {
    const reserved = await f.start(20, extra);
    const held = await f.held();
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(path.join(held.staging, "README.md")), true);
    assert.equal(existsSync(path.join(held.staging, "docs", "guide.md")), true);
    assert.equal(existsSync(path.join(held.staging, "requirements.txt")), true);
    assert.equal(existsSync(path.join(held.staging, "fixtures", "archive.dat")), false);
    assert.equal(existsSync(path.join(held.staging, "src", "main.txt")), false);
    writeFileSync(f.release, "publish");
    assert.equal((await f.terminal(reserved)).state, "ready");
    const observed = f.cli(f.args(20, extra));
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(observed.receipt.state, "active");
    assert.equal(observed.receipt.id, reserved.id);
    assert.equal(f.git(f.destination, "rev-parse", "HEAD"), f.commit);
    assert.equal(f.git(f.destination, "branch", "--show-current"), mode === "writer" ? "agent/checkout" : "");
    assert.equal(f.git(f.destination, "status", "--porcelain"), "");
    assert.equal(readFileSync(path.join(f.destination, ".git", "info", "sparse-checkout"), "utf8"), "*.md\nrequirements.txt\n");
    assert.equal(f.git(f.destination, "config", "--get", "core.sparseCheckoutCone"), "false");
    assert.deepEqual(f.git(f.destination, "ls-files", "-t").split("\n").filter(line => line.startsWith("S ")),
      ["S fixtures/archive.dat", "S src/main.txt"]);
    assert.deepEqual(readdirSync(f.workspaces), ["checkout"]);
  } finally { f.close(); }
});
