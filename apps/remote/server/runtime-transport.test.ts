import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeSocketPath, startRuntimeHost, type RuntimeTransport } from "./runtime-transport";

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

  test("includes a launch identity in generated paths", () => {
    const first = runtimeSocketPath("/state", "thread", "first");
    const second = runtimeSocketPath("/state", "thread", "second");
    expect(first).toBe("/state/runtime-hosts/thread.first.sock");
    expect(second).toBe("/state/runtime-hosts/thread.second.sock");
  });
});
