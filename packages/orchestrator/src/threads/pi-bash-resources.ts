import { randomUUID } from "node:crypto";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { managerCommand, runnerSlices, TOOL_MEMORY } from "./runner-resources.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function scopedBashOperations(env: NodeJS.ProcessEnv, local: BashOperations = createLocalBashOperations(), memory = TOOL_MEMORY): BashOperations | undefined {
  const id = env.PI_THREAD_RESOURCE_BOUNDARY;
  if (!id) return undefined;
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid runner resource boundary");
  const user = env.PI_ORCHESTRATOR_EXECUTION !== "root-repair";
  const runner = `pi-thread-runner-${id}.service`;
  return { exec: async (command, cwd, options) => {
    if (options.signal?.aborted) throw new Error("aborted");
    const unit = `pi-thread-tool-${randomUUID()}.scope`;
    const toolEnv = { ...env, ...options.env };
    const args = ["systemd-run", ...(user ? ["--user"] : []), "--scope", "--collect", "--quiet",
      `--unit=${unit}`, `--slice=${runnerSlices(id).tools}`, `--property=BindsTo=${runner}`, `--property=After=${runner}`,
      `--property=MemoryHigh=${memory}`, `--property=MemoryMax=${memory}`, "--property=MemorySwapMax=256M", "--property=OOMPolicy=kill",
      "--property=KillMode=control-group", "--property=KillSignal=SIGKILL", "--property=TimeoutStopSec=3s", "--", "bash", "-c",
      `printf '1000' > /proc/self/oom_score_adj || exit 125; exec bash -c ${quote(command)}`];
    try {
      // Scope execution is forked by the caller, not the manager: encrypted mounts,
      // cwd, UID and the session environment remain in the existing boundary.
      return await local.exec(`exec ${args.map(quote).join(" ")}`, cwd, { ...options, env: toolEnv });
    } finally {
      try { await managerCommand(["stop", unit], toolEnv, user); }
      catch (error) {
        // --collect may have already removed a scope whose entire cgroup exited.
        if (!/Unit .* not loaded\./.test(String((error as { stderr?: string }).stderr ?? "")))
          throw new Error(`Tool scope cleanup unconfirmed for ${unit}`, { cause: error });
      }
    }
  } };
}
