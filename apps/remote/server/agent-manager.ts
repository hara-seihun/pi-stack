import { combineManagerWork, validateManagerWorkSummary, type ManagerWorkSummary, type Result } from "pi-orchestrator/api";
import type { Person } from "./persons";
import type { EnvironmentEndpoint } from "./environments";

const operations = new Set(["managerNotificationPolicy", "managerWorkSummary", "send", "questionOrigin", "managerQuestionCustody", "managerReplies"]);
const summaryTimeoutMs = 5_000;
const summaryFailure = (environment: string, reason: string): Result<never> => ({ ok: false,
  error: { code: "unavailable", message: `Environment ${environment} work summary unavailable: ${reason}` } });

async function readSummary(response: Response, environment: string, signal: AbortSignal): Promise<Result<ManagerWorkSummary>> {
  if (signal.aborted) {
    await response.body?.cancel();
    return summaryFailure(environment, "request cancelled or deadline expired");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return summaryFailure(environment, `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) return summaryFailure(environment, "empty response");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return summaryFailure(environment, "response exceeds metadata limit");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (result && typeof result === "object" && !Array.isArray(result) && "ok" in result) {
      if (result.ok === true && "value" in result && Object.keys(result).length === 2 && validateManagerWorkSummary(result.value))
        return { ok: true, value: result.value };
      if (result.ok === false && "error" in result && result.error && typeof result.error === "object" && "message" in result.error && typeof result.error.message === "string")
        return summaryFailure(environment, result.error.message.slice(0, 512));
    }
    return summaryFailure(environment, "invalid metadata response");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function boundedSummary(environment: string, signal: AbortSignal, request: () => Promise<Response>): Promise<Result<ManagerWorkSummary>> {
  if (signal.aborted) return summaryFailure(environment, "request cancelled or deadline expired");
  let abort: () => void;
  const cancelled = new Promise<Result<never>>(resolve => {
    abort = () => resolve(summaryFailure(environment, "request cancelled or deadline expired"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      try { return await readSummary(await request(), environment, signal); }
      catch { return summaryFailure(environment, "transport or response failure"); }
    })()]);
  } finally { signal.removeEventListener("abort", abort!); }
}
export async function handleAgentManager(req: Request, peer: { uid: number } | undefined,
  people: ReadonlyMap<number, string>, person: (user: string) => Person | undefined,
  endpoints: (user: string) => readonly EnvironmentEndpoint[], localEnvironment: string,
  proxy: (person: Person, origin: string, req: Request, target: URL, upstream: string | undefined, sourceEnvironment: string) => Promise<Response>): Promise<Response> {
  const actor = peer && people.get(peer.uid);
  const owner = actor ? person(actor) : undefined;
  if (!owner) return Response.json({ ok: false, error: { code: "unavailable", message: "Manager relay requires your own registered Unix identity" } }, { status: 403 });
  const operation = new URL(req.url).pathname.slice("/v1/agent-manager/".length);
  if (req.method !== "POST" || !operations.has(operation)) return Response.json({ ok: false, error: { code: "invalid_request", message: "Manager relay permits only policy read and durable notice delivery" } }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || !body.input || typeof body.input !== "object" || Array.isArray(body.input)
    || Object.keys(body).some(key => !["input", "environmentId"].includes(key))) return Response.json({ ok: false, error: { code: "invalid_request", message: "Expected a manager relay envelope" } }, { status: 400 });
  if (operation === "managerWorkSummary") {
    if (body.environmentId !== undefined || Object.keys(body.input).length !== 0)
      return Response.json({ ok: false, error: { code: "invalid_request", message: "Work summary requires all granted environments and an empty input" } }, { status: 400 });
    const granted = endpoints(owner.user);
    if (!granted.length) return Response.json(summaryFailure(localEnvironment, "account has no granted environments"), { status: 503 });
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(summaryTimeoutMs)]);
    const results = await Promise.all(granted.map(endpoint => {
      const origin = endpoint.id === localEnvironment ? `http://127.0.0.1:${owner.port}` : endpoint.upstreams?.[owner.user];
      if (!origin) return Promise.resolve(summaryFailure(endpoint.id, "granted endpoint has no account upstream"));
      return boundedSummary(endpoint.id, signal, () => {
        const target = new URL("/v1/manager-relay/managerWorkSummary", origin);
        const forwarded = new Request(req.url, { method: "POST", signal, headers: { "content-type": "application/json" }, body: "{}" });
        return proxy(owner, origin, forwarded, target, endpoint.id === localEnvironment ? undefined : endpoint.id, localEnvironment);
      });
    }));
    const summaries: ManagerWorkSummary[] = [];
    for (const result of results) {
      if (!result.ok) return Response.json(result, { status: 503 });
      summaries.push(result.value);
    }
    return Response.json({ ok: true, value: combineManagerWork(summaries) });
  }
  const environment = body.environmentId === undefined
    ? owner.environment.PI_REMOTE_MANAGER_ENVIRONMENT === undefined ? localEnvironment : owner.environment.PI_REMOTE_MANAGER_ENVIRONMENT : body.environmentId;
  if (typeof environment !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(environment)) return Response.json({ ok: false, error: { code: "invalid_request", message: "Canonical manager environment is invalid" } }, { status: 503 });
  const endpoint = endpoints(owner.user).find(item => item.id === environment);
  const origin = environment === localEnvironment ? `http://127.0.0.1:${owner.port}` : endpoint?.upstreams?.[owner.user];
  if (!endpoint || !origin) return Response.json({ ok: false, error: { code: "unavailable", message: "Canonical manager environment is not granted to this account" } }, { status: 503 });
  const target = new URL(`/v1/manager-relay/${operation}`, origin);
  const forwarded = new Request(req.url, { method: req.method, signal: req.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body.input) });
  return proxy(owner, origin, forwarded, target, environment === localEnvironment ? undefined : environment, localEnvironment);
}
