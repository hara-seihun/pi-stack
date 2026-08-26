import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");

test("skill deployment replaces a stale managed directory with the reviewed release", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-stack-skills-"));
  const home = join(workspace, "home");
  const agentDir = join(home, ".pi", "agent");
  const stale = join(agentDir, "skills", "software-engineering");
  const destination = join(workspace, "release");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "stale.txt"), "not the reviewed skill\n");

  try {
    execFileSync(join(root, "deploy", "skills"), ["converge-user"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PI_AGENT_DIR: agentDir,
        PI_STACK_ALLOW_DIRTY: "1",
        PI_STACK_DEPLOY_NO_SUDO: "1",
        PI_STACK_SKILLS_DEST: destination,
      },
      stdio: "pipe",
    });

    assert.equal(lstatSync(stale).isSymbolicLink(), true);
    assert.equal(readlinkSync(stale), join(destination, "software-engineering"));
    assert.equal(
      readlinkSync(join(agentDir, "skills", "unslop")),
      join(destination, "unslop"),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
