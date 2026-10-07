import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const RUNNER_MEMORY = "4G";
export const RUNNER_HEAP_MB = 3072;
export const TOOL_MEMORY = "3G";
export const TOOLS_MEMORY = "8G";
export const BOUNDARY_MEMORY = "8G";

export function runnerSlices(id: string) {
  const boundary = `pi-thread-${id}.slice`;
  return { boundary, tools: `pi-thread-${id}-tools.slice` };
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
