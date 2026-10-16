import { expect, test } from "bun:test";
import { authorize, type Grant, type PermissionPolicy, type Resource } from "../src/permissions.js";
const resource: Resource = { id: "memory:alice", kind: "memory", owner: "alice", privacy: "private", subjects: ["alice"], consent: "required" };
const grant = (principal: string, action: Grant["actions"][number], effect: Grant["effect"] = "allow"): Grant => ({ id: `${principal}:${action}:${effect}`, principal, resource: { kind: "exact", id: resource.id }, actions: [action], effect, validFrom: 1, validUntil: null, issuedBy: "owner", source: "stated grant" });
const policy = (grants: Grant[]): PermissionPolicy => ({ revision: 1, grants, consents: [{ id: "consent", subject: "alice", principal: "alice", resource: resource.id, actions: ["read"], validFrom: 1, validUntil: null, source: "alice" }] });
test("owner and administrator-looking names confer nothing; operational access is not memory access", () => {
  for (const person of ["alice", "kenan", "martine"]) expect(authorize(policy([]), { principal: { kind: "person", id: person, person }, resource, action: "read", now: 2 }).ok).toBe(false);
  expect(authorize(policy([grant("alice", "execute")]), { principal: { kind: "person", id: "alice", person: "alice" }, resource, action: "read", now: 2 }).ok).toBe(false);
});
test("deny, expiry, and consent control actual action", () => {
  const request = { principal: { kind: "person" as const, id: "alice", person: "alice" }, resource, action: "read" as const, now: 2 };
  expect(authorize(policy([grant("alice", "read")]), request).ok).toBe(true);
  expect(authorize(policy([grant("alice", "read"), grant("alice", "read", "deny")]), request).ok).toBe(false);
  expect(authorize(policy([{ ...grant("alice", "read"), validUntil: 2 }]), request).ok).toBe(false);
  expect(authorize({ ...policy([grant("alice", "read")]), consents: [] }, request)).toMatchObject({ ok: false, error: { code: "consent-required" } });
});
test("room grant cannot disclose to an ungranted audience member", () => {
  const request = { principal: { kind: "room" as const, id: "room", audience: ["alice", "bob"] }, resource: { ...resource, consent: "not-required" as const }, action: "read" as const, now: 2 };
  expect(authorize(policy([grant("room", "read"), grant("alice", "read")]), request).ok).toBe(false);
  expect(authorize(policy([grant("room", "read"), grant("alice", "read"), grant("bob", "read")]), request).ok).toBe(true);
});
test("unknown policy and empty consent subject cannot manufacture an allow", () => {
  expect(authorize({ revision: 1, grants: [{ ...grant("alice", "read"), effect: "unknown" } as any], consents: [] }, { principal: { kind: "service", id: "alice" }, resource, action: "read", now: 2 }).ok).toBe(false);
  expect(authorize(policy([grant("alice", "read")]), { principal: { kind: "service", id: "alice" }, resource: { ...resource, subjects: [] }, action: "read", now: 2 }).ok).toBe(false);
});
