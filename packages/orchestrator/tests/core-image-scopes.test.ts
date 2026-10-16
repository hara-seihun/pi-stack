import { expect, test } from "bun:test";
import { authorizeRelatedImageScope } from "../src/core/image-scopes.js";
import type { PermissionPolicy, Resource } from "../src/permissions.js";
function fixture() {
  const resource: Resource = { id: "remote:alice", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" };
  const scopes = ["remote:alice", "fleet:alice"].map(id => ({ id, principalId: "alice", resource: { ...resource, id }, custody: { uid: 1001, gid: 1001 } }));
  const policy: PermissionPolicy = { revision: 1, consents: [], grants: [{ id: "read-fleet", principal: "alice", resource: { kind: "exact", id: "fleet:alice" }, actions: ["read"], effect: "allow", validFrom: 1, validUntil: null, issuedBy: "alice", source: "existing own fleet read" }] };
  return { scopes, principals: [{ kind: "person" as const, id: "alice", person: "alice" }], policy };
}
test("related native image scope needs exact existing read grant and owner domain", () => {
  const config = fixture();
  expect(authorizeRelatedImageScope(config, "remote:alice", "fleet:alice").ok).toBe(true);
  config.policy.grants = [];
  expect(authorizeRelatedImageScope(config, "remote:alice", "fleet:alice").ok).toBe(false);
});
test("same UID or owner alone never admits another scope's images", () => {
  for (const mutate of [
    (c: ReturnType<typeof fixture>) => { c.scopes[1]!.principalId = "other"; },
    (c: ReturnType<typeof fixture>) => { c.scopes[1]!.resource.owner = "other"; },
    (c: ReturnType<typeof fixture>) => { c.scopes[1]!.resource.subjects = ["other"]; },
    (c: ReturnType<typeof fixture>) => { c.scopes[1]!.custody.uid = 1002; },
    (c: ReturnType<typeof fixture>) => { c.scopes[1]!.resource.consent = "required"; },
  ]) {
    const config = fixture(); mutate(config);
    expect(authorizeRelatedImageScope(config, "remote:alice", "fleet:alice").ok).toBe(false);
  }
  expect(authorizeRelatedImageScope(fixture(), "remote:alice", "remote:alice").ok).toBe(false);
  expect(authorizeRelatedImageScope(fixture(), "remote:alice", "absent").ok).toBe(false);
});
