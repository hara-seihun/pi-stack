import { createHash, timingSafeEqual } from "node:crypto";
import { ActionStore } from "kenan-memory/actions";
import { ActionHttpClient } from "kenan-memory/action-http-client";
import { workActionRequest } from "kenan-memory/work-actions";
import { readWorkActionsConfig, type WorkActionsConfigResult } from "./work-action-routing";

const reject = (status: number, message: string) => Response.json({ ok: false, error: "unavailable", message }, { status });
const denied = () => reject(403, "Work action capability is unavailable for this owner");
async function envelope(req: Request): Promise<{ operation: string; input: unknown } | null> {
  if (req.method !== "POST" || Number(req.headers.get("content-length")) > 2_100_000) return null;
  const text = await req.text();
  if (Buffer.byteLength(text) > 2_100_000) return null;
  const body = JSON.parse(text);
  return body && typeof body === "object" && !Array.isArray(body) && typeof body.operation === "string" && Object.keys(body).every(key => key === "operation" || key === "input") ? body : null;
}
export async function workActionsEndpoint(req: Request, authority: ActionStore | null, owner: string, config: WorkActionsConfigResult = readWorkActionsConfig()): Promise<Response> {
  const capability = req.headers.get("x-pi-work-action-capability");
  if (!capability || capability.length < 32 || capability.length > 1000 || config.state !== "ready" || !authority || authority.owner !== owner) return denied();
  const hash = createHash("sha256").update(capability).digest();
  const grant = config.config.grants.find(candidate => candidate.owner === owner && timingSafeEqual(Buffer.from(candidate.capabilitySha256, "hex"), hash));
  if (!grant) return denied();
  try {
    const body = await envelope(req);
    if (!body) return reject(400, "Invalid work action envelope");
    const result = workActionRequest(authority, `${grant.sourceEnvironment}:${grant.scope}`, body.operation, body.input);
    return Response.json(result, { status: result.ok ? 200 : result.error === "unavailable" ? 503 : 409 });
  } catch { return reject(400, "Invalid work action envelope"); }
}

/** Work sessions use the account-bound router; no personal endpoint/token or local ledger is selected. */
export async function proxyOwnWorkActions(req: Request, authorized: boolean, user: string, config: WorkActionsConfigResult = readWorkActionsConfig(), env: NodeJS.ProcessEnv = process.env): Promise<Response | null> {
  if (config.state === "unset" || config.state === "ready" && !Object.hasOwn(config.config.routes, user)) return null;
  if (!authorized) return denied();
  if (config.state !== "ready") return reject(503, "Work action configuration unavailable; no local ledger fallback");
  try {
    const body = await envelope(req);
    if (!body) return reject(400, "Invalid work action envelope");
    const result = await new ActionHttpClient({ PI_REMOTE_ROUTER_PORT: env.PI_REMOTE_ROUTER_PORT ?? "8788" }).request(body.operation, body.input);
    return Response.json(result, { status: result.ok ? 200 : result.error === "unavailable" ? 503 : 409 });
  } catch { return reject(503, "Work action route unavailable; no dispatch permitted"); }
}
