import { expect, test } from "bun:test";
import { activatePersonalCore, CORE_PERSON_ACTIVATION, preparedSupervisorHealth } from "./core-readiness";

const receipt = (user = "alice", scopeId = "person:alice") => ({ ok: true, value: { protocol: "pi-core-person-activation-v1", user, scopeId, state: "prepared" } } as const);

test("activation passes only the verified registered user to the fixed root resource owner", async () => {
  const calls: string[][] = [];
  const result = await activatePersonalCore("alice", async argv => {
    calls.push([...argv]);
    return { code: 0, stdout: JSON.stringify(receipt()) };
  });
  expect(calls).toEqual([[CORE_PERSON_ACTIVATION, "alice"]]);
  expect(result).toEqual(receipt());
  expect((await activatePersonalCore("../../another", async () => { throw new Error("Must not execute"); })).ok).toBe(false);
});

test("unknown helper effects, malformed receipts and another account cannot become readiness", async () => {
  for (const execution of [
    { code: 1, stdout: JSON.stringify(receipt()) },
    { code: 0, stdout: "not JSON" },
    { code: 0, stdout: JSON.stringify(receipt("another")) },
    { code: 0, stdout: JSON.stringify(receipt("alice", "../another")) },
    { code: 0, stdout: JSON.stringify({ ok: true, value: { ...receipt().value, state: "requested" } }) },
  ]) {
    expect(await activatePersonalCore("alice", async () => execution)).toMatchObject({ ok: false, status: 503 });
  }
  expect(await activatePersonalCore("alice", async () => { throw new Error("Lost helper receipt"); })).toMatchObject({ ok: false, status: 503 });
});

test("a prepared mount or healthy old generation is not proof of the exact core projection", () => {
  expect(preparedSupervisorHealth({ ok: true, core: { scopeId: "person:alice", error: null } }, "person:alice")).toBe(true);
  for (const value of [null, { ok: true }, { ok: true, core: { scopeId: "person:bob", error: null } }, { ok: true, core: { scopeId: "person:alice", error: "unavailable" } }, { ok: false, core: { scopeId: "person:alice", error: null } }]) expect(preparedSupervisorHealth(value, "person:alice")).toBe(false);
});
