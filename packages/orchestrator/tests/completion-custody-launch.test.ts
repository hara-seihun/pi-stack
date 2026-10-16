import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { completionHostSocket, launchCompletionHostForCustody } from "../src/host/completion-transport.js";
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: vi.fn((_command, _args, _options, callback) => { callback(null, "", ""); }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.mocked(execFile).mockClear(); });
const identity = process as { getuid(): number; getgid(): number };
const boundary = { ledgerPath: "/owned/ledger.sqlite3", authPath: "/owned/auth.json", agentDir: "/owned/agent" };
test("root core launches a missing completion host under exact old UID/GID/home and no inherited credentials", async () => {
  vi.spyOn(identity, "getuid").mockReturnValue(0);
  vi.stubEnv("PI_CORE_TOKEN_FILE", "/root/private-token"); vi.stubEnv("ANTHROPIC_API_KEY", "private-fixture");
  const socket = completionHostSocket(boundary.ledgerPath, 1500);
  await launchCompletionHostForCustody(boundary, socket, { uid: 1500, gid: 1600, home: "/owned" });
  const [command, args, options] = vi.mocked(execFile).mock.calls[0]!;
  expect(command).toBe("/usr/bin/setpriv");
  expect(args!.slice(0, 7)).toEqual(["--reuid", "1500", "--regid", "1600", "--init-groups", "--", process.execPath]);
  expect(args!.slice(-2)).toEqual([JSON.stringify(boundary), socket]);
  expect(options).toMatchObject({ cwd: "/owned", env: { HOME: "/owned", XDG_RUNTIME_DIR: "/run/user/1500", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1500/bus" } });
  expect((options as any).env.PI_CORE_TOKEN_FILE).toBeUndefined(); expect((options as any).env.ANTHROPIC_API_KEY).toBeUndefined();
});
test("a non-root controller cannot substitute another person's UID or group", async () => {
  vi.spyOn(identity, "getuid").mockReturnValue(1500); vi.spyOn(identity, "getgid").mockReturnValue(1600);
  await expect(launchCompletionHostForCustody(boundary, "/run/user/1700/host.sock", { uid: 1700, gid: 1600, home: "/owned" })).rejects.toThrow("launch authority");
  await expect(launchCompletionHostForCustody(boundary, "/run/user/1500/host.sock", { uid: 1500, gid: 1800, home: "/owned" })).rejects.toThrow("launch authority");
  expect(execFile).not.toHaveBeenCalled();
});
