import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { processGroupCleanupCommand } from "./remote-process";

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

test("remote cleanup terminates the recorded process group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-process-"));
  const pidFile = join(directory, "command.pid");
  const child = spawn("bash", ["-c", "exec sleep 60"], { detached: true, stdio: "ignore" });
  if (!child.pid) throw new Error("test process did not start");
  const pid = child.pid;
  const closed = waitForClose(child);

  try {
    writeFileSync(pidFile, String(pid));
    const command = processGroupCleanupCommand(pidFile);
    expect(command).toContain('kill -TERM -- -"$p"');
    expect(command).toContain('kill -KILL -- -"$p"');

    const cleanup = spawn("bash", ["-c", command], { stdio: "ignore" });
    expect(await waitForClose(cleanup)).toBe(0);
    expect(await Promise.race([
      closed,
      Bun.sleep(1_000).then(() => { throw new Error("process group survived cleanup"); }),
    ])).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});
