import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { admitManagerPolicyRead, managerPolicyAuthority, parseManagerPolicyBinding, validateManagerPolicyResponse, type ManagerPolicyBinding } from "./canonical-manager-policy";
const token = "a".repeat(64);
const binding: ManagerPolicyBinding = { version: 1, id: "exact-policy", direction: "incoming", source: { host: "source", environment: "converge", scopeId: "remote:kenan", user: "kenan", uid: 1002 }, target: { host: "target", environment: "local", scopeId: "remote:kenan", user: "kenan", uid: 1000, managerThreadId: "original-manager" }, origin: "http://target:8788", credentialSha256: createHash("sha256").update(token).digest("hex"), credentialFile: "/etc/pi-stack/manager-policy/exact-policy/token" };
const envelope = { version: 1, id: binding.id, source: binding.source, target: binding.target };
const resource = { id: "scope:remote:kenan", kind: "thread", owner: "kenan", subjects: ["kenan"], privacy: "private", consent: "not-required" };
function core(direction: "incoming" | "outgoing") {
  const local = direction === "incoming" ? binding.target : binding.source;
  return { principals: [{ id: "kenan", kind: "person", person: "kenan" }], policy: { revision: 1, consents: [], grants: [{ id: "canonical-read", principal: "kenan", resource: { kind: "exact", id: resource.id }, actions: ["read"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "existing-core-authority" }] }, scopes: [{ id: local.scopeId, principalId: "kenan", resource, custody: { uid: local.uid }, managerRouting: { kind: "configured", relay: { scopeId: local.scopeId, environmentId: local.environment, canonicalManager: { environmentId: "local", threadId: binding.target.managerThreadId }, remoteEnvironments: direction === "outgoing" ? [{ id: "local", resource }] : [] } } }] };
}
test("manager-policy enrollment is exact and cannot become a generic credential or endpoint", () => {
  expect(parseManagerPolicyBinding(binding).ok).toBe(true);
  for (const changed of [{ extra: true }, { direction: "any" }, { origin: "https://target:8788" }, { origin: "http://target:8788/v1/threads" }, { origin: "http://user:password@target:8788" }, { credentialFile: "/etc/pi-stack/other/token" }, { target: { ...binding.target, user: "another" } }, { source: { ...binding.source, scopeId: "fleet:kenan" } }, { source: { ...binding.source, uid: -1 } }, { id: "../other" }]) expect(parseManagerPolicyBinding({ ...binding, ...changed }).ok).toBe(false);
});
test("policy envelope and enrolled token bind every host/person/environment/scope/manager identity", () => {
  expect(admitManagerPolicyRead(envelope, token, binding, "local").ok).toBe(true);
  const reversed = Object.fromEntries(Object.entries(binding.source).reverse());
  expect(admitManagerPolicyRead({ ...envelope, source: reversed }, token, binding, "local").ok).toBe(true);
  for (const input of [{ ...envelope, action: "send" }, { ...envelope, id: "other" }, { ...envelope, source: { ...binding.source, host: "other" } }, { ...envelope, source: { ...binding.source, environment: "other" } }, { ...envelope, source: { ...binding.source, user: "other" } }, { ...envelope, source: { ...binding.source, uid: 0 } }, { ...envelope, target: { ...binding.target, managerThreadId: "replacement" } }, { ...envelope, target: { ...binding.target, scopeId: "remote:other" } }]) expect(admitManagerPolicyRead(input, token, binding, "local").ok).toBe(false);
  for (const secret of [null, "", "b".repeat(64), token + "a"]) expect(admitManagerPolicyRead(envelope, secret, binding, "local").ok).toBe(false);
  expect(admitManagerPolicyRead(envelope, token, binding, "another").ok).toBe(false);
  expect(admitManagerPolicyRead(envelope, token, { ...binding, direction: "outgoing" }, "local").ok).toBe(false);
});
test("existing Core canonical identity and current read grant remain authority", () => {
  for (const direction of ["incoming", "outgoing"] as const) {
    const b = { ...binding, direction }, c = core(direction);
    expect(managerPolicyAuthority(c, b).ok).toBe(true);
    expect(managerPolicyAuthority({ ...c, policy: { ...c.policy, grants: [] } }, b).ok).toBe(false);
    expect(managerPolicyAuthority({ ...c, policy: { ...c.policy, grants: [{ ...c.policy.grants[0]!, effect: "deny" }] } }, b).ok).toBe(false);
    expect(managerPolicyAuthority(c, { ...b, target: { ...b.target, managerThreadId: "replacement" } }).ok).toBe(false);
    expect(managerPolicyAuthority(c, { ...b, [direction === "incoming" ? "target" : "source"]: { ...(direction === "incoming" ? b.target : b.source), uid: 123 } }).ok).toBe(false);
    const absentPeer = core("outgoing"); absentPeer.scopes[0]!.managerRouting.relay.remoteEnvironments = [];
    expect(managerPolicyAuthority(absentPeer, { ...b, direction: "outgoing" }).ok).toBe(false);
  }
});
test("projection preserves the one canonical manager; errors and classic/other-manager policy never pass", () => {
  expect(validateManagerPolicyResponse({ ok: true, value: { view: "mono", managerThreadId: "original-manager" } }, "original-manager")).toEqual({ ok: true, value: { view: "mono", managerThreadId: "original-manager" } });
  for (const v of [{ ok: true, value: { view: "classic" } }, { ok: true, value: { view: "mono", managerThreadId: "replacement" } }, { ok: true, value: { view: "mono", managerThreadId: "original-manager", extra: true } }, { ok: false, error: { message: "unavailable" } }, null]) expect(validateManagerPolicyResponse(v, "original-manager").ok).toBe(false);
});

import { validateManagerNotice, validateManagerNoticeReceipt, managerNoticeCapability } from "./canonical-manager-policy";
test("explicit notice capability retains the enrolled binding without widening policy read", () => {
  expect(managerNoticeCapability(binding)).toEqual({ version: 1, purpose: "canonical-notification", binding });
  expect(admitManagerPolicyRead({ ...envelope, input: {} }, token, binding, "local").ok).toBe(false);
});
test("original notice is preserved exactly and only canonical notification sends pass", () => {
  const notice = { threadId: binding.target.managerThreadId, senderId: "original-worker", requestId: "manager-notice:fleet:settlement:original", source: "notification", text: "Actual work outcome" };
  expect(validateManagerNotice(notice, binding)).toEqual({ ok: true, value: notice });
  for (const changed of [{ threadId: "another-manager" }, { source: "explicit" }, { senderId: "" }, { requestId: "new-send" }, { delivery: "pending" }, { humanActivity: true }, { images: [] }, { text: "" }])
    expect(validateManagerNotice({ ...notice, ...changed }, binding).ok).toBe(false);
  expect(validateManagerNoticeReceipt({ ok: true, value: { id: notice.requestId, threadId: notice.threadId, text: notice.text } }, notice)).toEqual({ ok: true, value: { id: notice.requestId, threadId: notice.threadId } });
  for (const v of [{ ok: true, value: { id: "another", threadId: notice.threadId } }, { ok: true, value: { id: notice.requestId, threadId: "other" } }, { ok: false, error: { message: "unconfirmed" } }, null])
    expect(validateManagerNoticeReceipt(v, notice).ok).toBe(false);
});
