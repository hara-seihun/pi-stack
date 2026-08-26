import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("idle-safe Pi Remote activation", () => {
  it("carries the caller's service identity into the root waiter", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-remote-restart-"));
    temporaryDirectories.push(directory);
    const trace = join(directory, "trace");
    executable(join(directory, "systemctl"), `
      printf 'systemctl %s\\n' "$*" >> "$TRACE"
      if [ "$1" = is-active ] && [ "$3" = 'pi-remote@kenan.service' ]; then exit 0; fi
      if [ "$1" = restart ] || [ "$1" = reload ] || [ "$1" = stop ]; then exit 0; fi
      exit 1
    `);
    executable(join(directory, "sudo"), `[ "$1" = -n ] && shift\nexec "$@"`);
    executable(join(directory, "systemd-run"), `printf 'systemd-run %s\\n' "$*" >> "$TRACE"`);
    executable(join(directory, "curl"), `printf '{"sessions":[]}'`);

    const script = join(import.meta.dir, "..", "restart-when-idle");
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TRACE: trace,
      USER: "kenan",
    };
    const queued = Bun.spawnSync([script], { env: environment });
    expect(queued.exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toContain(
      "--setenv=PI_REMOTE_SERVICE=pi-remote@kenan.service",
    );

    writeFileSync(trace, "");
    const waited = Bun.spawnSync([script, "--wait-loop"], {
      env: { ...environment, USER: "root", PI_REMOTE_SERVICE: "pi-remote@kenan.service" },
    });
    expect(waited.exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toContain("systemctl restart pi-remote@kenan.service");
  });
});
