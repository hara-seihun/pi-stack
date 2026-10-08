import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
export const RUNNER_MEMORY = "4G";
export const RUNNER_HEAP_MB = 3072;
export const TOOL_MEMORY = "3G";
export const TOOLS_MEMORY = "3G";
export const BOUNDARY_MEMORY = "8G";

export function runnerSlices(id: string) {
  const boundary = `pi-thread-${id}.slice`;
  return { boundary, tools: `pi-thread-${id}-tools.slice` };
}

// Each launch owns a fresh controller unit name. A failed controller can stay
// loaded indefinitely while dead tool scopes still bind to it (their cgroups can
// hold unkillable processes in uninterruptible sleep), so a deterministic name
// could never be relaunched until someone cleared the manager by hand.
export function newRunnerUnit(id: string) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid runner resource boundary");
  return `pi-thread-runner-${id}-${randomBytes(6).toString("hex")}.service`;
}

export function runnerUnit(env: NodeJS.ProcessEnv): string {
  const id = env.PI_THREAD_RESOURCE_BOUNDARY, unit = env.PI_THREAD_RUNNER_UNIT;
  if (!id || !/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid runner resource boundary");
  if (!unit || !new RegExp(`^pi-thread-runner-${id}-[a-f0-9]{12}\\.service$`).test(unit))
    throw new Error(`Runner unit ${unit ?? "(unset)"} does not belong to resource boundary ${id}`);
  return unit;
}

export async function managerCommand(args: string[], env: NodeJS.ProcessEnv, user: boolean) {
  const sudo = !user && process.getuid?.() !== 0;
  return run(sudo ? "sudo" : "systemctl", [...(sudo ? ["-n", "--preserve-env", "systemctl"] : []), ...(user ? ["--user"] : []), ...args],
    { env, timeout: 5000, maxBuffer: 64 * 1024 });
}

export async function prepareRunnerSlices(id: string, env: NodeJS.ProcessEnv, user: boolean) {
  const slices = runnerSlices(id);
  for (const [slice, memory] of [[slices.boundary, BOUNDARY_MEMORY], [slices.tools, TOOLS_MEMORY]]) {
    await managerCommand(["set-property", "--runtime", slice, `MemoryHigh=${memory}`, `MemoryMax=${memory}`, "MemorySwapMax=256M"], env, user);
  }
  return slices;
}
