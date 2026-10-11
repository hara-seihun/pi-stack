import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { authorize, type PermissionPolicy, type Principal, type Resource } from "pi-orchestrator/permissions";

export const MANAGER_POLICY_PATH = "/v1/canonical-manager-policy";
export const MANAGER_NOTICE_PATH = "/v1/canonical-manager-notice";
export const MANAGER_NOTICE_BYTES = 1024 * 1024;
const TOKEN_HEADER = "x-pi-canonical-manager-policy";
const STORE = "/etc/pi-stack/canonical-manager-policy.json";
type Identity = { host: string; environment: string; scopeId: string; user: string; uid: number };
export type ManagerPolicyBinding = { version: 1; id: string; direction: "incoming" | "outgoing"; source: Identity; target: Identity & { managerThreadId: string }; origin: string; credentialSha256: string; credentialFile: string };
type Failure = { ok: false; error: { code: "unavailable" | "forbidden" | "invalid_request" | "conflict"; message: string } };
export type Result<T> = { ok: true; value: T } | Failure;
const bad = (code: Failure["error"]["code"], message: string): Failure => ({ ok: false, error: { code, message } });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const atom = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
function identity(v: unknown, target: boolean): v is Identity & { managerThreadId?: string } {
  return object(v) && keys(v, ["host", "environment", "scopeId", "user", "uid", ...(target ? ["managerThreadId"] : [])]) && atom(v.host) && atom(v.environment) && atom(v.user)
    && v.scopeId === `remote:${v.user}` && Number.isSafeInteger(v.uid) && Number(v.uid) >= 0 && (!target || atom(v.managerThreadId));
}
export function parseManagerPolicyBinding(v: unknown): Result<ManagerPolicyBinding> {
  if (!object(v) || !keys(v, ["version", "id", "direction", "source", "target", "origin", "credentialSha256", "credentialFile"]) || v.version !== 1 || !atom(v.id)
      || !["incoming", "outgoing"].includes(String(v.direction)) || !identity(v.source, false) || !identity(v.target, true) || v.source.user !== v.target.user
      || v.source.host === v.target.host || v.source.environment === v.target.environment || typeof v.origin !== "string" || typeof v.credentialSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.credentialSha256)
      || v.credentialFile !== `/etc/pi-stack/manager-policy/${v.id}/token`) return bad("invalid_request", "Exact manager-policy binding required");
  try {
    const url = new URL(v.origin);
    if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== v.origin) return bad("invalid_request", "Manager-policy target must be an exact private HTTP origin");
  } catch { return bad("invalid_request", "Manager-policy origin is invalid"); }
  return { ok: true, value: v as unknown as ManagerPolicyBinding };
}
export function managerPolicyAuthority(core: unknown, binding: ManagerPolicyBinding): Result<void> {
  if (!object(core) || !Array.isArray(core.scopes) || !Array.isArray(core.principals) || !object(core.policy)) return bad("unavailable", "Core manager authority is unavailable");
  const local = binding.direction === "outgoing" ? binding.source : binding.target;
  const scope = core.scopes.find(s => object(s) && s.id === local.scopeId);
  if (!object(scope) || scope.principalId !== local.user || !object(scope.custody) || scope.custody.uid !== local.uid || !object(scope.managerRouting) || scope.managerRouting.kind !== "configured" || !object(scope.managerRouting.relay)) return bad("forbidden", "Manager-policy scope identity disagrees with Core custody");
  const relay = scope.managerRouting.relay;
  if (relay.scopeId !== local.scopeId || relay.environmentId !== local.environment || !object(relay.canonicalManager) || relay.canonicalManager.environmentId !== binding.target.environment || relay.canonicalManager.threadId !== binding.target.managerThreadId) return bad("conflict", "Canonical manager identity changed");
  const principal = core.principals.find(p => object(p) && p.id === local.user);
  const peer = Array.isArray(relay.remoteEnvironments) ? relay.remoteEnvironments.find(e => object(e) && e.id === binding.target.environment) : undefined;
  const resource = binding.direction === "outgoing" ? object(peer) ? peer.resource : undefined : scope.resource;
  if (!object(principal) || principal.kind !== "person" || principal.person !== local.user || !object(resource) || resource.owner !== local.user || resource.id !== `scope:${binding.target.scopeId}`) return bad("forbidden", "Core has no matching canonical-manager grant");
  const granted = authorize(core.policy as unknown as PermissionPolicy, { principal: principal as unknown as Principal, resource: resource as unknown as Resource, action: "read", now: Date.now() });
  if (!granted.ok) return bad("forbidden", granted.error.message);
  return { ok: true, value: undefined };
}
export function admitManagerPolicyRead(input: unknown, presented: string | null, binding: ManagerPolicyBinding, localEnvironment: string): Result<void> {
  if (binding.direction !== "incoming" || binding.target.environment !== localEnvironment || !object(input) || !keys(input, ["version", "id", "source", "target"]) || input.version !== 1 || input.id !== binding.id
      || !identity(input.source, false) || !identity(input.target, true)
      || Object.entries(binding.source).some(([key, value]) => (input.source as Record<string, unknown>)[key] !== value)
      || Object.entries(binding.target).some(([key, value]) => (input.target as Record<string, unknown>)[key] !== value)) return bad("forbidden", "Manager-policy identities disagree");
  if (!presented || !/^[a-f0-9]{64}$/.test(presented) || !timingSafeEqual(createHash("sha256").update(presented).digest(), Buffer.from(binding.credentialSha256, "hex"))) return bad("forbidden", "Enrolled manager-policy credential required");
  return { ok: true, value: undefined };
}
export async function boundedBody(body: ReadableStream<Uint8Array> | null, maximum = 4096): Promise<string> {
  if (body === null) throw new Error("Manager policy metadata is absent");
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  const deadline = AbortSignal.timeout(5000); const cancel = () => { void reader.cancel().catch(() => {}); };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) { const chunk = await reader.read(); if (deadline.aborted) throw new Error("Manager policy metadata deadline expired"); if (chunk.done) break; bytes += chunk.value.length; if (bytes > maximum) throw new Error("Manager metadata exceeds bound"); chunks.push(chunk.value); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { deadline.removeEventListener("abort", cancel); await reader.cancel(); reader.releaseLock(); }
}
export function protectedRead(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) throw new Error("Manager-policy store requires root-owned 0600 regular files");
  if (stat.size > 64 * 1024) throw new Error("Manager-policy store exceeds metadata limit");
  return readFileSync(path, "utf8");
}
export function bindings(): Result<ManagerPolicyBinding[]> {
  if (!existsSync(STORE)) return { ok: true, value: [] };
  try {
    const value: unknown = JSON.parse(protectedRead(STORE));
    if (!object(value) || !keys(value, ["version", "bindings"]) || value.version !== 1 || !Array.isArray(value.bindings)) return bad("unavailable", "Invalid manager-policy store");
    const rows: ManagerPolicyBinding[] = [];
    for (const row of value.bindings) { const parsed = parseManagerPolicyBinding(row); if (!parsed.ok) return parsed; rows.push(parsed.value); }
    if (new Set(rows.map(row => row.id)).size !== rows.length) return bad("conflict", "Duplicate manager-policy binding");
    return { ok: true, value: rows };
  } catch { return bad("unavailable", "Protected manager-policy store unreadable"); }
}
export function secret(binding: ManagerPolicyBinding): Result<string> {
  try {
    const token = protectedRead(binding.credentialFile).trim();
    if (!/^[a-f0-9]{64}$/.test(token) || createHash("sha256").update(token).digest("hex") !== binding.credentialSha256) return bad("unavailable", "Manager-policy credential identity disagrees");
    return { ok: true, value: token };
  } catch { return bad("unavailable", "Enrolled manager-policy credential unavailable; enrollment never occurs during requests"); }
}
export function authority(binding: ManagerPolicyBinding): Result<void> {
  if ((binding.direction === "outgoing" ? binding.source.host : binding.target.host) !== hostname()) return bad("forbidden", "Manager-policy binding names another host");
  try { return managerPolicyAuthority(JSON.parse(readFileSync("/etc/pi-stack/core.json", "utf8")), binding); }
  catch { return bad("unavailable", "Core manager authority unreadable"); }
}
export function validateManagerPolicyResponse(value: unknown, managerThreadId: string): Result<{ view: "mono"; managerThreadId: string }> {
  if (object(value) && value.ok === true && object(value.value) && keys(value.value, ["view", "managerThreadId"]) && value.value.view === "mono" && value.value.managerThreadId === managerThreadId) return { ok: true, value: { view: "mono", managerThreadId } };
  if (object(value) && value.ok === false && object(value.error) && typeof value.error.message === "string") return bad("unavailable", value.error.message.slice(0, 512));
  return bad("conflict", "Manager-policy response names another manager or policy");
}
export async function outgoingManagerPolicy(user: string, uid: number, sourceEnvironment: string, targetEnvironment: string, signal: AbortSignal): Promise<Response | undefined> {
  const configured = bindings(); if (!configured.ok) return Response.json(configured, { status: 503 });
  const selected = configured.value.filter(b => b.direction === "outgoing" && b.source.user === user && b.source.uid === uid && b.source.environment === sourceEnvironment && b.target.environment === targetEnvironment);
  if (selected.length === 0) return undefined;
  if (selected.length !== 1) return Response.json(bad("conflict", "Ambiguous manager-policy route"), { status: 503 });
  const binding = selected[0]!, authorized = authority(binding); if (!authorized.ok) return Response.json(authorized, { status: 503 });
  const token = secret(binding); if (!token.ok) return Response.json(token, { status: 503 });
  try {
    const response = await fetch(`${binding.origin}${MANAGER_POLICY_PATH}`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", [TOKEN_HEADER]: token.value }, body: JSON.stringify({ version: 1, id: binding.id, source: binding.source, target: binding.target }), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel(); return Response.json(bad("unavailable", `Canonical manager policy returned HTTP ${response.status}`), { status: 503 }); }
    const text = await boundedBody(response.body);
    const result = validateManagerPolicyResponse(JSON.parse(text), binding.target.managerThreadId);
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch { return Response.json(bad("unavailable", "Canonical manager policy transport unavailable"), { status: 503 }); }
}
export async function incomingManagerPolicy(request: Request, localEnvironment: string, person: (user: string) => { user: string; port: number } | undefined,
  project: (owner: { user: string; port: number }, signal: AbortSignal) => Promise<Response>): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== MANAGER_POLICY_PATH) return Response.json(bad("forbidden", "Only exact manager policy reads are enrolled"), { status: 403 });
  const configured = bindings(); if (!configured.ok) return Response.json(configured, { status: 503 });
  let text: string; try { text = await boundedBody(request.body); } catch { return Response.json(bad("invalid_request", "Manager-policy envelope unavailable or exceeds metadata bound"), { status: 400 }); }
  let input: unknown; try { input = JSON.parse(text); } catch { return Response.json(bad("invalid_request", "Manager-policy envelope must be JSON"), { status: 400 }); }
  if (!object(input) || !keys(input, ["version", "id", "source", "target"]) || input.version !== 1) return Response.json(bad("invalid_request", "Exact manager-policy envelope required"), { status: 400 });
  const selected = configured.value.filter(b => b.direction === "incoming" && b.id === input.id && b.target.environment === localEnvironment);
  if (selected.length !== 1) return Response.json(bad("forbidden", "No enrolled manager-policy route"), { status: 403 });
  const binding = selected[0]!;
  const admitted = admitManagerPolicyRead(input, request.headers.get(TOKEN_HEADER), binding, localEnvironment);
  if (!admitted.ok) return Response.json(admitted, { status: 403 });
  const authorized = authority(binding); if (!authorized.ok) return Response.json(authorized, { status: 503 });
  const owner = person(binding.target.user); if (!owner) return Response.json(bad("unavailable", "Existing manager person is unavailable"), { status: 503 });
  try {
    const response = await project(owner, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]));
    if (!response.ok) { await response.body?.cancel(); return Response.json(bad("unavailable", `Existing manager policy projection returned HTTP ${response.status}`), { status: 503 }); }
    const text = await boundedBody(response.body);
    const result = validateManagerPolicyResponse(JSON.parse(text), binding.target.managerThreadId); return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch { return Response.json(bad("unavailable", "Existing manager policy projection unavailable"), { status: 503 }); }
}

export function managerNoticeCapability(binding: ManagerPolicyBinding) {
  return { version: 1, purpose: "canonical-notification", binding };
}
function noticeAuthority(binding: ManagerPolicyBinding): Result<void> {
  const current = authority(binding); if (!current.ok) return current;
  try {
    const value = JSON.parse(protectedRead(`/etc/pi-stack/manager-policy/${binding.id}/notices.json`));
    return isDeepStrictEqual(value, managerNoticeCapability(binding)) ? { ok: true, value: undefined }
      : bad("forbidden", "Notice capability differs from the enrolled canonical identity");
  } catch { return bad("forbidden", "Explicit canonical notification enrollment required"); }
}
export function validateManagerNotice(input: unknown, binding: ManagerPolicyBinding): Result<Record<string, unknown>> {
  if (!object(input) || input.threadId !== binding.target.managerThreadId || input.source !== "notification"
      || typeof input.senderId !== "string" || !atom(input.senderId)
      || typeof input.requestId !== "string" || !/^manager-notice:[a-zA-Z0-9_.:-]+$/.test(input.requestId)
      || typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text) > MANAGER_NOTICE_BYTES - 4096
      || input.delivery !== undefined && input.delivery !== "steer"
      || Object.keys(input).some(key => !["threadId", "senderId", "requestId", "source", "text", "delivery"].includes(key)))
    return bad("invalid_request", "One original notification to the enrolled canonical manager required");
  return { ok: true, value: input };
}
export function validateManagerNoticeReceipt(value: unknown, input: Record<string, unknown>): Result<{ id: string; threadId: string }> {
  if (object(value) && value.ok === true && object(value.value) && value.value.id === input.requestId
      && value.value.threadId === input.threadId)
    return { ok: true, value: { id: value.value.id as string, threadId: value.value.threadId as string } };
  if (object(value) && value.ok === false && object(value.error) && typeof value.error.message === "string")
    return bad("unavailable", value.error.message.slice(0, 512));
  return bad("conflict", "Original canonical notice acceptance is unconfirmed; retain its identity");
}
export async function outgoingManagerNotice(user: string, uid: number, sourceEnvironment: string, targetEnvironment: string,
  input: unknown, signal: AbortSignal): Promise<Response | undefined> {
  const configured = bindings(); if (!configured.ok) return Response.json(configured, { status: 503 });
  const selected = configured.value.filter(b => b.direction === "outgoing" && b.source.user === user && b.source.uid === uid
    && b.source.environment === sourceEnvironment && b.target.environment === targetEnvironment);
  if (!selected.length) return undefined;
  if (selected.length !== 1) return Response.json(bad("conflict", "Ambiguous canonical notice route"), { status: 503 });
  const binding = selected[0]!, admitted = validateManagerNotice(input, binding);
  if (!admitted.ok) return Response.json(admitted, { status: 400 });
  const allowed = noticeAuthority(binding); if (!allowed.ok) return Response.json(allowed, { status: 403 });
  const token = secret(binding); if (!token.ok) return Response.json(token, { status: 503 });
  try {
    const response = await fetch(`${binding.origin}${MANAGER_NOTICE_PATH}`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token.value },
      body: JSON.stringify({ version: 1, id: binding.id, source: binding.source, target: binding.target, input: admitted.value }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    const result = validateManagerNoticeReceipt(JSON.parse(await boundedBody(response.body, MANAGER_NOTICE_BYTES)), admitted.value);
    return Response.json(result, { status: response.ok && result.ok ? 200 : 503 });
  } catch { return Response.json(bad("unavailable", "Canonical notice transport unconfirmed; retain original request identity"), { status: 503 }); }
}
export async function incomingManagerNotice(request: Request, localEnvironment: string,
  person: (user: string) => { user: string; port: number } | undefined,
  deliver: (owner: { user: string; port: number }, input: Record<string, unknown>, sourceEnvironment: string, signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== MANAGER_NOTICE_PATH || url.search)
    return Response.json(bad("forbidden", "Only enrolled canonical notifications are admitted"), { status: 403 });
  const configured = bindings(); if (!configured.ok) return Response.json(configured, { status: 503 });
  let envelope: unknown;
  try { envelope = JSON.parse(await boundedBody(request.body, MANAGER_NOTICE_BYTES)); }
  catch { return Response.json(bad("invalid_request", "Bounded canonical notice envelope required"), { status: 400 }); }
  if (!object(envelope) || !keys(envelope, ["version", "id", "source", "target", "input"]))
    return Response.json(bad("invalid_request", "Exact canonical notice envelope required"), { status: 400 });
  const selected = configured.value.filter(b => b.direction === "incoming" && b.id === envelope.id && b.target.environment === localEnvironment);
  if (selected.length !== 1) return Response.json(bad("forbidden", "No enrolled canonical notice route"), { status: 403 });
  const binding = selected[0]!, { input, ...identityEnvelope } = envelope;
  const authenticated = admitManagerPolicyRead(identityEnvelope, request.headers.get(TOKEN_HEADER), binding, localEnvironment);
  if (!authenticated.ok) return Response.json(authenticated, { status: 403 });
  const allowed = noticeAuthority(binding); if (!allowed.ok) return Response.json(allowed, { status: 403 });
  const admitted = validateManagerNotice(input, binding); if (!admitted.ok) return Response.json(admitted, { status: 400 });
  const owner = person(binding.target.user); if (!owner) return Response.json(bad("unavailable", "Canonical manager person unavailable"), { status: 503 });
  try {
    const response = await deliver(owner, admitted.value, binding.source.environment, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]));
    const result = validateManagerNoticeReceipt(JSON.parse(await boundedBody(response.body, MANAGER_NOTICE_BYTES)), admitted.value);
    return Response.json(result, { status: response.ok && result.ok ? 200 : 503 });
  } catch { return Response.json(bad("unavailable", "Original canonical notice acceptance unconfirmed; retain its identity"), { status: 503 }); }
}
