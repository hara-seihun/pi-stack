import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
import type { PiSessionOptions } from "../src/threads/contracts.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => { throw new Error("launch captured"); }) }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: Parameters<typeof fs.existsSync>[0]) => String(path).endsWith("/runner-host.js") || fs.existsSync(path) };
});
vi.mock("../src/threads/runner-memory.js", () => ({ underMemoryPressure: () => false }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(execution: "user" | "root-repair", durable: boolean, isolated = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "runner-boundary-")); roots.push(dataDir);
  const options: PiSessionOptions = { threadId: "thread", cwd: dataDir, sessionFile: join(dataDir, "thread.jsonl"),
    args: isolated ? ["--orchestrator-context", '{"tools":[]}'] : [],
    env: { HOME: dataDir, XDG_RUNTIME_DIR: "", DBUS_SESSION_BUS_ADDRESS: "", PI_ORCHESTRATOR_EXECUTION: execution, PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads" } };
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

it.each([[false, false], [true, true]] as const)("refuses root execution with durable=%s and isolated=%s before spawning", async (durable, isolated) => {
  await expect(fixture("root-repair", durable, isolated)()).rejects.toThrow(/Root.?repair/i);
  expect(spawn).not.toHaveBeenCalled();
});
