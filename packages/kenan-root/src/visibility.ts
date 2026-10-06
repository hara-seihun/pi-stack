import { createHash, timingSafeEqual } from "node:crypto";

export const ROOT_ADMIN_HEADER = "x-pi-kenan-admin";
export const ROOT_CONFIDENCE_NOTE = "Root sessions are private because their traces reveal information Kenan holds in confidence.";
export interface RegisteredPerson { user: string; machineAdministrator?: boolean }
export type RootDebugRoute = { kind: "list" } | { kind: "transcript"; sessionId: string };
export type RootAdminRoute = RootDebugRoute | { kind: "release" };
export type RootAdminAdmission =
  | { ok: true; principal: { kind: "machine-administrator" }; route: RootAdminRoute }
  | { ok: false; response: Response };

export function isMachineAdministrator(authenticatedUser: string, registry: readonly RegisteredPerson[]): boolean {
  // The registry-marked administrator already has raw access to everything
  // root's traces could reveal. Never infer this from a shared execution UID,
  // a caller-supplied name, or an ordinary person's session capability.
  return registry.some(person => person.user === authenticatedUser && person.machineAdministrator === true);
}

export function rootDebugRoute(request: Request): RootDebugRoute | null {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  if (path === "/v1/admin/root-sessions") return { kind: "list" };
  const match = /^\/v1\/admin\/root-sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/transcript$/.exec(path);
  return match ? { kind: "transcript", sessionId: match[1]! } : null;
}

export function rootSessionDenied(): Response {
  // Denial does not depend on session existence. Root is never a ThreadDirectory
  // owner: list/history/context/items/images/files/SSE/export/collaboration are
  // not person-facing channels. Only Kenan's chosen reply may leave root.
  return Response.json({ error: ROOT_CONFIDENCE_NOTE }, { status: 404, headers: { "cache-control": "no-store" } });
}

export function rootAdminAdmission(request: Request, expectedCapability: string): RootAdminAdmission {
  const route: RootAdminRoute | null = new URL(request.url).pathname === "/v1/admin/release" && ["POST", "DELETE"].includes(request.method) ? { kind: "release" } : rootDebugRoute(request);
  const supplied = request.headers.get(ROOT_ADMIN_HEADER);
  if (!route || !supplied || !/^[0-9a-f]{64}$/.test(expectedCapability)) return { ok: false, response: rootSessionDenied() };
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(expectedCapability))) return { ok: false, response: rootSessionDenied() };
  return { ok: true, principal: { kind: "machine-administrator" }, route };
}

export function rootReplyResponse(reply: string): Response {
  // Never serialize root's native settlement, session ID, errors, model context,
  // usage detail or internal annotations onto the person-facing reply channel.
  return Response.json({ reply }, { headers: { "cache-control": "no-store" } });
}
