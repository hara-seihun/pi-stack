import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scopedBashOperations } from "../src/threads/pi-bash-resources.js";
import { prepareRunnerSlices } from "../src/threads/runner-resources.js";

const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const alive = (pid: number) => { try { return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z"); } catch { return false; } };
const ctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5000 });

it("keeps unmanaged SDK shells local", () => expect(scopedBashOperations({})).toBeUndefined());
it.skipIf(!manager)("isolates tool OOM and cleans escaped descendants while its controller remains usable", async () => {
  const id = randomBytes(8).toString("hex"), root = mkdtempSync(join(tmpdir(), "pi-tool-scope-"));
  const env = { ...process.env, PI_THREAD_RESOURCE_BOUNDARY: id, SCOPE_TEST_VALUE: "session-only" };
  const slices = await prepareRunnerSlices(id, env, true);
  const runner = `pi-thread-runner-${id}.service`;
  execFileSync("systemd-run", ["--user", "--collect", "--quiet", `--unit=${runner}`, `--slice=${slices.boundary}`,
    "--property=OOMPolicy=continue", process.execPath, "-e", "setInterval(()=>{},1000)"], { env, timeout: 5000 });
  const pid = Number(ctl("show", runner, "--property=MainPID", "--value").trim());
  const ops = scopedBashOperations(env, undefined, "96M")!;
  const execute = async (command: string, timeout = 2, signal?: AbortSignal) => {
    let output = "";
    const result = await ops.exec(command, root, { timeout, signal, env, onData: data => { output += data; } });
    return { ...result, output };
  };
  try {
    const normal = await execute("printf '%s\\n' \"$SCOPE_TEST_VALUE\"; pwd; printf UID:; id -u; cat /proc/self/cgroup; cat /proc/self/oom_score_adj; readlink /proc/self/ns/mnt");
    expect(normal.exitCode, normal.output).toBe(0);
    expect(normal.output).toContain("session-only\n" + root);
    expect(normal.output).toContain(`UID:${process.getuid!()}\n`);
    expect(normal.output).toContain(slices.tools);
    expect(normal.output).not.toContain(runner);
    expect(normal.output).toContain("\n1000\n");
    expect(normal.output).toContain(execFileSync("readlink", ["/proc/self/ns/mnt"], { encoding: "utf8" }).trim());
    for (const kind of ["timeout", "abort", "exit"] as const) {
      const file = join(root, `${kind}.pid`);
      const abort = new AbortController();
      const timer = kind === "abort" ? setTimeout(() => abort.abort(), 400) : undefined;
      try {
        const call = execute(`setsid sleep 300 & echo $! > '${file}'; ${kind === "exit" ? "exit 0" : "sleep 300"}`, 1, abort.signal);
        if (kind === "exit") expect((await call).exitCode).toBe(0);
        else await expect(call).rejects.toThrow(kind === "abort" ? "aborted" : "timeout:1");
      } finally { clearTimeout(timer); }
      expect(existsSync(file)).toBe(true);
      expect(alive(Number(readFileSync(file, "utf8")))).toBe(false);
      expect(alive(pid)).toBe(true);
    }
    const oom = await execute("python3 -c 'x=bytearray(512*1024*1024); print(len(x))'", 5);
    expect(oom.exitCode).not.toBe(0);
    expect(alive(pid)).toBe(true);
    expect(ctl("show", runner, "--property=OOMPolicy", "--value").trim()).toBe("continue");
    expect((await execute("printf recovered")).output).toBe("recovered");
    const deathFile = join(root, "runner-death.pid");
    const dyingTool = execute(`setsid sleep 300 & echo $! > '${deathFile}'; sleep 300`, 5);
    for (let i = 0; i < 100 && !existsSync(deathFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(deathFile)).toBe(true);
    ctl("kill", "--signal=SIGKILL", runner);
    expect((await dyingTool).exitCode).not.toBe(0);
    expect(alive(Number(readFileSync(deathFile, "utf8")))).toBe(false);
  } finally {
    if (alive(pid)) ctl("stop", runner);
    for (const slice of [slices.tools, slices.boundary]) { ctl("stop", slice); ctl("revert", slice); }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
