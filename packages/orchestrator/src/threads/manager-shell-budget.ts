export const MANAGER_SHELL_MAX_SECONDS = 5;
export const MANAGER_SHELL_RULE = "Manager bash calls, including converge action:bash, require an explicit positive timeout of at most 5 seconds. Delegate longer work to a worker.";

type ShellBudget = { ok: true; timeout: number | null }
  | { ok: false; error: { code: "invalid_request"; message: string } };

export function managerShellBudget(name: string, input: unknown): ShellBudget {
  const args = input as { action?: unknown; timeout?: unknown } | undefined;
  if (name !== "bash" && !(name === "converge" && args?.action === "bash")) return { ok: true, timeout: null };
  const timeout = args?.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 && timeout <= MANAGER_SHELL_MAX_SECONDS
    ? { ok: true, timeout }
    : { ok: false, error: { code: "invalid_request", message: MANAGER_SHELL_RULE } };
}

export class ManagerShellError extends Error {
  constructor(readonly code: "invalid_request" | "timeout", message: string) { super(message); }
}

export async function runManagerShell<T>(timeout: number, signal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const stopped = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadline.abort();
      reject(new ManagerShellError("timeout", `Manager shell deadline exceeded ${timeout}s. ` +
        "Cancellation was requested; effects may already have happened and cleanup may still be pending. Inspect before retrying."));
    }, timeout * 1000);
  });
  try { return await Promise.race([execute(stopped), expired]); }
  finally { clearTimeout(timer); }
}
