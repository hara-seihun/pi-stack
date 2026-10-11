import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { nativeRunnerLock, nativeLockHolders, validateNativeRunnerDirectory } from "../src/threads/runner-ownership.js";

test("native storage identity excludes generation and mount-view coordinates", () => {
  expect(nativeRunnerLock("/home/person/private/../private/.pi-remote", 1000)).toBe(nativeRunnerLock("/home/person/private/.pi-remote", 1000));
  expect(nativeRunnerLock("/home/person/private/.pi-remote", 1000)).not.toBe(nativeRunnerLock("/home/person/private/.pi-remote", 1001));
  expect(() => nativeRunnerLock("relative", 1000)).toThrow();
});

test("physical custody refuses symlink directories and wrong UID", () => {
  const root = mkdtempSync("/dev/shm/pi-native-owner-");
  try {
    const direct = join(root, "owner"), alias = join(root, "alias");
    mkdirSync(direct, { mode: 0o700 }); symlinkSync(direct, alias);
    expect(() => validateNativeRunnerDirectory(join(direct, "x.lock"), process.getuid!())).not.toThrow();
    expect(() => validateNativeRunnerDirectory(join(alias, "x.lock"), process.getuid!())).toThrow();
    expect(() => validateNativeRunnerDirectory(join(direct, "x.lock"), process.getuid!() + 1)).toThrow();
  } finally { rmSync(root, { recursive: true }); }
});

test("one physical lease excludes a second generation through another directory alias", async () => {
  const root = mkdtempSync("/dev/shm/pi-native-owner-");
  const alias = `${root}-alias`; symlinkSync(root, alias);
  const lock = join(root, "storage.lock");
  const child = spawn("/usr/bin/flock", ["--no-fork", "--nonblock", lock, process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    expect(nativeLockHolders(lock)).toContain(child.pid!);
    const second = spawnSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "75", join(alias, "storage.lock"), "/usr/bin/true"]);
    expect(second.status).toBe(75);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect(nativeLockHolders(lock)).toEqual([]);
    expect(spawnSync("/usr/bin/flock", ["--nonblock", join(alias, "storage.lock"), "/usr/bin/true"]).status).toBe(0);
  } finally { child.kill("SIGKILL"); rmSync(alias); rmSync(root, { recursive: true }); }
});
