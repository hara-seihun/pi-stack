import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { constants } from "node:os";

export function nativeExitCode(status, signal) {
  if (typeof status === "number") return status;
  if (typeof constants.signals[signal] === "number") return 128 + constants.signals[signal];
  throw Object.assign(new Error("Native terminal exited without a status or known signal"), { code: "native_exit_unknown" });
}

// A manager bus is an account boundary, not a value inherited from a supervisor.
export function nativeManagerEnvironment(env = process.env, uid = process.getuid()) {
  return { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
}

export function nativeOrigin() {
  return { uid: process.getuid(), gid: process.getgid(), mount: readlinkSync("/proc/self/ns/mnt"),
    user: readlinkSync("/proc/self/ns/user"), cwd: process.cwd() };
}

export function assertNativeOrigin(origin) {
  const current = nativeOrigin();
  if (!origin || Object.keys(current).some(key => current[key] !== origin[key])) {
    throw Object.assign(new Error("Managed terminal transport changed its originating identity, namespace or cwd"), { code: "native_boundary_changed" });
  }
}

export async function recoverTerminalOwner(directory, unit, env = process.env) {
  if (!/^pi-native-[a-f0-9-]+\.scope$/.test(unit)) throw new Error("Invalid native recovery owner");
  // Stop the whole scope, including orphaned tools, before asking the ledger to release.
  // A collected unit may already be absent; only the recovery proof decides that case.
  spawnSync("systemctl", ["--user", "stop", unit], { env: nativeManagerEnvironment(env), encoding: "utf8", timeout: 10_000 });
  const { recoverNativeSessionOwners } = await import("./managed-agent.mjs");
  const result = await recoverNativeSessionOwners(directory, { unit, requireAbsent: true });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
}
