import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachRuntimeHost, runtimeSocketPath, startRuntimeHost, type RuntimeTransport } from "./runtime-transport";

const roots: string[] = [];
const transports: RuntimeTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.terminate()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime host identity", () => {
  test("gives every launch its own socket even for the same thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-remote-runtime-"));
    roots.push(root);
    const child = join(root, "child.ts");
    writeFileSync(child, "await new Promise(() => {});\n");
    const options = {
      data: root,
      sessionId: "thread-1",
      cwd: root,
      args: [process.execPath, child],
      env: { ...process.env },
      onOutput: () => {},
    };

    const first = await startRuntimeHost(options);
    const second = await startRuntimeHost(options);
    transports.push(first, second);

    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.pid).not.toBe(second.pid);
    expect(existsSync(first.socketPath)).toBe(true);
    expect(existsSync(second.socketPath)).toBe(true);
  });

  test("reattaches across supervisor exit with full production-length identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-handoff-"));
    roots.push(root);
    const data = join(root, "private-folder", ".pi-remote");
    mkdirSync(data, { recursive: true });
    const launcher = join(root, "launcher.ts");
    writeFileSync(launcher, `
      import {startRuntimeHost} from ${JSON.stringify(join(import.meta.dir, "runtime-transport.ts"))};
      const host = await startRuntimeHost({ data: ${JSON.stringify(data)}, sessionId: crypto.randomUUID(), cwd: ${JSON.stringify(root)}, args: [process.execPath, "-e", "setInterval(() => {}, 10000)"], env: process.env, onOutput() {} });
      console.log(JSON.stringify({socketPath:host.socketPath,pid:host.pid}));
      host.detach();
      process.exit(75);
    `);
    const launcherProcess = Bun.spawn([process.execPath, launcher], { stdout: "pipe", stderr: "inherit" });
    const reader = launcherProcess.stdout.getReader();
    const output = await reader.read();
    const {socketPath, pid} = JSON.parse(new TextDecoder().decode(output.value).trim());
    await reader.cancel();
    expect(await launcherProcess.exited).toBe(75);
    const attached = await attachRuntimeHost(socketPath, () => {});
    transports.push(attached);
    expect(attached.pid).toBe(pid);
  });

  test("includes a launch identity in generated paths", () => {
    const first = runtimeSocketPath("/state", "thread", "first");
    const second = runtimeSocketPath("/state", "thread", "second");
    expect(first).toBe("/state/runtime-hosts/thread.first.sock");
    expect(second).toBe("/state/runtime-hosts/thread.second.sock");
  });
});
