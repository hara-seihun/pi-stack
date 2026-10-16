import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionCanonical } from "../src/completion-contract.js";
import { verifyFreshBrokerAdmission, type FreshBrokerAdmissionReceipt, type FreshBrokerListener } from "../src/core/fresh-broker-transports.js";
const trust = vi.hoisted(() => ({ uid: 0 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fstatSync: (fd: number) => ({ ...fs.fstatSync(fd), uid: trust.uid, mode: 0o100600, isFile: () => true }) };
});
const roots: string[] = [];
afterEach(() => { trust.uid = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fresh-broker-")); roots.push(root);
  const configPath = join(root, "alice-broker.json"), templatePath = join(root, "template.json"), planPath = join(root, "plan.json"), admissionReceiptPath = join(root, "admission.json");
  const config = { ledgerPath: join(root, "existing-pool.sqlite3"), authPath: join(root, "shared-auth.json"), grantOwner: "person-alice", listeners: [{ principal: "alice", port: 19101, accounts: ["codex"], models: ["openai-codex/gpt-6-luna"], maxInFlight: 5 }] };
  const binding = { principalId: "alice", uid: 1002, authorizedUids: [0, 1000, 1002], port: 19101, family: "inet" as const, table: "people", outputChain: "output", inputChain: "input" };
  const declaration: FreshBrokerListener = { configPath, admissionReceiptPath, binding };
  const templateAdmission = { kind: "fresh", principalId: "{{principalId}}", uid: "{{uid}}", port: "{{brokerPort}}", configPath: "{{brokerConfigPath}}", grantFootprint: { ledgerOwnerIds: ["current"] },
    binding: { ...binding, principalId: "{{principalId}}", uid: "{{uid}}", port: "{{brokerPort}}", authorizedUids: [0, 1000, "{{uid}}"] },
    brokerConfig: { ...config, grantOwner: "person-{{principalId}}", listeners: [{ ...config.listeners[0]!, principal: "{{principalId}}", port: "{{brokerPort}}" }] } };
  const admission = { kind: "fresh", principalId: "alice", uid: 1002, port: 19101, configPath, grantFootprint: { ledgerOwnerIds: ["current"] }, binding, brokerConfig: config };
  const template = { version: 1, creatorPrincipalId: "creator", principal: { kind: "person", id: "{{principalId}}", person: "{{user}}" }, scope: { custody: { uid: "{{uid}}" } }, nativeModelAdmission: templateAdmission };
  const templateBytes = JSON.stringify(template, null, 2), configBytes = JSON.stringify(config, null, 2), identityHash = sha("issuer\0subject"), registrationId = `oidc-account-${identityHash}`, requestId = `${registrationId}:create`;
  const plan = { version: 1, state: "prepared", user: "alice", requestId, templateHash: sha(completionCanonical(template)), identityHash,
    registration: { id: registrationId, requestId, creatorPrincipalId: "creator", scope: { principalId: "alice", custody: { uid: 1002 } } },
    additions: { principal: { kind: "person", id: "alice", person: "alice" }, nativeModelAdmission: admission } };
  const receipt: FreshBrokerAdmissionReceipt = { version: 1, kind: "fresh-listener", priorOwner: { kind: "none" }, configPath, configSha256: sha(configBytes), grantFootprint: { configPath, ledgerOwnerIds: ["current"] }, binding,
    registration: { templatePath, templateSha256: sha(templateBytes), registrationId, requestId, principalId: "alice", uid: 1002, admittedAt: new Date(Date.now() - 1_000).toISOString(), planPath } };
  writeFileSync(templatePath, templateBytes); writeFileSync(configPath, configBytes); writeFileSync(planPath, JSON.stringify(plan)); writeFileSync(admissionReceiptPath, JSON.stringify(receipt));
  return { declaration, config, template, templatePath, plan, planPath, receipt };
}

test("fresh personal endpoint requires prior-owner-none registration and exact original enrollment model policy", () => {
  const { declaration, config } = fixture();
  expect(verifyFreshBrokerAdmission(declaration, config, ["current"])).toMatchObject({ ok: true });
  expect(verifyFreshBrokerAdmission(declaration, config, ["current", "other-ledger"]).ok).toBe(false);
});

test.each(["borrowed-principal", "reused-port", "broader-grants", "changed-uid-gate", "changed-config-bytes", "prior-owner", "wrong-registration", "untrusted-owner", "existing-template"])("refuses %s instead of borrowing an existing user's admission", reason => {
  const { declaration, config, template, templatePath, plan, planPath, receipt } = fixture();
  if (reason === "borrowed-principal") { declaration.binding.principalId = "another-person"; receipt.binding = declaration.binding; }
  if (reason === "reused-port") { declaration.binding.port = 19100; receipt.binding = declaration.binding; }
  if (reason === "broader-grants") config.listeners[0]!.accounts.push("another-account");
  if (reason === "changed-uid-gate") { declaration.binding.authorizedUids.push(1004); receipt.binding = declaration.binding; }
  if (reason === "changed-config-bytes") writeFileSync(declaration.configPath, JSON.stringify(config));
  if (reason === "prior-owner") (receipt as any).priorOwner = { kind: "existing" };
  if (reason === "wrong-registration") { plan.registration.scope.custody.uid = 1004; writeFileSync(planPath, JSON.stringify(plan)); }
  if (reason === "untrusted-owner") trust.uid = 1002;
  if (reason === "existing-template") { template.nativeModelAdmission.kind = "existing"; const bytes = JSON.stringify(template); writeFileSync(templatePath, bytes); receipt.registration.templateSha256 = sha(bytes); plan.templateHash = sha(completionCanonical(template)); writeFileSync(planPath, JSON.stringify(plan)); }
  writeFileSync(declaration.admissionReceiptPath, JSON.stringify(receipt));
  expect(verifyFreshBrokerAdmission(declaration, config, ["current"]).ok).toBe(false);
});
