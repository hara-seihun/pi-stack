import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNativeOrigin, nativeExitCode, nativeManagerEnvironment, recoverTerminalOwner } from "./native-recovery.mjs";

export function nativeHostLaunch(manifest, manifestPath, host = fileURLToPath(new URL("./native-host.mjs", import.meta.url))) {
  if (!/^pi-native-[a-f0-9-]+\.scope$/.test(manifest.unit) ||
      manifest.guardian !== manifest.unit.replace("pi-native-", "pi-native-watch-")) throw new Error("Invalid managed terminal scope identity");
  return ["--user", "--scope", "--collect", "--quiet", `--unit=${manifest.unit}`,
    `--property=BindsTo=${manifest.guardian}`, `--property=After=${manifest.guardian}`,
    "--property=KillMode=control-group", "--property=KillSignal=SIGKILL", "--property=TimeoutStopSec=3s",
    process.execPath, host, manifestPath];
}

// This is a non-model owner watcher. It remains in the originating namespace when
// the IO client disappears, and outside the native/tools scope it must reclaim.
export async function runNativeGuardian(manifestPath, { host, recover = recoverTerminalOwner } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertNativeOrigin(manifest.origin);
  const env = nativeManagerEnvironment();
  const scope = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!scope?.endsWith(`/${manifest.guardian}`)) throw new Error("Native watcher is not inside its declared owning scope");
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => {
    const handler = () => {
      if (signal === "SIGINT") return; // Native Pi already receives the terminal process-group signal.
      spawnSync("systemctl", ["--user", "kill", "--kill-whom=all", `--signal=${signal}`, manifest.unit],
        { env, encoding: "utf8", timeout: 5000 });
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  let code;
  try {
    const child = spawn("systemd-run", nativeHostLaunch(manifest, manifestPath, host), { env, stdio: "inherit" });
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => { try { resolve(nativeExitCode(status, signal)); } catch (error) { reject(error); } });
    });
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
    await recover(dirname(manifestPath), manifest.unit, env);
    rmSync(manifestPath, { force: true });
  }
  return code;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runNativeGuardian(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
