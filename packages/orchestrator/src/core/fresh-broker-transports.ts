import { createHash } from "node:crypto";
import { completionCanonical } from "../completion-contract.js";
import type { ModelBrokerConfig } from "../model-broker.js";
import type { CoreResult } from "./config.js";
import { isBrokerListenerBinding, readRootBrokerEvidence, verifyBrokerEnrollmentRegistration, type BrokerEnrollmentRegistration, type RetainedBrokerBinding } from "./broker-transports.js";

export interface FreshBrokerListener { configPath: string; admissionReceiptPath: string; binding: RetainedBrokerBinding }
export interface FreshBrokerAdmissionReceipt {
  version: 1;
  kind: "fresh-listener";
  priorOwner: { kind: "none" };
  configPath: string;
  configSha256: string;
  grantFootprint: { configPath: string; ledgerOwnerIds: string[] };
  binding: RetainedBrokerBinding;
  registration: BrokerEnrollmentRegistration;
}
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => completionCanonical(a) === completionCanonical(b);
function render(value: unknown, variables: Record<string, string | number>): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{([A-Za-z]+)\}\}$/.exec(value);
    if (exact) { if (!(exact[1]! in variables)) throw Error("Unknown fresh enrollment template variable"); return variables[exact[1]!]!; }
    const rendered = value.replace(/\{\{([A-Za-z]+)\}\}/g, (_, key: string) => { if (!(key in variables)) throw Error("Unknown fresh enrollment template variable"); return String(variables[key]); });
    if (rendered.includes("{{") || rendered.includes("}}")) throw Error("Unresolved fresh enrollment template variable");
    return rendered;
  }
  if (Array.isArray(value)) return value.map(item => render(item, variables));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, variables)]));
  return value;
}
export function verifyFreshBrokerAdmission(declaration: FreshBrokerListener, config: ModelBrokerConfig, ledgerOwnerIds: readonly string[]): CoreResult<void> {
  try {
    const receipt: FreshBrokerAdmissionReceipt = JSON.parse(readRootBrokerEvidence(declaration.admissionReceiptPath));
    if (!isBrokerListenerBinding(declaration.binding) || typeof config.grantOwner !== "string" || !config.grantOwner.trim() || receipt.version !== 1 || receipt.kind !== "fresh-listener" || !same(receipt.priorOwner, { kind: "none" }) || receipt.configPath !== declaration.configPath
      || !same(receipt.binding, declaration.binding) || !same(receipt.grantFootprint, { configPath: declaration.configPath, ledgerOwnerIds })) throw Error("Fresh listener requires its exact prior-owner-none config, binding and publication footprint");
    const registered = verifyBrokerEnrollmentRegistration(receipt.registration); if (!registered.ok) return registered;
    const { template, plan } = registered.value, admission = template.nativeModelAdmission, r = receipt.registration;
    if (!record(admission) || admission.kind !== "fresh" || admission.principalId !== "{{principalId}}" || admission.uid !== "{{uid}}"
      || admission.port !== "{{brokerPort}}" || admission.configPath !== "{{brokerConfigPath}}" || !record(admission.brokerConfig) || !record(admission.binding)
      || !same(admission.grantFootprint, { ledgerOwnerIds: ["current"] })) throw Error("Fresh transport requires an explicit personal listener/model policy in its enrollment template");
    const expected = render(admission, { user: plan.user, principalId: r.principalId, uid: r.uid, brokerPort: declaration.binding.port, brokerConfigPath: declaration.configPath }) as Record<string, any>;
    if (!same(expected, plan.additions?.nativeModelAdmission) || !same(expected.binding, declaration.binding) || !same(expected.brokerConfig, config)
      || expected.principalId !== declaration.binding.principalId || expected.uid !== declaration.binding.uid || expected.configPath !== declaration.configPath
      || !same(expected.grantFootprint.ledgerOwnerIds, ledgerOwnerIds) || declaration.binding.principalId !== r.principalId || declaration.binding.uid !== r.uid
      || config.listeners.length !== 1 || config.listeners[0]!.principal !== r.principalId || config.listeners[0]!.port !== declaration.binding.port) throw Error("Fresh listener cannot borrow another person's endpoint, grants or owner identity");
    const bytes = readRootBrokerEvidence(declaration.configPath);
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.configSha256 || !same(JSON.parse(bytes), config)) throw Error("Fresh broker configuration differs from its admitted root-owned source");
    return { ok: true, value: undefined };
  } catch (cause) { return { ok: false, error: { code: "ownership-conflict", message: `Fresh broker admission is invalid: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
}
