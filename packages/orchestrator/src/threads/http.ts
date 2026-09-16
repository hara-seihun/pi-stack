import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Result, ThreadApi } from "./contracts.js";

const requestContext = new AsyncLocalStorage<{ deadline: number; signal: AbortSignal }>();
const deadlineHeader = "x-pi-thread-deadline";
const requestTimeout = 60_000;
export interface ThreadClientOptions { signal?: AbortSignal; timeoutMs?: number }
type ThreadFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const operations = ["spawn", "send", "list", "read", "control", "inspect", "command", "settlements", "await"] as const;
type Operation = typeof operations[number];
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

export async function threadHttp(api: ThreadApi, request: Request, prefix = "/v1/threads"): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${prefix}/`)) return undefined;
  const operation = path.slice(prefix.length + 1) as Operation;
  if (!operations.includes(operation)) return undefined;
  if (request.method !== "POST") return Response.json({ ok: false, error: { code: "invalid_request", message: "Use POST" } }, { status: 405 });
  let input: unknown;
  try { input = await request.json(); }
  catch { return Response.json({ ok: false, error: { code: "invalid_request", message: "Expected a JSON object" } }, { status: 400 }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Response.json({ ok: false, error: { code: "invalid_request", message: "Expected a JSON object" } }, { status: 400 });
  }
  try {
    const fields = input as Record<string, any>;
    const declaredDeadline = Number(request.headers.get(deadlineHeader));
    const deadline = Math.min(Date.now() + requestTimeout, declaredDeadline > 0 ? Math.floor(declaredDeadline) : Infinity);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    if (signal.aborted || deadline <= Date.now()) return Response.json(failure("Thread request deadline expired"), { status: 408 });
    const result = await requestContext.run({ deadline, signal }, () =>
      operation === "await" ? api.await(fields as Parameters<ThreadApi["await"]>[0], signal)
      : operation === "settlements" ? api.settlements(fields.after, fields.limit)
      : operation === "inspect" ? api.inspect(fields.threadId)
      : operation === "command" ? api.command(fields.threadId, fields.command)
      : (api[operation] as (input: unknown) => Promise<Result<unknown>>).call(api, input));
    return Response.json(result);
  } catch (error) {
    return Response.json(failure(error instanceof Error ? error.message : String(error)), { status: 503 });
  }
}

export function createThreadClient(baseUrl: string, fetcher: ThreadFetch = fetch, options: ThreadClientOptions = {}): ThreadApi {
  const base = baseUrl.replace(/\/$/, "");
  async function call<T>(operation: Operation, input: unknown, callSignal?: AbortSignal): Promise<Result<T>> {
    const body = JSON.stringify(input ?? {});
    const requestId = (operation === "send" || operation === "spawn") ? (input as { requestId?: string })?.requestId : undefined;
    const replayable = typeof requestId === "string" && !!requestId.trim() || ["list", "read", "inspect", "settlements"].includes(operation);
    const terminal = (value: Result<T>): Result<T> => value.ok ? value
      : { ok: false, error: { ...value.error, retryable: false, ...(requestId ? { requestId } : {}) } };
    const inherited = requestContext.getStore();
    const deadline = Math.min(Date.now() + (options.timeoutMs ?? requestTimeout), inherited?.deadline ?? Infinity);
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      ...(options.signal ? [options.signal] : []), ...(inherited ? [inherited.signal] : []), ...(callSignal ? [callSignal] : [])]);
    let lastError = "Thread owner did not acknowledge the request", attempt = 0;
    while (!signal.aborted && Date.now() < deadline) {
      let retry = false;
      try {
        const response = await fetcher(`${base}/${operation}`, { method: "POST",
          headers: { "content-type": "application/json", [deadlineHeader]: String(deadline) }, body, signal });
        if ([502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          lastError = `Thread owner returned HTTP ${response.status}`;
          retry = true;
        } else {
          const value = await response.json() as Result<T>;
          if (typeof value?.ok !== "boolean" || (!value.ok && (!value.error || typeof value.error.message !== "string"))) {
            return terminal(failure(`Thread owner returned an invalid response (${response.status}); acceptance is unconfirmed`));
          }
          if (!response.ok) return terminal(value.ok ? failure(`Thread owner returned HTTP ${response.status}`) : value);
          if (value.ok || !value.error.retryable) return terminal(value);
          lastError = value.error.message;
          retry = true;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        retry = !(error instanceof SyntaxError);
      }
      if (!replayable || !retry) break;
      try { await delay(Math.min(100 * 2 ** Math.min(attempt++, 4), 1_000, Math.max(0, deadline - Date.now())), undefined, { signal }); }
      catch { break; }
    }
    const reason = callSignal?.aborted || options.signal?.aborted || inherited?.signal.aborted && Date.now() < deadline ? "cancelled"
      : Date.now() >= deadline || signal.aborted ? "deadline expired" : "failed";
    return { ok: false, error: { code: "unavailable", retryable: false, ...(requestId ? { requestId } : {}),
      message: `Thread ${operation} ${reason}: ${lastError}.${requestId ? ` Acceptance is unconfirmed for request ${requestId}; reconcile this identity rather than issuing a new instruction.` : ""}` } };
  }
  return {
    spawn: input => call("spawn", input), send: input => call("send", input), list: input => call("list", input),
    read: input => call("read", input), control: input => call("control", input),
    inspect: threadId => call("inspect", { threadId }), command: (threadId, command) => call("command", { threadId, command }),
    settlements: (after, limit) => call("settlements", { after, limit }),
    await: (input, signal) => call("await", input, signal),
  };
}
