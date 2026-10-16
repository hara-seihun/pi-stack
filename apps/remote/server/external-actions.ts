import { readFileSync } from "node:fs";
import { actionRequest, type ActionAuthority } from "kenan-memory/actions";
import type { ThreadCaller } from "pi-orchestrator/api";
import { sameToken } from "./phone/dispatcher";

export type ExternalActionCaller =
  | { kind: "denied" }
  | { kind: "operator" }
  | { kind: "thread"; threadId: string; managing: boolean }
  | { kind: "runtime" };

export function externalActionCaller(caller: ThreadCaller | { error: string }, ownerUid: number, managerThreadId: string | null, phone: boolean): ExternalActionCaller {
  if (phone) return { kind: "operator" };
  if ("error" in caller) return { kind: "denied" };
  switch (caller.kind) {
    case "thread": return { kind: "thread", threadId: caller.threadId, managing: caller.threadId === managerThreadId };
    case "person": return { kind: "operator" };
    case "process": return { kind: caller.uid === ownerUid ? "operator" : "denied" };
    case "runtime":
    case "service": return { kind: "runtime" };
  }
}

export function ownedPhoneActionCaller(req: Request, owner: string, loopback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!loopback) return false;
  try {
    const config = JSON.parse(readFileSync(env.PI_STACK_PHONE_CONFIG ?? "/etc/pi-stack/phone.json", "utf8"));
    const token = readFileSync(config.adminTokenFile, "utf8").trim();
    return config.owner === owner && token.length >= 32 && sameToken(req.headers.get("authorization"), `Bearer ${token}`);
  } catch { return false; }
}
export async function externalActionsEndpoint(req: Request, authority: ActionAuthority | null, caller: ExternalActionCaller): Promise<Response> {
  const reject = (message: string, status: number, error: "invalid-input" | "unavailable") => Response.json({ ok: false, error, message }, { status });
  if (caller.kind === "denied") return reject("External actions require this owner's authenticated local caller", 403, "unavailable");
  if (!authority) return reject("Canonical encrypted owner action authority is unavailable; no dispatch permitted", 503, "unavailable");
  if (req.method !== "POST") return reject("POST action operation required", 405, "invalid-input");
  if (Number(req.headers.get("content-length")) > 2_100_000) return reject("Action request too large", 413, "invalid-input");
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > 2_100_000) return reject("Action request too large", 413, "invalid-input");
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.operation !== "string" || Object.keys(body).some(key => key !== "operation" && key !== "input")) return reject("Expected exact action operation/input envelope", 400, "invalid-input");
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) return reject("Action input must be an object", 400, "invalid-input");
    const canReconcile = caller.kind === "operator" || caller.kind === "thread" && caller.managing;
    if (["reconcile", "retry", "followup", "recover", "release-recipient"].includes(body.operation) && !canReconcile) {
      if (body.operation !== "reconcile" || body.input.decision !== "resolve-purpose" || caller.kind !== "thread") return reject("Releasing/reconciling contact requires the authenticated managing thread, owning operator or granted transport owner; actor text supplies no authority", 403, "unavailable");
      if (typeof body.input.id !== "string") return reject("Purpose resolution requires an action identity", 400, "invalid-input");
      const current = authority.inspect(body.input.id);
      if (!current.ok) return Response.json(current, { status: current.error === "unavailable" ? 503 : 409 });
      if (current.value.submittingThreadId !== caller.threadId || current.value.state !== "succeeded") return reject("A worker may resolve only its own provider-confirmed succeeded action; active, uncertain and other workers' actions remain fenced", 403, "unavailable");
    }
    const stamp = (input: Record<string, unknown>) => ({ ...input,
      ...(caller.kind === "thread" ? { threadId: caller.threadId } : {}),
      authenticatedThreadId: caller.kind === "thread" ? caller.threadId : null,
    });
    if (body.operation === "submit") body.input = stamp(body.input);
    if (body.operation === "followup" && body.input.input && typeof body.input.input === "object" && !Array.isArray(body.input.input)) body.input.input = stamp(body.input.input);
    if (caller.kind === "thread" && "actor" in body.input) body.input.actor = caller.threadId;
    const result = actionRequest(authority, body.operation, body.input);
    return Response.json(result, { status: result.ok ? 200 : result.error === "unavailable" ? 503 : 409 });
  } catch { return reject("Invalid action request; no dispatch permitted", 400, "invalid-input"); }
}
