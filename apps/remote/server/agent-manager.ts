import type { Person } from "./persons";
import type { EnvironmentEndpoint } from "./environments";

const operations = new Set(["managerNotificationPolicy", "send", "questionOrigin", "managerQuestionCustody"]);
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
