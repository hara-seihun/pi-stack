import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionCanonical } from "../src/completion-contract.js";
import { brokerBindingsSha256, verifyBrokerDrainReceipt, type BrokerAdmissionDelta, type RetainedBrokerListeners } from "../src/core/broker-transports.js";
const trust = vi.hoisted(() => ({ uid: 0, mode: 0o100600 }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fstatSync: (fd: number) => ({ ...actual.fstatSync(fd), uid: trust.uid, mode: trust.mode, isFile: () => true }) };
});
const roots: string[] = [];
afterEach(() => { trust.uid = 0; trust.mode = 0o100600; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "broker-admission-")); roots.push(root);
  const ledgerPath = join(root, "ledger"); writeFileSync(ledgerPath, "fixture");
  const ledger = statSync(ledgerPath, { bigint: true });
  const bindings = [{ principalId: "model-owner", port: 2461, uid: 1000, authorizedUids: [0, 1000], family: "inet" as const, table: "pi_user_access", outputChain: "output", inputChain: "input" }];
  const drain = { version: 1, state: "drained", ledgerPath, databaseIdentity: { dev: String(ledger.dev), ino: String(ledger.ino) }, previousOwner: { identity: "old-generation", drainedAt: new Date(Date.now() - 20_000).toISOString() }, streams: { state: "drained", accepted: 0 }, bindings };
  const adoptionReceiptPath = join(root, "drain.json"); writeFileSync(adoptionReceiptPath, JSON.stringify(drain));
  const template = { version: 1, creatorPrincipalId: "creator", principal: { kind: "person", id: "{{principalId}}", person: "{{user}}" }, scope: { custody: { uid: "{{uid}}" } }, nativeModelAdmission: { kind: "existing", principalId: "model-owner", uid: 1000, port: 2461 } };
  const templatePath = join(root, "template.json"), templateBytes = JSON.stringify(template, null, 2); writeFileSync(templatePath, templateBytes);
  const config: Extract<RetainedBrokerListeners, { kind: "uid-bound" }> = { kind: "uid-bound", adoptionReceiptPath, admissionDeltaPaths: [], bindings: structuredClone(bindings) };
  const enroll = (uid: number, principalId: string) => {
    const identityHash = sha(principalId), registrationId = `oidc-account-${identityHash}`, requestId = `${registrationId}:create`, planPath = join(root, `${principalId}-plan.json`);
    const plan = { version: 1, state: "prepared", user: principalId, requestId, templateHash: sha(completionCanonical(template)), identityHash,
      registration: { id: registrationId, requestId, creatorPrincipalId: "creator", scope: { principalId, custody: { uid } } },
      additions: { principal: { kind: "person", id: principalId, person: principalId }, nativeModelAdmission: template.nativeModelAdmission } };
    writeFileSync(planPath, JSON.stringify(plan));
    const nextBindings = structuredClone(config.bindings); nextBindings[0]!.authorizedUids.push(uid);
    const delta: BrokerAdmissionDelta = { version: 1, priorBindingsSha256: brokerBindingsSha256(config.bindings), nextBindingsSha256: brokerBindingsSha256(nextBindings), nextBindings,
      registration: { templatePath, templateSha256: sha(templateBytes), registrationId, requestId, principalId, uid, planPath, admittedAt: new Date(Date.now() - 1_000).toISOString() } };
    const path = join(root, `${principalId}-delta.json`); writeFileSync(path, JSON.stringify(delta));
    config.admissionDeltaPaths.push(path); config.bindings = nextBindings;
    return { path, delta, plan, planPath };
  };
  return { config, ledgerPath, enroll, drain, templatePath };
}

test("finite root enrollment chain preserves original drain bytes and exact transport identity", () => {
  const { config, ledgerPath, enroll } = fixture(), original = readFileSync(config.adoptionReceiptPath, "utf8");
  expect(verifyBrokerDrainReceipt(config, ledgerPath)).toMatchObject({ ok: true });
  enroll(1002, "alice"); enroll(1003, "bob");
  expect(verifyBrokerDrainReceipt(config, ledgerPath)).toMatchObject({ ok: true });
  expect(readFileSync(config.adoptionReceiptPath, "utf8")).toBe(original);
  config.admissionDeltaPaths.reverse();
  expect(verifyBrokerDrainReceipt(config, ledgerPath).ok).toBe(false);
});

test.each(["unlinked", "extra-uid", "changed-port", "wrong-template", "wrong-plan", "future", "missing-chain", "untrusted-owner", "writable-evidence"])("refuses %s without rewriting drain authority", reason => {
  const { config, ledgerPath, enroll, templatePath } = fixture(), { path, delta, plan, planPath } = enroll(1002, "alice");
  if (reason === "unlinked") delta.priorBindingsSha256 = "0".repeat(64);
  if (reason === "extra-uid") { delta.nextBindings[0]!.authorizedUids.push(1004); delta.nextBindingsSha256 = brokerBindingsSha256(delta.nextBindings); }
  if (reason === "changed-port") { delta.nextBindings[0]!.port = 2462; delta.nextBindingsSha256 = brokerBindingsSha256(delta.nextBindings); }
  if (reason === "wrong-template") writeFileSync(templatePath, "{}");
  if (reason === "wrong-plan") { plan.registration.scope.custody.uid = 1004; writeFileSync(planPath, JSON.stringify(plan)); }
  if (reason === "future") delta.registration.admittedAt = new Date(Date.now() + 60_000).toISOString();
  if (reason === "missing-chain") config.admissionDeltaPaths = [];
  if (reason === "untrusted-owner") trust.uid = 1002;
  if (reason === "writable-evidence") trust.mode = 0o100620;
  writeFileSync(path, JSON.stringify(delta));
  expect(verifyBrokerDrainReceipt(config, ledgerPath).ok).toBe(false);
});
