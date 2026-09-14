import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
import type { PiSessionOptions } from "../src/threads/contracts.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => { throw new Error("launch captured"); }) }));
vi.mock("../src/threads/runner-memory.js", () => ({ underMemoryPressure: () => false }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(execution: "user" | "root-repair", durableScope: boolean, isolated = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "runner-boundary-")); roots.push(dataDir);
  const options: PiSessionOptions = { threadId: "thread", cwd: dataDir, sessionFile: join(dataDir, "thread.jsonl"),
    args: isolated ? ["--orchestrator-context", '{"tools":[]}'] : [],
    env: { HOME: dataDir, PI_ORCHESTRATOR_EXECUTION: execution, PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads" } };
  return () => createSharedPiSessionOpener({ dataDir, durableScope }).openSession(options, () => {}, () => {});
}

it.each(["user", "root-repair"] as const)("launches %s in its own UID and systemd scope", async execution => {
  await expect(fixture(execution, true)()).rejects.toThrow("launch captured");
  expect(spawn).toHaveBeenCalledTimes(1);
  const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
  const root = execution === "root-repair";
  expect([command, ...args!].slice(0, root ? 7 : 5)).toEqual(root
    ? ["sudo", "-n", "--preserve-env", "systemd-run", "--scope", "--collect", "--quiet"]
    : ["systemd-run", "--user", "--scope", "--collect", "--quiet"]);
  expect(options?.env?.PI_ORCHESTRATOR_OWNER_UID).toBe(root ? String(process.getuid!()) : undefined);
  expect(options?.env?.PI_ORCHESTRATOR_OWNER_GID).toBe(root ? String(process.getgid!()) : undefined);
});

it.each([[false, false], [true, true]] as const)("refuses root execution with durableScope=%s and isolated=%s before spawning", async (durableScope, isolated) => {
  await expect(fixture("root-repair", durableScope, isolated)()).rejects.toThrow(/Root.?repair/i);
  expect(spawn).not.toHaveBeenCalled();
});
