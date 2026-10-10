import { expect, test } from "bun:test";
import { ActionJournal } from "../src/journal.js";
import { MemoryStore } from "../src/store.js";
import { memoryRole, stateValue } from "../src/explicit-state.js";
import { kenanRequestNotice, type ForgetMode, type MemoryRole, type RootLogConsent, type RootLogRequestStatus } from "../src/contract.js";
import { validateRequest, validateResult } from "../src/validation.js";
import { memoryClient } from "../src/client.js";

const context = { threadId: "thread", turnId: "turn" };
test("unknown persisted roles cannot acquire unrestricted memory access", () => {
  const store = new MemoryStore(":memory:");
  try {
    const session = store.session("alice", "thread");
    store.db.query("UPDATE sessions SET role='future-role' WHERE token=?").run(session.token);
    expect(store.resolveSession(session.token)).toBeUndefined();
    for (const role of ["future-role", "__proto__", "", null]) {
      const invalid = role as MemoryRole;
      expect(() => store.session("alice", "thread", invalid)).toThrow();
      expect(() => store.search("alice", context, "", undefined, 20, invalid)).toThrow();
      expect(() => store.read("alice", context, [], invalid)).toThrow();
      expect(() => store.disclosures("alice", context, 20, invalid)).toThrow();
    }
    expect(memoryRole(undefined)).toBe("person");
    expect(() => memoryRole("future-role")).toThrow();
    expect(() => stateValue({ person: "person" }, "__proto__" as "person")).toThrow();
  } finally { store.close(); }
});

test("unknown forget/consent/notice states do not mutate records or become known variants", () => {
  const store = new MemoryStore(":memory:");
  try {
    const item = store.write("alice", { text: "keep", about: ["alice"], source: { saidBy: "alice" }, setting: { person: "alice" }, obviouslyPrivate: false });
    expect(() => store.forget([item.id], "future-mode" as ForgetMode)).toThrow();
    expect(store.read("alice", context, [item.id]).value).toHaveLength(1);
    const admission = store.admitRoot("alice", "thread", ["alice"], []);
    expect(store.logConsent({ rootSessionId: admission.rootSessionId, consentId: "id", subject: "alice", kind: "future-kind", text: "no" } as unknown as RootLogConsent)).toMatchObject({ ok: false, error: "invalid-request" });
    expect(store.logRequestStatus({ rootSessionId: admission.rootSessionId, requestId: "id", status: "future-status" } as unknown as RootLogRequestStatus)).toMatchObject({ ok: false, error: "invalid-request" });
    expect(() => kenanRequestNotice("id", "future-status" as "failed")).toThrow();
    expect(store.db.query("SELECT count(*) AS n FROM disclosures").get()).toEqual({ n: 0 });
    expect(validateRequest({ operation: "future-operation", context })).toEqual({ ok: false, reason: expect.stringContaining("operation must be one of") });
  } finally { store.close(); }
});

test("unknown result discriminants and errors are not trusted as memory results", async () => {
  for (const result of [null, [], { ok: "true", value: {} }, { ok: true }, { ok: true, value: {}, error: "future-error" }, { ok: false, error: "disabled", message: "off", value: {} }, { ok: false, error: "future-error", message: "not an error variant" }, { ok: false, error: "__proto__", message: "prototype" }]) {
    expect(validateResult(result)).toBeUndefined();
    const client = memoryClient({ token: null, fetch: (async () => Response.json(result)) as typeof fetch });
    expect(await client.request({ operation: "search", query: "", context })).toMatchObject({ ok: false, error: "unavailable" });
  }
  expect(validateResult({ ok: true, value: {} })).toEqual({ ok: true, value: {} });
  expect(validateResult({ ok: false, error: "disabled", message: "off" })).toEqual({ ok: false, error: "disabled", message: "off" });
});

test("unknown journal outcomes are rejected even when journaling was disabled", () => {
  const journal = new ActionJournal({ enabled: () => false });
  expect(journal.finish(null, "future-outcome" as "confirmed")).toMatchObject({ ok: false });
  expect(journal.finish(null, "unconfirmed")).toEqual({ ok: true });
});
