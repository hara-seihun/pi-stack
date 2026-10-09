import { randomUUID } from "node:crypto";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { managerCommand, runnerSlices, runnerUnit, TOOL_MEMORY } from "./runner-resources.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// After its timeout or abort, a killed tool normally exits at once. A process in
// uninterruptible sleep (D state, e.g. sync against a wedged block device) or one
// owned by another user cannot be killed; the turn must not wait on it forever.
export const UNKILLABLE_TOOL_GRACE_MS = 10_000;

class AbandonedTool extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function abandonAfterKill<T>(operation: Promise<T>, timeout: number | undefined, signal: AbortSignal | undefined, grace: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let deadline: NodeJS.Timeout | undefined, abandon: NodeJS.Timeout | undefined, settled = false;
    const settle = (effect: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(abandon); signal?.removeEventListener("abort", onAbort); effect();
    };
    const arm = (reason: string) => { abandon ??= setTimeout(() => settle(() => reject(new AbandonedTool(reason))), grace); };
    const onAbort = () => arm("aborted");
    if (timeout !== undefined) deadline = setTimeout(() => arm(`timeout:${timeout}`), timeout * 1000);
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
  });
}

export function scopedBashOperations(env: NodeJS.ProcessEnv, local: BashOperations = createLocalBashOperations(), memory = TOOL_MEMORY,
  grace = UNKILLABLE_TOOL_GRACE_MS): BashOperations | undefined {
  const id = env.PI_THREAD_RESOURCE_BOUNDARY;
  if (!id) return undefined;
  const runner = runnerUnit(env);
  const user = env.PI_ORCHESTRATOR_EXECUTION !== "root-repair";
  return { exec: async (command, cwd, options) => {
    if (options.signal?.aborted) throw new Error("aborted");
    const unit = `pi-thread-tool-${randomUUID()}.scope`;
    const toolEnv = { ...env, ...options.env };
    const args = ["systemd-run", ...(user ? ["--user"] : []), "--scope", "--collect", "--quiet",
      `--unit=${unit}`, `--slice=${runnerSlices(id).tools}`, `--property=BindsTo=${runner}`, `--property=After=${runner}`,
      `--property=MemoryHigh=${memory}`, `--property=MemoryMax=${memory}`, "--property=MemorySwapMax=256M", "--property=OOMPolicy=kill",
      "--property=KillMode=control-group", "--property=KillSignal=SIGKILL", "--property=TimeoutStopSec=3s", "--", "bash", "-c",
      `printf '1000' > /proc/self/oom_score_adj || exit 125; exec bash -c ${quote(command)}`];
    let abandoned: AbandonedTool | undefined;
    try {
      // Scope execution is forked by the caller, not the manager: encrypted mounts,
      // cwd, UID and the session environment remain in the existing boundary.
      const execution = local.exec(`exec ${args.map(quote).join(" ")}`, cwd, { ...options, env: toolEnv });
      return await abandonAfterKill(execution, options.timeout, options.signal, grace);
    } catch (error) {
      if (error instanceof AbandonedTool) abandoned = error;
      throw error;
    } finally {
      let cleanup: unknown;
      try { await managerCommand(["stop", unit], toolEnv, user); }
      catch (error) {
        // --collect may have already removed a scope whose entire cgroup exited.
        if (!/Unit .* not loaded\./.test(String((error as { stderr?: string }).stderr ?? ""))) cleanup = error;
      }
      // The scope stays loaded while its processes cannot die. It binds only this
      // launch's uniquely named controller, so it never blocks a later runner.
      if (abandoned) throw Object.assign(new Error(`Tool ${abandoned.reason === "aborted" ? "abort" : `timeout after ${options.timeout}s`}: ` +
        `its processes did not exit ${grace / 1000}s after SIGKILL (uninterruptible I/O or another user's process) and remain in ${unit}; ` +
        "the call was abandoned. Do not retry the same operation until the stuck I/O is resolved.", { cause: cleanup }), { code: "tool_cleanup_unconfirmed" });
      if (cleanup) throw Object.assign(new Error(`Tool scope cleanup unconfirmed for ${unit}`, { cause: cleanup }), { code: "tool_cleanup_unconfirmed" });
    }
  } };
}
