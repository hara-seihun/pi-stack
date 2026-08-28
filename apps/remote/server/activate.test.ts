import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

describe("Pi Remote activation", () => {
  it("requests a live supervisor reload without detached work", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-remote-activate-"));
    temporaryDirectories.push(directory);
    const trace = join(directory, "trace");
    executable(join(directory, "systemctl"), `
      printf 'systemctl %s\\n' "$*" >> "$TRACE"
      if [ "$1" = is-active ] && [ "$3" = 'pi-remote@kenan.service' ]; then exit 0; fi
      if [ "$1" = reload ]; then exit 0; fi
      exit 1
    `);
    executable(join(directory, "sudo"), `[ "$1" = -n ] && shift\nexec "$@"`);

    const script = join(import.meta.dir, "..", "activate");
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TRACE: trace,
      USER: "kenan",
    };
    const help = Bun.spawnSync([script, "--help"], { env: environment });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("usage: activate");
    expect(existsSync(trace)).toBe(false);

    const queued = Bun.spawnSync([script], { env: environment });
    expect(queued.exitCode).toBe(0);
    const activation = readFileSync(trace, "utf8");
    expect(activation).toContain("systemctl reload --no-block pi-remote@kenan.service");
    expect(activation).not.toContain("systemd-run");
    expect(activation).not.toContain("curl");
    expect(queued.stdout.toString()).toContain("requested live activation");
  });

  it("keeps the service launcher alive while replacing its supervisor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-remote-supervise-"));
    temporaryDirectories.push(directory);
    const starts = join(directory, "starts");
    const child = join(directory, "child");
    executable(child, `
      printf 'start %s\\n' "$$" >> "$STARTS"
      trap 'exit 75' USR2
      trap 'exit 0' TERM INT
      while :; do sleep 0.05; done
    `);
    const launcher = Bun.spawn([join(import.meta.dir, "pi-remote-supervise"), child], {
      env: { ...process.env, STARTS: starts },
      stdout: "pipe",
      stderr: "pipe",
    });
    const waitForStarts = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const lines = existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").filter(Boolean) : [];
        if (lines.length >= count) return lines;
        await Bun.sleep(20);
      }
      throw new Error(`launcher did not reach ${count} supervisor starts`);
    };
    await waitForStarts(1);
    launcher.kill("SIGHUP");
    const generations = await waitForStarts(2);
    expect(new Set(generations).size).toBe(2);
    expect(() => process.kill(launcher.pid, 0)).not.toThrow();
    launcher.kill("SIGTERM");
    expect(await launcher.exited).toBe(0);
  });
});
