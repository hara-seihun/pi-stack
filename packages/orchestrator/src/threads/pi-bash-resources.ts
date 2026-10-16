import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { managerCommand, runnerSlices, TOOL_MEMORY } from "./runner-resources.js";
import { piOperationContext } from "./pi-execution.js";
import { writePiSessionFile } from "./pi-session-file.js";
import { parseBashWorkerReceipt } from "./pi-bash-receipt.js";

export const UNKILLABLE_TOOL_GRACE_MS = 10_000;

export function scopedBashOperations(env: NodeJS.ProcessEnv, local: BashOperations = createLocalBashOperations(), memory = TOOL_MEMORY): BashOperations | undefined {
  const boundary = env.PI_THREAD_RESOURCE_BOUNDARY;
  if (!boundary) return undefined;
  return { exec: async (command, cwd, options) => {
    const operation = piOperationContext.getStore();
    // Direct UI/RPC shell has no model observation; retain normal upstream custody.
    if (!operation) return local.exec(command, cwd, options);
    const directory = join(`${operation.sessionFile}.operations`, operation.operationId);
    const unit = `pi-tool-${operation.operationId.slice(3)}.scope`;
    const user = env.PI_ORCHESTRATOR_EXECUTION !== "root-repair";
    const toolEnv = { ...env, ...options.env };
    const worker = join(getPackageDir(), "dist", "pi-bash-worker.py");
    if (!existsSync(worker)) throw new Error(`Durable Bash worker is not installed: ${worker}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writePiSessionFile(join(directory, "invocation.json"), JSON.stringify({ command, cwd, env: toolEnv, timeout: options.timeout ?? null }));
    writeFileSync(join(directory, "output.log"), "", { mode: 0o600, flag: "wx" });
    operation.own({ kind: "bash-worker", directory, unit, user });
    const status = join(directory, "result.json");
    // No BindsTo/model PID death link: systemd owns this operation from launch.
    const args = [...(user ? ["--user"] : []), "--scope", "--collect", "--quiet", `--unit=${unit}`,
      `--slice=${runnerSlices(boundary).tools}`,
      `--property=MemoryHigh=${memory}`, `--property=MemoryMax=${memory}`, "--property=MemorySwapMax=256M",
      "--property=OOMPolicy=kill", "--property=KillMode=control-group", "--property=TimeoutStopSec=3s",
      "--", "/usr/bin/python3", worker, directory];
    const launcher = !user && process.getuid?.() !== 0 ? "sudo" : "systemd-run";
    const launch = spawn(launcher, launcher === "sudo" ? ["-n", "--preserve-env", "systemd-run", ...args] : args,
      { cwd, env: toolEnv, stdio: "ignore", detached: true });
    launch.unref();
    let launchError: Error | undefined;
    launch.once("error", error => { launchError = error; });
    const cancel = () => writeFileSync(join(directory, "cancel"), "explicit cancellation\n", { mode: 0o600 });
    if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let offset = 0, closed = false;
        let observer: ReturnType<typeof watch> | undefined;
        let reconcile: ReturnType<typeof setInterval> | undefined;
        const finish = (result: { exitCode: number | null } | Error) => {
          if (closed) return;
          closed = true; observer?.close(); clearInterval(reconcile);
          result instanceof Error ? reject(result) : resolve(result);
        };
        const check = () => {
          if (closed) return;
          if (launchError) { finish(launchError); return; }
          if (launch.exitCode !== null && launch.exitCode !== 0 && !existsSync(status)) { finish(new Error(`Worker launch exited ${launch.exitCode}; inspect ${directory}, do not replay`)); return; }
          const fd = openSync(join(directory, "output.log"), "r");
          try {
            const end = fstatSync(fd).size;
            const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, end - offset));
            while (offset < end) {
              const count = readSync(fd, bytes, 0, Math.min(bytes.length, end - offset), offset);
              if (!count) break;
              options.onData(bytes.subarray(0, count)); offset += count;
            }
          } finally { closeSync(fd); }
          if (!existsSync(status)) return;
          const parsed = parseBashWorkerReceipt(readFileSync(status, "utf8"));
          if (!parsed.ok) { finish(Object.assign(new Error(parsed.error), { code: "owner_lost" })); return; }
          const receipt = parsed.value;
          if (receipt.cleanupError) finish(Object.assign(new Error(`Shell outcome uncertain: ${receipt.cleanupError}; inspect ${directory}, do not replay`), { code: "owner_lost" }));
          else if (receipt.cancelled) finish(new Error("aborted"));
          else if (receipt.timedOut) finish(new Error(`timeout:${options.timeout}`));
          else finish({ exitCode: receipt.exitCode });
        };
        observer = watch(directory, check);
        // Unit loss without a receipt is uncertainty, never permission to execute again.
        reconcile = setInterval(() => {
          void managerCommand(["show", unit, "--property=ActiveState", "--value"], toolEnv, user).then(state => {
            check();
            if (!closed && !["active", "activating", "deactivating"].includes(state.stdout.trim())) finish(Object.assign(new Error(`owner_lost: ${unit} has no terminal receipt; effects may have occurred`), { code: "owner_lost" }));
          }, error => finish(Object.assign(new Error(`Worker ownership observation failed: ${String(error)}`), { code: "owner_lost" })));
        }, 5000);
        check();
      });
    } finally { options.signal?.removeEventListener("abort", cancel); }
  } };
}
