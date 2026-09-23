import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createSharedPiSessionOpener, runnerSocketDirectory } from "../src/threads/runner-transport.js";
import type { PiSessionOptions } from "../src/threads/contracts.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => { throw new Error("launch captured"); }) }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: Parameters<typeof fs.existsSync>[0]) => String(path).endsWith("/runner-host.js") || fs.existsSync(path) };
});
vi.mock("../src/threads/runner-memory.js", () => ({ underMemoryPressure: () => false }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(execution: "user" | "root-repair", durable: boolean, isolated = false, broker = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "runner-boundary-")); roots.push(dataDir);
  const options: PiSessionOptions = { threadId: "thread", cwd: dataDir, sessionFile: join(dataDir, "thread.jsonl"),
    args: isolated ? ["--orchestrator-context", '{"tools":[]}'] : [],
    env: { HOME: dataDir, XDG_RUNTIME_DIR: "", DBUS_SESSION_BUS_ADDRESS: "", PI_ORCHESTRATOR_EXECUTION: execution, PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads",
      ...(broker ? { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461", PI_ORCHESTRATOR_AUTH: "/owner/auth.json", OPENAI_API_KEY: "owner-secret" } : {}) } };
  return () => createSharedPiSessionOpener({ dataDir, durable }).openSession(options, () => {}, () => {});
}

it.each(["user", "root-repair"] as const)("launches %s in its own UID with service-owned descendant cleanup", async execution => {
  await expect(fixture(execution, true)()).rejects.toThrow("launch captured");
  expect(spawn).toHaveBeenCalledTimes(1);
  const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
  const root = execution === "root-repair";
  expect([command, ...args!].slice(0, root ? 8 : 6)).toEqual(root
    ? ["sudo", "-n", "--preserve-env", "systemd-run", "--collect", "--quiet", "--wait", "--service-type=exec"]
    : ["systemd-run", "--user", "--collect", "--quiet", "--wait", "--service-type=exec"]);
  expect(args).toContain("--property=KillMode=control-group");
  expect(args).toContain("--setenv=PI_THREAD_API_URL");
  expect(args!.some(arg => arg.includes("http://127.0.0.1:1"))).toBe(false);
  expect(options?.env?.PI_ORCHESTRATOR_OWNER_UID).toBe(root ? String(process.getuid!()) : undefined);
  expect(options?.env?.PI_ORCHESTRATOR_OWNER_GID).toBe(root ? String(process.getgid!()) : undefined);
  if (!root) {
    expect(options?.env?.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid!()}`);
    expect(options?.env?.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=/run/user/${process.getuid!()}/bus`);
  }
});

it("keeps long OIDC and application socket paths inside their Unix owner's runtime directory", () => {
  const home = "/home/pic376d3abb5129a1c90d5d875/.local/share/pi-orchestrator";
  for (const path of [home, `${home}/applications/${"a".repeat(24)}`]) {
    const directory = runnerSocketDirectory(path, 1008);
    expect(directory).toMatch(/^\/run\/user\/1008\/pi\/[a-f0-9]{16}$/);
    expect(Buffer.byteLength(join(directory, "thread-sockets", `${"0".repeat(16)}.${"0".repeat(16)}.sock`))).toBeLessThan(108);
    expect(directory).not.toBe(runnerSocketDirectory(path, 1007));
  }
  expect(runnerSocketDirectory(home, 1008)).not.toBe(runnerSocketDirectory(`${home}/applications/abc`, 1008));
  expect(runnerSocketDirectory("/tmp/pi-test", 1008)).toBe("/tmp/pi-test");
});

it("resolves runner executables before systemd's fixed executable search", async () => {
  const bin = mkdtempSync(join(tmpdir(), "runner-bin-")); roots.push(bin);
  for (const name of ["node", "flock"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = bin;
    await expect(fixture("user", true, false, true)()).rejects.toThrow("launch captured");
    const args = vi.mocked(spawn).mock.calls[0]![1]!;
    expect(args).toContain(join(bin, "flock"));
    expect(args).toContain(join(bin, "node"));
    expect(args).not.toContain("flock");
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
});

it("keeps broker runners in the ordinary UID and strips owner credential routes", async () => {
  await expect(fixture("user", true, false, true)()).rejects.toThrow("launch captured");
  const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
  expect([command, ...args!].slice(0, 3)).toEqual(["systemd-run", "--user", "--collect"]);
  expect(args).toContain("--setenv=PI_MODEL_BROKER_URL");
  expect(options?.env?.PI_MODEL_BROKER_URL).toBe("http://127.0.0.1:2461");
  const unset = args!.find(arg => arg.startsWith("--property=UnsetEnvironment="));
  for (const key of ["PI_ORCHESTRATOR_AUTH", "PI_ORCHESTRATOR_OWNER_UID", "PI_ORCHESTRATOR_OWNER_GID", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) expect(unset).toContain(key);
  expect(options?.env?.PI_ORCHESTRATOR_AUTH).toBeUndefined();
  expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
});

it("refuses root repair in a model-broker runner before spawning", async () => {
  await expect(fixture("root-repair", true, false, true)()).rejects.toThrow(/Root repair cannot use a model-broker/i);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([[false, false], [true, true]] as const)("refuses root execution with durable=%s and isolated=%s before spawning", async (durable, isolated) => {
  await expect(fixture("root-repair", durable, isolated)()).rejects.toThrow(/Root.?repair/i);
  expect(spawn).not.toHaveBeenCalled();
});
