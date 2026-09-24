import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");

test("skill deployment replaces stale managed entries and removes unlisted skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-stack-skills-"));
  const home = join(workspace, "home");
  const agentDir = join(home, ".pi", "agent");
  const stale = join(agentDir, "skills", "software-engineering");
  const removed = join(agentDir, "skills", "unslop");
  const destination = join(workspace, "release");
  const hostSkill = join(workspace, "host-skills", "math-research");
  mkdirSync(stale, { recursive: true });
  symlinkSync(join(destination, "unslop"), removed);
  mkdirSync(hostSkill, { recursive: true });
  writeFileSync(join(stale, "stale.txt"), "not the reviewed skill\n");
  writeFileSync(join(hostSkill, "SKILL.md"), "# host skill\n");
  writeFileSync(join(workspace, "host.json"), JSON.stringify({ version: 1, skills: [hostSkill] }));
  mkdirSync(home, { recursive: true });

  try {
    execFileSync(join(root, "deploy", "skills"), [], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PI_STACK_ALLOW_DIRTY: "1",
        PI_STACK_DEPLOY_NO_SUDO: "1",
        PI_STACK_HOST_LOCK_PATH: join(workspace, "host.lock"),
        PI_STACK_SKILLS_DEST: destination,
        PI_STACK_HOST_FILE: join(workspace, "host.json"),
        PI_STACK_HOME_OVERRIDE: home,
      },
      stdio: "pipe",
    });

    assert.equal(lstatSync(stale).isSymbolicLink(), true);
    assert.equal(readlinkSync(stale), join(destination, "software-engineering"));
    assert.throws(() => lstatSync(removed), { code: "ENOENT" });
    assert.equal(readlinkSync(join(agentDir, "skills", "charisma")), join(destination, "charisma"));
    assert.equal(readlinkSync(join(agentDir, "skills", "math-research")), hostSkill);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
