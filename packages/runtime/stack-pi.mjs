#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeExitCode, nativeManagerEnvironment, nativeOrigin, recoverTerminalOwner } from "./native-recovery.mjs";

export function terminalLaunch(args, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), unit = `pi-native-${id}.scope`, guardian = `pi-native-watch-${id}.scope`;
  const manifest = join(directory, `${id}.launch.json`);
  writeFileSync(manifest, JSON.stringify({ args, unit, guardian, origin: nativeOrigin() }), { mode: 0o600 });
  return { unit, guardian, manifest, args: ["--user", "--scope", "--collect", "--quiet", `--unit=${guardian}`,
    "--property=KillMode=control-group", "--property=KillSignal=SIGKILL", "--property=TimeoutStopSec=3s",
    process.execPath, fileURLToPath(new URL("./native-guardian.mjs", import.meta.url)), manifest],
    cleanup() { rmSync(manifest, { force: true }); } };
}

export function terminalTimezoneEnvironment(input, user = userInfo().username, configured = existsSync) {
  const env = { ...input }, directory = `/var/lib/pi-timezones/${user}`;
  // A terminal owns its kernel account, not an inherited person's projection.
  delete env.PI_PERSON_TIMEZONE_FILE;
  if (configured(directory)) env.PI_PERSON_TIMEZONE_FILE = `${directory}/timezone.json`;
  return env;
}

export async function runTerminal(args, inputEnv = process.env) {
  const env = terminalTimezoneEnvironment(nativeManagerEnvironment(inputEnv));
  const cli = fileURLToPath(new URL("./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
  if (args.length === 1 && ["--help", "-h", "--version", "-v"].includes(args[0])) {
    const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  const { recoverNativeSessionOwners } = await import("./managed-agent.mjs");
  const directory = join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "managed");
  const recovered = await recoverNativeSessionOwners(directory);
  if (!recovered.ok) throw Object.assign(new Error(recovered.error.message), { code: recovered.error.code });
  const launch = terminalLaunch(args, directory);
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => {
    const handler = () => {
      // Foreground scopes share the terminal's process group. SIGINT already
      // reaches native Pi; forwarding it would turn one Ctrl-C into several.
      if (signal === "SIGINT") return;
      const result = spawnSync("systemctl", ["--user", "kill", "--kill-whom=all", `--signal=${signal}`, launch.unit], { env, encoding: "utf8", timeout: 5000 });
      if (result.error || result.status !== 0) console.error(`Managed terminal cancellation failed: ${result.error?.message ?? result.stderr?.trim()}`);
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    // --scope executes here, not in the manager's mount namespace. The real TTY,
    // pipes, account, private mounts, cwd and application confinement are inherited.
    const child = spawn("systemd-run", launch.args, { stdio: "inherit", env });
    return await new Promise((resolve, reject) => {
      child.once("error", error => reject(Object.assign(new Error(`Managed terminal owner is unavailable: ${error.message}`), { code: "native_owner_unavailable" })));
      child.once("close", (code, signal) => { try { resolve(nativeExitCode(code, signal)); } catch (error) { reject(error); } });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    // Covers a watcher crash too; BindsTo stops its native scope. Unknown owner
    // absence retains custody and the next same-owner launch retries recovery.
    await recoverTerminalOwner(directory, launch.unit, env);
    launch.cleanup();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runTerminal(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
