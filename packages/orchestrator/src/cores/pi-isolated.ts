import { AsyncLocalStorage } from "node:async_hooks";
import { argument, type CoreSessionOptions } from "./contracts.js";

export async function piIsolatedContext(options: CoreSessionOptions, cwd: string, sessionFile: string,
  environment: NodeJS.ProcessEnv, scope: AsyncLocalStorage<NodeJS.ProcessEnv>) {
  const raw = argument(options.args, "--orchestrator-context");
  if (raw === undefined) return undefined;
  // The isolated-context owner changes process cwd/environment. Fleet opens it
  // in a dedicated worker, and its extensions must see the scrubbed environment.
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const args = [...options.args];
  const sessionIndex = args.indexOf("--session");
  if (sessionIndex >= 0) args.splice(sessionIndex, 2);
  args.push("--session", sessionFile);
  const { isolatedCoreContext } = await import("../host/isolated-context.js");
  const isolated = await scope.run(process.env, () => isolatedCoreContext({ ...options, cwd, args }));
  if (!isolated) throw new Error("Isolated core context was not accepted");
  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, process.env);
  return { ...isolated, context: JSON.parse(raw) as { tools: string[]; extensions?: string[] } };
}
