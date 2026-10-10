import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { oneKenanEnabled } from "kenan-memory/config";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CONVERGE_WORKER } from "./converge-worker.js";
import { managerShellBudget, MANAGER_SHELL_MAX_SECONDS, MANAGER_SHELL_RULE } from "./manager-shell-budget.js";

const cwd = Type.Optional(Type.String({ minLength: 1, pattern: "^/", description: "Absolute Converge directory; defaults to its SSH user's home. Never the local thread cwd." }));
const file = { cwd, path: Type.String({ minLength: 1, description: "Path on Converge; relative paths resolve against remote cwd. ~ means the remote home." }) };
export const convergeParameters = Type.Union([
  Type.Object({ action: Type.Literal("bash"), cwd, command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1800, description: "Seconds, default 55; cannot exceed this thread's shell allowance." })) }),
  Type.Object({ action: Type.Literal("read"), ...file, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
  Type.Object({ action: Type.Literal("write"), ...file, content: Type.String() }),
  Type.Object({ action: Type.Literal("edit"), ...file, edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }), { minItems: 1 }) }),
]);
function convergeManagerParameters() {
  const [shell, ...files] = convergeParameters.anyOf;
  return Type.Union([Type.Object({ ...shell.properties,
    timeout: Type.Number({ exclusiveMinimum: 0, maximum: MANAGER_SHELL_MAX_SECONDS, description: "Explicit seconds; manager maximum 5, including SSH." }) }), ...files]);
}
export type ConvergeOperation = Static<typeof convergeParameters>;
export type ConvergeResult = { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: "remote_operation" | "transport" | "cancelled" | "timeout" | "invalid_request"; message: string } };
const failure = (code: Extract<ConvergeResult, { ok: false }>["error"]["code"], message: string): ConvergeResult => ({ ok: false, error: { code, message } });

export function convergePerson(env: NodeJS.ProcessEnv): string | undefined {
  return env.PI_REMOTE_SENDER_ID;
}

export function convergeEnabled(env: NodeJS.ProcessEnv): boolean {
  if (convergePerson(env) !== "kenan") return false;
  return oneKenanEnabled(env);
}

export function convergeTimeout(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS ?? env.PI_BASH_TIMEOUT_MAX_SECONDS ?? 55);
  const maximum = env.PI_THREAD_MANAGER === "1" ? MANAGER_SHELL_MAX_SECONDS : 1800;
  return Number.isFinite(configured) && configured > 0 ? Math.min(maximum, configured) : Math.min(maximum, 55);
}

export function convergeSshArguments(): string[] {
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  return ["-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
    "-o", "ClearAllForwardings=yes", "-o", "SendEnv=-*", "converge-kenan",
    `python3 -u -c ${quote(CONVERGE_WORKER)}`];
}

type Launch = (args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const launchSsh: Launch = (args, env) => spawn("ssh", args, { env, stdio: "pipe" });
export function executeConverge(operation: ConvergeOperation, options: {
  env: NodeJS.ProcessEnv; signal?: AbortSignal; launch?: Launch;
}): Promise<ConvergeResult> {
  const managerBash = options.env.PI_THREAD_MANAGER === "1" && operation.action === "bash";
  if (managerBash) {
    const budget = managerShellBudget("converge", operation);
    if (!budget.ok) return Promise.resolve(failure(budget.error.code, budget.error.message));
  }
  const started = performance.now();
  const maxTimeout = convergeTimeout(options.env);
  const timeout = operation.action === "bash" ? operation.timeout ?? Math.min(55, maxTimeout) : 20;
  if (!Number.isFinite(timeout) || timeout <= 0 || operation.action === "bash" && timeout > maxTimeout)
    return Promise.resolve(failure("invalid_request", `timeout must be positive and at most ${maxTimeout} seconds`));
  if (operation.cwd !== undefined && !operation.cwd.startsWith("/"))
    return Promise.resolve(failure("invalid_request", "cwd must be an absolute Converge path"));
  if (options.signal?.aborted) return Promise.resolve(failure("cancelled", "Cancelled before sending to Converge"));
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    // SSH reads its existing server-owned config/key. No session variables, tokens, contacts or agent socket cross this boundary.
    const env = { HOME: options.env.HOME, PATH: options.env.PATH ?? process.env.PATH, LANG: "C.UTF-8" };
    try { child = (options.launch ?? launchSsh)(convergeSshArguments(), env); }
    catch (error) { resolve(failure("transport", String(error))); return; }
    let output = "", stderr = "", bytes = 0, settled = false, terminal: ConvergeResult | undefined;
    const uncertain = "Remote effects may already have happened; inspect before retrying.";
    const stop = (result: ConvergeResult) => {
      terminal ??= result;
      // EOF lets the remote worker kill its command process group; killing SSH also closes the remote pipe on disconnect.
      child.stdin.end();
      child.kill(managerBash ? "SIGKILL" : "SIGTERM");
      if (managerBash) finish(terminal);
      else killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = () => stop(failure("cancelled", `Converge operation cancelled. ${uncertain}`));
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => stop(failure("timeout", `SSH operation exceeded its allowance. ${uncertain}`)),
      Math.max(0, (managerBash ? timeout : timeout + 12) * 1000 - (performance.now() - started)));
    function finish(result: ConvergeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 1024 * 1024) stop(failure("transport", `Converge response exceeded 1 MiB. ${uncertain}`));
      else output += data;
    });
    child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-4096); });
    child.stdin.on("error", error => { terminal ??= failure("transport", `SSH input failed: ${error.message}. ${uncertain}`); });
    child.on("error", error => finish(failure("transport", `Cannot start SSH: ${error.message}`)));
    child.on("close", code => {
      if (terminal) { finish(terminal); return; }
      if (code !== 0) { finish(failure("transport", `SSH exited ${code}: ${stderr.trim()}. ${uncertain}`)); return; }
      try {
        const result = JSON.parse(output) as ConvergeResult;
        if (!result || typeof result !== "object" || (result.ok !== true && result.ok !== false)
          || (result.ok ? !result.value || typeof result.value !== "object" : !result.error?.message))
          throw new Error("Invalid worker result");
        finish(result);
      } catch (error) { finish(failure("transport", `Invalid Converge response: ${String(error)}. ${uncertain}`)); }
    });
    // Keep stdin open after the request: the remote command watches EOF for cancellation.
    child.stdin.write(JSON.stringify({ ...operation, ...(operation.action === "bash" ? { timeout } : {}) }) + "\n");
    if (options.signal?.aborted) abort();
  });
}

export function convergeTools(env: NodeJS.ProcessEnv) {
  if (!convergeEnabled(env)) return [];
  return [defineTool({
    name: "converge", label: "Work on Converge",
    description: (env.PI_THREAD_MANAGER === "1" ? `${MANAGER_SHELL_RULE} ` : "") + "Work on Converge over the server's existing SSH identity while remaining this local Kenan, with local memory, contacts and Signal. Only this requested operation is sent; context and local files are never synchronized. bash runs remote repositories/tools; read reads UTF-8 text (2000 lines/50 KiB); write atomically creates/replaces a remote file; edit applies exact non-overlapping replacements against the original remote file, each oldText unique. cwd defaults to the remote home, not the local workspace. Local bash/read/write/edit remain local. Read remote AGENTS.md before working in a repository. Shell output is combined stdout/stderr, last 50 KiB; inspect exitCode and stopped. For a read partialLine, use bash to inspect a byte range. No retry after transport loss until you inspect remote effects. No remote supervisor/thread or personal-context copy is involved.",
    parameters: env.PI_THREAD_MANAGER === "1" ? convergeManagerParameters() : convergeParameters,
    execute: async (_id, input, signal) => {
      const value = convergeEnabled(env) ? await executeConverge(input, { env, signal })
        : failure("invalid_request", "Converge reach is disabled for this person or host");
      const shellFailed = value.ok && input.action === "bash" && (value.value.exitCode !== 0 || value.value.stopped !== null);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, isError: !value.ok || !!shellFailed };
    },
  })];
}
