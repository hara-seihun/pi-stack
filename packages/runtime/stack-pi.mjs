#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function terminalLaunch(args, env, directory, interactive) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), unit = `pi-native-${id}.service`;
  const manifest = join(directory, `${id}.launch.json`), environment = join(directory, `${id}.env`);
  writeFileSync(manifest, JSON.stringify({ args, unit }), { mode: 0o600 });
  writeFileSync(environment, Object.entries(env).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("\n") + "\n", { mode: 0o600 });
  const recovery = ["/usr/bin/systemd-run", "--user", "--collect", "--quiet", `--unit=pi-native-recover-${id}.service`,
    `--property=After=${unit}`, "--property=Restart=on-failure", "--property=RestartSec=5s", "--property=StartLimitIntervalSec=0",
    `--property=EnvironmentFile=${environment}`, process.execPath, fileURLToPath(new URL("./native-recovery.mjs", import.meta.url)), environment, unit]
    .map(arg => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`).join(" ");
  return { unit, manifest, environment, args: ["--user", interactive ? "--pty" : "--pipe", "--wait", "--collect", "--quiet", `--unit=${unit}`,
    "--service-type=exec", "--property=KillMode=control-group", `--property=WorkingDirectory=${process.cwd()}`,
    `--property=EnvironmentFile=${environment}`, `--property=ExecStopPost=${recovery}`,
    process.execPath, fileURLToPath(new URL("./native-host.mjs", import.meta.url)), manifest],
    cleanup(removeEnvironment = false) { rmSync(manifest, { force: true }); if (removeEnvironment) rmSync(environment, { force: true }); } };
}

export async function runTerminal(args, env = process.env) {
  const cli = fileURLToPath(new URL("./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
  if (args.length === 1 && ["--help", "-h", "--version", "-v"].includes(args[0])) {
    const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  const { recoverNativeSessionOwners } = await import("./managed-agent.mjs");
  const directory = join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "managed");
  const recovered = await recoverNativeSessionOwners(directory);
  if (!recovered.ok) throw Object.assign(new Error(recovered.error.message), { code: recovered.error.code });
  const oneShot = args.includes("--print") || args.includes("-p") || args.some((arg, index) => arg === "--mode" && ["json", "rpc"].includes(args[index + 1]));
  const launch = terminalLaunch(args, env, directory, !!(process.stdin.isTTY && process.stdout.isTTY && !oneShot));
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => {
    const handler = () => {
      const result = spawnSync("systemctl", ["--user", "kill", "--kill-whom=main", `--signal=${signal}`, launch.unit], { env, encoding: "utf8", timeout: 5000 });
      if (result.error || result.status !== 0) console.error(`Managed terminal cancellation failed: ${result.error?.message ?? result.stderr?.trim()}`);
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    const child = spawn("systemd-run", launch.args, { stdio: "inherit", env });
    return await new Promise((resolve, reject) => {
      child.once("error", error => reject(Object.assign(new Error(`Managed terminal owner is unavailable: ${error.message}`), { code: "native_owner_unavailable" })));
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    launch.cleanup();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runTerminal(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
