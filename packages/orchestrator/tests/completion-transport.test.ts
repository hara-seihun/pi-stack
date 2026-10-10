import { expect, it, vi } from "vitest";

const launch = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; options: any }> }));
vi.mock("node:child_process", () => ({ execFile(command: string, args: string[], options: any, callback: (error: unknown, stdout: string, stderr: string) => void) {
  launch.calls.push({ command, args, options }); callback(null, "", "");
} }));
vi.mock("node:fs", async () => ({ ...await vi.importActual("node:fs"), existsSync: () => true, mkdirSync: vi.fn() }));
import { launchCompletionHost } from "../src/host/completion-transport.js";

it("transfers custody to a non-restarting user unit, under a lifetime flock, without launcher waiting or credential argv", async () => {
  const previous = { token: process.env.PI_THREAD_TOKEN, secret: process.env.OPENAI_API_KEY };
  process.env.PI_THREAD_TOKEN = "thread-capability-fixture";
  process.env.OPENAI_API_KEY = "provider-secret-fixture";
  try {
    await launchCompletionHost({ ledgerPath: "/ledger", authPath: "/auth", agentDir: "/agent" }, "/owner.sock");
    const call = launch.calls[0]!;
    expect(call.command).toBe("systemd-run");
    expect(call.args).toContain("--user"); expect(call.args).toContain("--property=Restart=no");
    expect(call.args).not.toContain("--wait");
    expect(call.args).toContain("/usr/bin/flock"); expect(call.args).toContain("--no-fork");
    expect(call.args).toContain("/owner.sock.lock"); expect(call.args).toContain("--conflict-exit-code");
    expect(call.args.join(" ")).not.toContain("thread-capability-fixture");
    expect(call.args.join(" ")).not.toContain("provider-secret-fixture");
    expect(call.options.env.PI_THREAD_TOKEN).toBeUndefined();
    expect(call.options.env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=/run/user/${process.getuid!()}/bus`);
    expect(call.args.slice(-4)).toEqual(["/owner.sock", "/ledger", "/auth", "/agent"]);
  } finally {
    if (previous.token === undefined) delete process.env.PI_THREAD_TOKEN; else process.env.PI_THREAD_TOKEN = previous.token;
    if (previous.secret === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.secret;
  }
});
