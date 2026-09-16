import type { Result, ThreadApi } from "./contracts.js";

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
    const result = operation === "await" ? await api.await(fields as Parameters<ThreadApi["await"]>[0], request.signal)
      : operation === "settlements" ? await api.settlements(fields.after, fields.limit)
      : operation === "inspect" ? await api.inspect(fields.threadId)
      : operation === "command" ? await api.command(fields.threadId, fields.command)
      : await (api[operation] as (input: unknown) => Promise<Result<unknown>>).call(api, input);
    return Response.json(result);
  } catch (error) {
    return Response.json(failure(error instanceof Error ? error.message : String(error)), { status: 503 });
  }
}

export function createThreadClient(baseUrl: string, fetcher: typeof fetch = fetch): ThreadApi {
  const base = baseUrl.replace(/\/$/, "");
  async function call<T>(operation: Operation, input: unknown, signal?: AbortSignal): Promise<Result<T>> {
    try {
      const response = await fetcher(`${base}/${operation}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
      const value = await response.json() as Result<T>;
      if (typeof value?.ok !== "boolean" || (!value.ok && (!value.error || typeof value.error.message !== "string"))) {
        return failure(`Thread owner returned an invalid response (${response.status})`);
      }
      if (!response.ok && value.ok) return failure(`Thread owner returned HTTP ${response.status}`);
      return value;
    } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  }
  return {
    spawn: input => call("spawn", input), send: input => call("send", input), list: input => call("list", input),
    read: input => call("read", input), control: input => call("control", input),
    inspect: threadId => call("inspect", { threadId }), command: (threadId, command) => call("command", { threadId, command }),
    settlements: (after, limit) => call("settlements", { after, limit }),
    await: (input, signal) => call("await", input, signal),
  };
}
