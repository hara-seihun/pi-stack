import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { validateInspectOptions, type Result, type ThreadApi } from "./contracts.js";
import { THREAD_TOKEN_HEADER, type AdmissionResult } from "./caller.js";

type ThreadRequestContext = { lifetime: "active" | "finished"; deadline: number; signal: AbortSignal };
const requestContext = new AsyncLocalStorage<ThreadRequestContext>();
const deadlineHeader = "x-pi-thread-deadline";
const requestTimeout = 60_000;
export interface ThreadClientOptions { signal?: AbortSignal; timeoutMs?: number; /** The calling thread's PI_THREAD_TOKEN. */ token?: string }
/** Checks and stamps a request with its verified caller before the owner sees it. */
export type ThreadAdmission = (operation: string, input: Record<string, any>) => Promise<AdmissionResult>;
type ThreadFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const operations = ["attention", "attentionEvents", "agentWait", "wakeSchedule", "watch", "ask", "questions", "pendingQuestions", "questionState", "questionEvents", "answer", "spawn", "send", "list", "read", "control", "inspect", "command", "settlements", "await", "archived"] as const;
type Operation = typeof operations[number];
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

export async function threadHttp(api: ThreadApi, request: Request, prefix = "/v1/threads", admit?: ThreadAdmission): Promise<Response | undefined> {
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
  if (admit) {
    const admitted = await admit(operation, input as Record<string, any>);
    if (!admitted.ok) return Response.json({ ok: false, error: { code: "invalid_request", message: admitted.message } }, { status: admitted.status });
    input = admitted.input;
  }
  try {
    const fields = input as Record<string, any>;
    const inspection = operation === "inspect" ? validateInspectOptions(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "threadId"))) : undefined;
    if (inspection && !inspection.ok) return Response.json(inspection, { status: 400 });
    const declaredDeadline = Number(request.headers.get(deadlineHeader));
    const deadline = Math.min(Date.now() + requestTimeout, declaredDeadline > 0 ? Math.floor(declaredDeadline) : Infinity);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    if (signal.aborted || deadline <= Date.now()) return Response.json(failure("Thread request deadline expired"), { status: 408 });
    const context: ThreadRequestContext = { lifetime: "active", deadline, signal };
    try {
      const result = await requestContext.run(context, () =>
        operation === "await" ? api.await(fields as Parameters<ThreadApi["await"]>[0], signal)
        : operation === "settlements" ? api.settlements(fields.after, fields.limit)
        : operation === "questionEvents" ? api.questionEvents(fields.after, fields.limit)
        : operation === "attentionEvents" ? api.attentionEvents(fields.after, fields.limit)
        : operation === "inspect" ? api.inspect(fields.threadId, inspection?.ok ? inspection.value : undefined)
        : operation === "questions" ? api.questions(fields.threadId)
        : operation === "questionState" ? api.questionState(fields.threadId, fields.questionId)
        : operation === "command" ? api.command(fields.threadId, fields.command)
        : (api[operation] as (input: unknown) => Promise<Result<unknown>>).call(api, input));
      return Response.json(result);
    } finally {
      // Async descendants retain this object after the response, not its request budget.
      context.lifetime = "finished";
    }
  } catch (error) {
    return Response.json(failure(error instanceof Error ? error.message : String(error)), { status: 503 });
  }
}

export function createThreadClient(baseUrl: string, fetcher: ThreadFetch = fetch, options: ThreadClientOptions = {}): ThreadApi {
  const base = baseUrl.replace(/\/$/, "");
  const diagnosticUrl = new URL(base);
  diagnosticUrl.username = "";
  diagnosticUrl.password = "";
  diagnosticUrl.search = "";
  diagnosticUrl.hash = "";
  const ownerEndpoint = diagnosticUrl.toString().replace(/\/$/, "");
  async function call<T>(operation: Operation, input: unknown, callSignal?: AbortSignal): Promise<Result<T>> {
    const body = JSON.stringify(input ?? {});
    const requestId = (["send", "spawn", "ask", "watch", "agentWait", "wakeSchedule", "attention"].includes(operation)) ? (input as { requestId?: string })?.requestId : undefined;
    const replayable = typeof requestId === "string" && !!requestId.trim() || ["list", "archived", "read", "inspect", "questions", "pendingQuestions", "questionState", "questionEvents", "attentionEvents", "answer", "settlements"].includes(operation) || ["watch", "wakeSchedule"].includes(operation) && (input as { action?: string })?.action === "list";
    const terminal = (value: Result<T>): Result<T> => value.ok ? value
      : { ok: false, error: { ...value.error, retryable: false, ...(requestId ? { requestId } : {}) } };
    const context = requestContext.getStore();
    const inherited = context?.lifetime === "active" ? context : undefined;
    const deadline = Math.min(Date.now() + (options.timeoutMs ?? requestTimeout), inherited?.deadline ?? Infinity);
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      ...(options.signal ? [options.signal] : []), ...(inherited ? [inherited.signal] : []), ...(callSignal ? [callSignal] : [])]);
    let lastError = "Request ended before contacting the owner", attempt = 0;
    while (!signal.aborted && Date.now() < deadline) {
      let retry = false;
      try {
        const response = await fetcher(`${base}/${operation}`, { method: "POST",
          headers: { "content-type": "application/json", [deadlineHeader]: String(deadline), ...(options.token ? { [THREAD_TOKEN_HEADER]: options.token } : {}) }, body, signal });
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
      message: `Thread ${operation} ${reason} at ${ownerEndpoint}/${operation}: ${lastError}.${requestId ? ` Acceptance is unconfirmed for request ${requestId}; reconcile this identity rather than issuing a new instruction.` : ""}` } };
  }
  return {
    attention: input => call("attention", input),
    attentionEvents: (after, limit) => call("attentionEvents", { after, limit }),
    agentWait: input => call("agentWait", input),
    wakeSchedule: input => call("wakeSchedule", input),
    watch: input => call("watch", input),
    ask: input => call("ask", input), questions: threadId => call("questions", { threadId }), answer: input => call("answer", input),
    questionState: (threadId, questionId) => call("questionState", { threadId, questionId }),
    pendingQuestions: input => call("pendingQuestions", input),
    spawn: input => call("spawn", input), send: input => call("send", input), list: input => call("list", input), archived: input => call("archived", input),
    read: input => call("read", input), control: input => call("control", input),
    inspect: (threadId, inspection) => call("inspect", { threadId, ...inspection }), command: (threadId, command) => call("command", { threadId, command }),
    settlements: (after, limit) => call("settlements", { after, limit }),
    questionEvents: (after, limit) => call("questionEvents", { after, limit }),
    await: (input, signal) => call("await", input, signal),
  };
}
