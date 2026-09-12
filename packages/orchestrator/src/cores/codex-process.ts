import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export class CodexProcessError extends Error {}
export interface CodexProcess {
  child: ChildProcessWithoutNullStreams;
  readonly startupFailure?: string;
  stop(): Promise<void>;
}
export interface CodexProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
function executable(binary: string, options: CodexProcessOptions): string {
  const candidates = isAbsolute(binary) ? [binary] : binary.includes("/") ? [resolve(options.cwd, binary)]
    : (options.env.PATH ?? "").split(delimiter).map(directory => join(directory, binary));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next executable search directory. */ }
  }
  throw new CodexProcessError(`Codex executable is unavailable: ${binary}`);
}

/** One service cgroup per app-server. setsid and double-fork do not escape it. */
export function openCodexProcess(options: CodexProcessOptions): CodexProcess {
  if (process.platform !== "linux") throw new CodexProcessError("Codex whole-tree process containment requires Linux and a systemd user manager");
  const unit = `pistack-codex-${randomUUID()}.service`;
  const env: NodeJS.ProcessEnv = { ...options.env, XDG_RUNTIME_DIR: options.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}` };
  const runner = executable("systemd-run", options), control = executable("systemctl", options);
  const child = spawn(runner, ["--user", "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec",
    `--unit=${unit}`, "--property=KillMode=control-group", "--property=TimeoutStopSec=2s", "--property=SendSIGKILL=yes",
    "--property=TimeoutStartSec=15s", `--working-directory=${options.cwd}`, "--expand-environment=no",
    ...Object.keys(env).filter(key => env[key] !== undefined).map(key => `--setenv=${key}`),
    "--", executable("sh", options), "-c", 'printf "%s\\n" "$1" >&2; shift; exec "$@"', "codex-launch", unit,
    executable(options.binary, options), ...options.args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false, registered = false;
  let registrationDone!: () => void;
  const registration = new Promise<void>(resolveReady => { registrationDone = resolveReady; });
  let firstLine = "";
  child.stderr.on("data", chunk => {
    if (registered) return;
    const text = firstLine + chunk.toString();
    if (text.includes(`${unit}\n`)) { registered = true; firstLine = ""; registrationDone(); }
    else firstLine = text.slice(-unit.length);
  });
  const done = new Promise<void>(resolveDone => {
    child.once("close", () => { exited = true; registrationDone(); resolveDone(); });
  });
  let stopPromise: Promise<void> | undefined;
  return { child, get startupFailure() {
    return exited && !registered ? "Codex process containment failed to start; a Linux systemd user manager is required" : undefined;
  }, stop() {
    return stopPromise ??= (async () => {
      // Wait until this launch owns a unit, or has failed. A stop racing service
      // registration could otherwise miss the unit and leave a late process alive.
      await registration;
      if (exited && !registered) return;
      await new Promise<void>((resolveStop, reject) => {
        execFile(control, ["--user", "stop", unit], { env, timeout: 8_000 }, error => {
          if (!error || (error as unknown as { code?: number }).code === 5) resolveStop();
          else reject(new Error("Codex service cgroup could not be stopped"));
        });
      });
      if (!exited) {
        // The unit is stopped. Only its foreground launcher remains to reap.
        child.stdin.end();
        child.kill("SIGTERM");
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([done, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Codex service launcher did not exit after cgroup stop")); }, 2_000);
        })]);
      } finally { clearTimeout(timer); }
    })();
  } };
}
