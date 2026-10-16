import { authorize } from "../../orchestrator/src/permissions.js";
import type { MemoryAuthorizer } from "../src/service.js";

export const fixtureAuthorization: MemoryAuthorizer = () => authorize({
  revision: 1, consents: [],
  grants: [{ id: "fixture-custody", principal: "fixture", resource: { kind: "exact", id: "fixture-custody" }, actions: ["execute"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "fixture-owner", source: "Disposable in-memory privacy boundary fixture" }],
}, { principal: { kind: "service", id: "fixture" }, resource: { id: "fixture-custody", kind: "operation", owner: "fixture-owner", privacy: "private", subjects: [], consent: "not-required" }, action: "execute", now: 1 });
