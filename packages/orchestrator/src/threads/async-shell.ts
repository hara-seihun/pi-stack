import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { defineTool, getPackageDir, type BashOperations, type SessionManager } from "@earendil-works/pi-coding-agent";
import { scopedBashOperations } from "./pi-bash-resources.js";
import type { PiExecution } from "./pi-execution.js";

const CUSTOM_TYPE = "thread_shell_session_v1";
const MAX_YIELD_MS = 1_000;
const MAX_SESSIONS = 128;
const ACTION_TYPE = "thread_shell_stdin_v1";
const actionSchema = Type.Object({ owner: Type.String(), request_id: Type.String(), session_id: Type.String(), state: Type.Literal("submitted") }, { additionalProperties: false });
const receiptFields = { session_id: Type.String(), request_id: Type.String(), owner: Type.String(), started_at: Type.Number(), deadline_at: Type.Number() };
const receiptSchema = Type.Union([
  Type.Object({ ...receiptFields, status: Type.Literal("running") }, { additionalProperties: false }),
  Type.Object({ ...receiptFields, status: Type.Literal("completed"), exit_code: Type.Integer(), finished_at: Type.Number() }, { additionalProperties: false }),
  Type.Object({ ...receiptFields, status: Type.Union([Type.Literal("failed"), Type.Literal("interrupted")]), error: Type.String({ minLength: 1 }), finished_at: Type.Number() }, { additionalProperties: false }),
]);
type Receipt = { session_id: string; request_id: string; owner: string; started_at: number; deadline_at: number } & (
  { status: "running" } | { status: "completed"; exit_code: number; finished_at: number } | { status: "failed"; error: string; finished_at: number } | { status: "interrupted"; error: string; finished_at: number });
type Accumulator = { append(data: Buffer): void; finish(): void; snapshot(): { content: string; truncation: { truncated: boolean } } };
type Job = { receipt: Receipt; output?: Accumulator; controller?: AbortController; done: Promise<void>; write?: (text: string, eof: boolean) => Promise<void> };
export type ShellBackend = { exec: (command: string, cwd: string, options: Parameters<BashOperations["exec"]>[2] & {
  onStdin?: (write: (text: string, eof: boolean) => Promise<void>) => void;
}) => ReturnType<BashOperations["exec"]> };

export async function ownedPipeShellOperations(ownerModule = join(getPackageDir(), "dist/pi-shell-owner.mjs")): Promise<ShellBackend> {
  if (process.platform !== "linux") throw new Error("Asynchronous pipe shell requires Linux descendant ownership");
  return { exec: async (command, cwd, options) => {
    if (options.signal?.aborted) throw new Error("aborted");
    const { spawnOwnedShell, cancelOwnedShell, releaseOwnedShell, shellOwnershipResult } = await import(pathToFileURL(ownerModule).href);
    if (options.signal?.aborted) throw new Error("aborted");
    const child: ChildProcess = spawnOwnedShell("/bin/bash", ["-c", command], { cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => { if (child.pid) cancelOwnedShell(child.pid); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, options.timeout! * 1000);
    // A refused/closed input pipe is an operation error, never an unhandled stream error.
    let inputError: Error | undefined;
    child.stdin!.on("error", error => { inputError = error; });
    options.onStdin?.(async (text, eof) => {
      if (inputError) throw inputError;
      if (!child.stdin!.writable || child.stdin!.writableEnded) throw new Error("Shell stdin is closed");
      if (child.stdin!.writableLength + Buffer.byteLength(text) > 65536) throw new Error("Shell stdin queue exceeds 64KB; wait for the reader before writing more");
      if (eof) child.stdin!.end(text); else child.stdin!.write(text);
    });
    child.stdout!.on("data", options.onData);
    child.stderr!.on("data", options.onData);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const ownership = await shellOwnershipResult(child);
      if (!ownership.ok) throw Object.assign(new Error(ownership.error), { code: "shell_cleanup_failed" });
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      if (options.signal?.aborted) throw new Error("aborted");
      if (code === null) throw new Error("Shell terminated without an exit code");
      return { exitCode: code };
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (child.pid) releaseOwnedShell(child.pid);
    }
  } };
}

export async function asynchronousShellTools(options: { cwd: string; env: NodeJS.ProcessEnv; owner: string; manager: SessionManager;
  execution: PiExecution; backend?: ShellBackend }) {
  const sdk = getPackageDir();
  const { OutputAccumulator } = await import(pathToFileURL(join(sdk, "dist/core/tools/output-accumulator.js")).href);
  // The caller supplies the actual configured timeout; no new shell permission is inferred.
  const configuredCeiling = options.env.PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS ?? options.env.PI_BASH_TIMEOUT_MAX_SECONDS;
  if (configuredCeiling !== undefined && (!Number.isFinite(Number(configuredCeiling)) || Number(configuredCeiling) <= 0)) throw new Error("Invalid shell timeout ceiling");
  const local = options.backend ?? await ownedPipeShellOperations();
  const backend = (scopedBashOperations(options.env, local) ?? local) as ShellBackend;
  const jobs = new Map<string, Job>();
  const requests = new Map<string, string>();
  const persist = (receipt: Receipt) => options.manager.appendCustomEntry(CUSTOM_TYPE, receipt);
  for (const entry of options.manager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ACTION_TYPE && !Check(actionSchema, entry.data)) throw new Error("Invalid persisted shell stdin receipt");
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    if (!Check(receiptSchema, entry.data)) throw new Error("Invalid persisted asynchronous shell receipt");
    const receipt = entry.data as Receipt;
    if (receipt.owner !== options.owner) continue;
    jobs.set(receipt.session_id, { receipt, done: Promise.resolve() }); requests.set(receipt.request_id, receipt.session_id);
    if (jobs.size > MAX_SESSIONS) { const key = jobs.keys().next().value!; requests.delete(jobs.get(key)!.receipt.request_id); jobs.delete(key); }
  }
  for (const job of jobs.values()) if (job.receipt.status === "running") {
    job.receipt = { ...job.receipt, status: "interrupted", finished_at: Date.now(), error: "Previous executor is unavailable; outcome unknown. This command will not be replayed." };
    persist(job.receipt);
  }
  const view = (job: Job) => ({ ...job.receipt, elapsed_ms: Math.max(0, (job.receipt.status === "running" ? Date.now() : job.receipt.finished_at) - job.receipt.started_at),
    remaining_ms: job.receipt.status === "running" ? Math.max(0, job.receipt.deadline_at - Date.now()) : 0,
    output: job.output?.snapshot().content ?? "", truncated: job.output?.snapshot().truncation.truncated ?? false, output_available: !!job.output });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
  const wait = async (job: Job, yieldMs: number, signal?: AbortSignal, stdinQueued = false) => {
    if (!Number.isInteger(yieldMs) || yieldMs < 0 || yieldMs > MAX_YIELD_MS) return result({ status: "error", code: "invalid_yield", error: `yield_time_ms must be 0..${MAX_YIELD_MS}` });
    let timer: NodeJS.Timeout | undefined;
    let cancel: (() => void) | undefined;
    try {
      await Promise.race([job.done, new Promise<void>(resolve => {
        timer = setTimeout(resolve, yieldMs);
        cancel = resolve;
        if (signal?.aborted) resolve(); else signal?.addEventListener("abort", cancel, { once: true });
      })]);
      return result({ ...view(job), ...(stdinQueued ? { stdin_queued: true } : {}) });
    } finally { clearTimeout(timer); if (cancel) signal?.removeEventListener("abort", cancel); }
  };
  return [defineTool({
    name: "bash", label: "bash", description: "Start an owned shell command. Returns completed/failed output or a running session_id after at most 1000ms. Continue other useful work; use bash_session to poll, write pipe stdin or cancel. timeout is the hard command deadline in seconds, not the yield. Output is a cumulative memory-only tail (2000 lines/50KB). Stop closes all this thread's shell descendants. Commands are never replayed after executor loss.",
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Number({ exclusiveMinimum: 0 }),
      yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_YIELD_MS })) }),
    execute: async (id, input, signal, onUpdate, ctx) => {
      const stored = requests.has(id) ? undefined : options.manager.getBranch().find(entry => entry.type === "custom" && entry.customType === CUSTOM_TYPE &&
        (entry.data as Receipt).owner === options.owner && (entry.data as Receipt).request_id === id);
      const previousId = requests.get(id) ?? (stored?.type === "custom" ? (stored.data as Receipt).session_id : undefined);
      if (previousId) { const job = jobs.get(previousId); return job ? wait(job, input.yield_time_ms ?? 250, signal) : result({ status: "error", code: "result_expired", error: "Command receipt exists but its retained result expired; it will not be replayed" }); }
      const ceiling = configuredCeiling === undefined ? ctx?.hasUI === true ? 1800 : 55 : Number(configuredCeiling);
      if (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > ceiling) return result({ status: "error", code: "invalid_timeout", error: `timeout must be >0 and <=${ceiling} seconds` });
      if (signal?.aborted) return result({ status: "error", code: "cancelled", error: "Command was cancelled before launch" });
      if (!Number.isInteger(input.yield_time_ms ?? 250) || (input.yield_time_ms ?? 250) < 0 || (input.yield_time_ms ?? 250) > MAX_YIELD_MS)
        return result({ status: "error", code: "invalid_yield", error: `yield_time_ms must be 0..${MAX_YIELD_MS}` });
      if ([...jobs.values()].filter(job => job.receipt.status === "running").length >= 16) return result({ status: "error", code: "session_limit", error: "At most 16 shell sessions may run in one thread" });
      while (jobs.size >= MAX_SESSIONS) {
        const old = [...jobs].find(([, job]) => job.receipt.status !== "running");
        if (!old) break;
        requests.delete(old[1].receipt.request_id); jobs.delete(old[0]);
      }
      const started = Date.now(), controller = new AbortController();
      const receipt: Receipt = { session_id: randomUUID(), request_id: id, owner: options.owner, started_at: started, deadline_at: started + input.timeout * 1000, status: "running" };
      const accumulator = new OutputAccumulator(), decoder = new TextDecoder();
      let finished = false, reporting = true, lastUpdate = 0;
      // Use only the native bounded text/tail path, never its optional raw-output spill path.
      const output: Accumulator = {
        append(data) { if (finished) throw new Error("Output appended after shell completion"); accumulator.appendDecodedText(decoder.decode(data, { stream: true })); },
        finish() { if (!finished) { accumulator.appendDecodedText(decoder.decode()); finished = true; } },
        snapshot() { return accumulator.snapshot(); },
      };
      const job: Job = { receipt, controller, output, done: Promise.resolve() };
      // Commit intent before launch. Losing this response cannot create a second execution.
      persist(receipt); jobs.set(receipt.session_id, job); requests.set(id, receipt.session_id);
      const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
      for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
      env.PI_SESSION_ID = options.manager.getSessionId(); env.PI_SESSION_FILE = options.manager.getSessionFile();
      if (ctx?.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
      if (ctx?.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
      job.done = options.execution.retainTool(async ownerSignal => {
        try {
          const completed = await backend.exec(input.command, options.cwd, { timeout: input.timeout,
            signal: AbortSignal.any([controller.signal, ownerSignal, ...(signal ? [signal] : [])]), env,
            onData: data => {
              job.output!.append(data);
              if (reporting && onUpdate && Date.now() - lastUpdate >= 100) {
                lastUpdate = Date.now();
                const snapshot = job.output!.snapshot();
                onUpdate({ content: [{ type: "text", text: snapshot.content }], details: view(job) });
              }
            }, onStdin: write => { job.write = write; } });
          if (completed.exitCode === null || !Number.isInteger(completed.exitCode)) throw new Error("Command terminated without a valid exit code");
          job.receipt = { ...receipt, status: "completed", exit_code: completed.exitCode, finished_at: Date.now() };
        } catch (error) {
          job.receipt = { ...receipt, status: "failed", finished_at: Date.now(), error: String(error instanceof Error ? error.message : error) };
          if (error instanceof Error && ["shell_cleanup_failed", "tool_cleanup_unconfirmed"].includes(String((error as Error & { code?: string }).code)))
            options.execution.cleanupUnconfirmed(error);
        }
        finally { job.output!.finish(); job.write = undefined; job.controller = undefined; persist(job.receipt); }
      });
      try { return await wait(job, input.yield_time_ms ?? 250, signal); }
      finally { reporting = false; }
    },
  }), defineTool({
    name: "bash_session", label: "bash session", description: "Inspect an existing shell session with a bounded 0..1000ms wait. Optional stdin text queues up to 64KB on its pipe (acceptance does not prove consumption); eof closes stdin. cancel stops this session and descendants. Output is the cumulative tail, not a delta. Running sessions remain owned by this thread until cleanup; do useful work instead of repeated empty polling. Unknown sessions/executor loss never launch a command.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1 }), yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_YIELD_MS })),
      stdin: Type.Optional(Type.String({ maxLength: 65536 })), eof: Type.Optional(Type.Boolean()), cancel: Type.Optional(Type.Boolean()) }),
    execute: async (id, input, signal) => {
      if (signal?.aborted) return result({ status: "error", code: "cancelled", error: "Shell action was cancelled before submission" });
      if (!Number.isInteger(input.yield_time_ms ?? 250) || (input.yield_time_ms ?? 250) < 0 || (input.yield_time_ms ?? 250) > MAX_YIELD_MS)
        return result({ status: "error", code: "invalid_yield", error: `yield_time_ms must be 0..${MAX_YIELD_MS}` });
      const job = jobs.get(input.session_id);
      if (!job) return result({ status: "error", code: "session_not_found", error: "Shell session does not belong to this thread/session or its result expired" });
      if (input.cancel && (input.stdin !== undefined || input.eof)) return result({ status: "error", code: "invalid_action", error: "cancel cannot be combined with stdin/eof" });
      if (input.cancel) job.controller?.abort();
      if (input.stdin !== undefined || input.eof) {
        if (!job.write) return result(job.receipt.status === "running"
          ? { status: "error", code: "stdin_not_ready", error: "Shell stdin is not ready; inspect the running session before submitting input" }
          : { status: "error", code: "stdin_unavailable", error: "Shell stdin is closed or its executor is unavailable" });
        const previous = options.manager.getBranch().find(entry => entry.type === "custom" && entry.customType === ACTION_TYPE &&
          (entry.data as { owner: string; request_id: string }).owner === options.owner && (entry.data as { request_id: string }).request_id === id);
        if (previous) return result({ status: "error", code: "stdin_already_submitted", session_id: input.session_id, error: "This stdin action was already submitted; consumption may be unknown. It will not be repeated." });
        options.manager.appendCustomEntry(ACTION_TYPE, { owner: options.owner, request_id: id, session_id: input.session_id, state: "submitted" });
        try { await job.write(input.stdin ?? "", input.eof === true); }
        catch (error) { return result({ status: "error", code: "stdin_failed", error: String(error) }); }
      }
      return wait(job, input.yield_time_ms ?? 250, signal, input.stdin !== undefined || input.eof === true);
    },
  })];
}
