import { isDeepStrictEqual } from "node:util";
import { admitManagerPolicyRead, authority, bindings, boundedBody, protectedRead, secret, type ManagerPolicyBinding, type Result } from "./canonical-manager-policy";
import { validateManagerWorkSummary } from "../../../packages/orchestrator/src/threads/manager-watchdog";

export const MANAGER_CONTEXT_PATH = "/v1/canonical-manager-context";
export const MANAGER_CONTEXT_BYTES = 1024 * 1024;
const header = "x-pi-canonical-manager-policy";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 256;
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const time = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const bad = (message: string): Result<never> => ({ ok: false, error: { code: "forbidden", message } });
export type ContextOperation = "managerWorkSummary" | "questionOrigin" | "managerQuestionCustody";
type ContextRequest = { operation: ContextOperation; input: Record<string, unknown>; destination: "source" | "target" };
export type ManagerContextCapability = { version: 1; purpose: "canonical-work-context"; binding: ManagerPolicyBinding; sourceOrigin: string };
export function managerContextCapability(binding: ManagerPolicyBinding, sourceOrigin: string): Result<ManagerContextCapability> {
  try {
    const url = new URL(sourceOrigin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== sourceOrigin || url.username || url.password || url.pathname !== "/" || url.search || url.hash || sourceOrigin === binding.origin)
      return bad("Explicit distinct reciprocal loopback origin required");
    return { ok: true, value: { version: 1, purpose: "canonical-work-context", binding, sourceOrigin } };
  } catch { return bad("Reciprocal loopback origin is invalid"); }
}
export function validateManagerContext(operation: unknown, input: unknown, binding: ManagerPolicyBinding): Result<ContextRequest> {
  if (!object(input)) return bad("Exact bounded work-context input required");
  if (operation === "managerWorkSummary" && exact(input, [])) return { ok: true, value: { operation, input, destination: "source" } };
  if (operation === "questionOrigin" && exact(input, ["threadId"]) && id(input.threadId) && input.threadId !== binding.target.managerThreadId)
    return { ok: true, value: { operation, input, destination: "source" } };
  if (operation !== "managerQuestionCustody" || !id(input.requestId) || !id(input.threadId)) return bad("Only work summary and native question custody are enrolled");
  if (input.action === "receive" && exact(input, ["action", "threadId", "requestId", "originThreadId", "questions", "deadlineAt"])
      && input.threadId === binding.target.managerThreadId && id(input.originThreadId) && input.originThreadId !== input.threadId
      && time(input.deadlineAt) && Array.isArray(input.questions) && input.questions.length > 0
      && new Set(input.questions.map(q => object(q) ? q.id : null)).size === input.questions.length
      && input.questions.every(q => object(q) && exact(q, ["id", "threadId", "question", "suggestions", "createdAt"], ["recommendedSuggestionId"])
        && id(q.id) && q.threadId === input.originThreadId && text(q.question) && time(q.createdAt) && Array.isArray(q.suggestions)
        && q.suggestions.every(s => object(s) && exact(s, ["id", "text"]) && id(s.id) && text(s.text))
        && new Set(q.suggestions.map(s => s.id)).size === q.suggestions.length
        && (q.recommendedSuggestionId === undefined || q.suggestions.some(s => s.id === q.recommendedSuggestionId))))
    return { ok: true, value: { operation, input, destination: "target" } };
  if (input.action === "answer" && exact(input, ["action", "threadId", "requestId", "originThreadId", "answer"])
      && input.threadId === binding.target.managerThreadId && id(input.originThreadId) && input.originThreadId !== input.threadId
      && object(input.answer) && exact(input.answer, ["threadId", "questionId", "selectedSuggestionIds", "text"], ["dismissed", "humanActivity"])
      && input.answer.threadId === input.originThreadId && validAnswer(input.answer) && id(input.answer.questionId))
    return { ok: true, value: { operation, input, destination: "target" } };
  if (input.action === "transition" && exact(input, ["action", "threadId", "requestId", "managerId", "questionId", "transition"])
      && input.managerId === binding.target.managerThreadId && input.threadId !== input.managerId && id(input.questionId) && object(input.transition)) {
    const t = input.transition;
    if (t.state === "forwarded" && exact(t, ["state", "forwardedQuestionId"]) && id(t.forwardedQuestionId)
        || t.state === "answered" && exact(t, ["state", "answer"]) && object(t.answer)
          && exact(t.answer, ["selectedSuggestionIds", "text"], ["dismissed", "answeredBy"]) && validAnswer(t.answer)
          && (t.answer.answeredBy === undefined || object(t.answer.answeredBy) && exact(t.answer.answeredBy, ["kind", "threadId"])
            && t.answer.answeredBy.kind === "manager" && t.answer.answeredBy.threadId === input.managerId))
      return { ok: true, value: { operation, input, destination: "source" } };
  }
  return bad("Question action, origin or canonical manager identity disagrees");
}
function validAnswer(v: Record<string, unknown>) {
  return typeof v.text === "string" && Array.isArray(v.selectedSuggestionIds) && v.selectedSuggestionIds.every(id)
    && new Set(v.selectedSuggestionIds).size === v.selectedSuggestionIds.length && (v.dismissed === undefined || typeof v.dismissed === "boolean")
    && (v.humanActivity === undefined || typeof v.humanActivity === "boolean");
}
export function validateManagerContextResponse(value: unknown, request: ContextRequest): Result<unknown> {
  if (object(value) && value.ok === false && object(value.error) && typeof value.error.message === "string")
    return { ok: false, error: { code: "unavailable", message: value.error.message.slice(0, 512) } };
  if (!object(value) || !exact(value, ["ok", "value"]) || value.ok !== true || !object(value.value)) return bad("Work-context result is invalid; custody acceptance unconfirmed");
  const v = value.value;
  if (request.operation === "managerWorkSummary" && validateManagerWorkSummary(v)) return { ok: true, value: v };
  if (request.operation === "questionOrigin" && exact(v, ["id", "title"], ["agentName"]) && v.id === request.input.threadId && typeof v.title === "string" && v.title.length <= 4096
      && (v.agentName === undefined || typeof v.agentName === "string" && v.agentName.length <= 4096)) return { ok: true, value: v };
  if (request.operation === "managerQuestionCustody" && exact(v, ["accepted"]) && v.accepted === true) return { ok: true, value: { accepted: true } };
  return bad("Only exact work metadata or native custody acceptance may leave this route");
}
function capability(binding: ManagerPolicyBinding): Result<ManagerContextCapability> {
  const current = authority(binding); if (!current.ok) return current;
  try {
    const raw = JSON.parse(protectedRead(`/etc/pi-stack/manager-policy/${binding.id}/context.json`));
    const parsed = managerContextCapability(binding, raw.sourceOrigin);
    return parsed.ok && isDeepStrictEqual(raw, parsed.value) ? parsed : bad("Work-context capability differs from original enrolled identity");
  } catch { return bad("Explicit reciprocal work-context enrollment required"); }
}
export function admitManagerContext(envelope: unknown, presented: string | null, binding: ManagerPolicyBinding, localEnvironment: string): Result<ContextRequest> {
  if (!object(envelope) || !exact(envelope, ["version", "id", "source", "target", "operation", "input"])) return bad("Exact enrolled work-context envelope required");
  const { operation, input, ...identities } = envelope;
  const authenticated = admitManagerPolicyRead(identities, presented, { ...binding, direction: "incoming" }, binding.target.environment);
  if (!authenticated.ok) return authenticated;
  const parsed = validateManagerContext(operation, input, binding); if (!parsed.ok) return parsed;
  const receiver = parsed.value.destination === "source" ? binding.source : binding.target;
  const direction = parsed.value.destination === "source" ? "outgoing" : "incoming";
  return localEnvironment === receiver.environment && binding.direction === direction ? parsed : bad("Work-context action is not authorized in this direction");
}
export async function outgoingManagerContext(user: string, uid: number, localEnvironment: string, targetEnvironment: string, operation: string, input: unknown, signal: AbortSignal): Promise<Response | undefined> {
  if (!["managerWorkSummary", "questionOrigin", "managerQuestionCustody"].includes(operation)) return undefined;
  const configured = bindings(); if (!configured.ok) return Response.json(configured, { status: 503 });
  const selected = configured.value.filter(b => {
    const local = b.direction === "outgoing" ? b.source : b.target, peer = b.direction === "outgoing" ? b.target : b.source;
    return local.user === user && local.uid === uid && local.environment === localEnvironment && peer.environment === targetEnvironment;
  });
  if (!selected.length) return undefined;
  if (selected.length !== 1) return Response.json(bad("Ambiguous enrolled work-context route"), { status: 403 });
  const binding = selected[0]!, parsed = validateManagerContext(operation, input, binding);
  if (!parsed.ok) return Response.json(parsed, { status: 400 });
  if ((parsed.value.destination === "source" ? "incoming" : "outgoing") !== binding.direction) return Response.json(bad("Work-context caller is on the wrong side of custody"), { status: 403 });
  const enrolled = capability(binding); if (!enrolled.ok) return Response.json(enrolled, { status: 403 });
  const token = secret(binding); if (!token.ok) return Response.json(token, { status: 503 });
  const origin = parsed.value.destination === "source" ? enrolled.value.sourceOrigin : binding.origin;
  try {
    const response = await fetch(`${origin}${MANAGER_CONTEXT_PATH}`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", [header]: token.value },
      body: JSON.stringify({ version: 1, id: binding.id, source: binding.source, target: binding.target, operation, input: parsed.value.input }), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    const result = validateManagerContextResponse(JSON.parse(await boundedBody(response.body, MANAGER_CONTEXT_BYTES)), parsed.value);
    return Response.json(response.ok ? result : { ok: false, error: { code: "unavailable", message: `Work-context transport returned HTTP ${response.status}; retain original request identity` } }, { status: response.ok && result.ok ? 200 : 503 });
  } catch { return Response.json({ ok: false, error: { code: "unavailable", message: "Work-context transport unconfirmed; retain original question request identity" } }, { status: 503 }); }
}
export async function incomingManagerContext(request: Request, localEnvironment: string, person: (user: string) => { user: string; port: number } | undefined,
  project: (owner: { user: string; port: number }, operation: ContextOperation, input: Record<string, unknown>, originEnvironment: string, signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== MANAGER_CONTEXT_PATH || url.search) return Response.json(bad("Only exact enrolled work context is admitted"), { status: 403 });
  const configured = bindings(); if (!configured.ok) return Response.json(configured, { status: 503 });
  let envelope: unknown;
  try { envelope = JSON.parse(await boundedBody(request.body, MANAGER_CONTEXT_BYTES)); }
  catch { return Response.json(bad("Bounded work-context JSON required"), { status: 400 }); }
  const selected = configured.value.filter(b => object(envelope) && b.id === envelope.id);
  if (selected.length !== 1) return Response.json(bad("No unique enrolled work-context route"), { status: 403 });
  const binding = selected[0]!, admitted = admitManagerContext(envelope, request.headers.get(header), binding, localEnvironment);
  if (!admitted.ok) return Response.json(admitted, { status: 403 });
  const enrolled = capability(binding); if (!enrolled.ok) return Response.json(enrolled, { status: 403 });
  const owner = person((admitted.value.destination === "source" ? binding.source : binding.target).user);
  if (!owner) return Response.json(bad("Enrolled same-person work owner unavailable"), { status: 503 });
  try {
    const originEnvironment = admitted.value.destination === "source" ? binding.target.environment : binding.source.environment;
    const response = await project(owner, admitted.value.operation, admitted.value.input, originEnvironment, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]));
    const result = validateManagerContextResponse(JSON.parse(await boundedBody(response.body, MANAGER_CONTEXT_BYTES)), admitted.value);
    return Response.json(response.ok ? result : { ok: false, error: { code: "unavailable", message: `Native work-context owner returned HTTP ${response.status}; retain original request identity` } }, { status: response.ok && result.ok ? 200 : 503 });
  } catch { return Response.json({ ok: false, error: { code: "unavailable", message: "Native work-context projection unconfirmed; retain original question request identity" } }, { status: 503 }); }
}
