import { readFileSync } from "node:fs";
import { actionRequest, type ActionAuthority } from "kenan-memory/actions";
import { sameToken } from "./phone/dispatcher";

export function ownedPhoneActionCaller(req: Request, owner: string, loopback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!loopback) return false;
  try {
    const config = JSON.parse(readFileSync(env.PI_STACK_PHONE_CONFIG ?? "/etc/pi-stack/phone.json", "utf8"));
    const token = readFileSync(config.adminTokenFile, "utf8").trim();
    return config.owner === owner && token.length >= 32 && sameToken(req.headers.get("authorization"), `Bearer ${token}`);
  } catch { return false; }
}
export async function externalActionsEndpoint(req: Request, authority: ActionAuthority | null, authorized: boolean, canReconcile = false): Promise<Response> {
  const reject = (message: string, status: number, error: "invalid-input" | "unavailable") => Response.json({ ok: false, error, message }, { status });
  if (!authorized) return reject("External actions require this owner's authenticated local caller", 403, "unavailable");
  if (!authority) return reject("Canonical encrypted owner action authority is unavailable; no dispatch permitted", 503, "unavailable");
  if (req.method !== "POST") return reject("POST action operation required", 405, "invalid-input");
  if (Number(req.headers.get("content-length")) > 2_100_000) return reject("Action request too large", 413, "invalid-input");
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 2_100_000) return reject("Action request too large", 413, "invalid-input");
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.operation !== "string" || Object.keys(body).some(key => key !== "operation" && key !== "input")) return reject("Expected exact action operation/input envelope", 400, "invalid-input");
    if (["reconcile", "retry", "followup", "recover", "release-recipient"].includes(body.operation) && !canReconcile) return reject("Releasing/reconciling contact requires the authenticated managing thread, owning operator or granted transport owner; actor text supplies no authority", 403, "unavailable");
    const result = actionRequest(authority, body.operation, body.input);
    return Response.json(result, { status: result.ok ? 200 : result.error === "unavailable" ? 503 : 409 });
  } catch { return reject("Invalid action request; no dispatch permitted", 400, "invalid-input"); }
}
