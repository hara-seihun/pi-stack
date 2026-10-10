import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { completionCanonical } from "../completion-contract.js";
import type { CoreResult } from "./config.js";

export interface RetainedBrokerBinding {
  principalId: string;
  port: number;
  uid: number;
  authorizedUids: number[];
  family: "inet";
  table: string;
  outputChain: string;
  inputChain: string;
}
export type RetainedBrokerListeners = { kind: "disabled" } | { kind: "uid-bound"; adoptionReceiptPath: string; admissionDeltaPaths: string[]; bindings: RetainedBrokerBinding[] };
export interface BrokerAdmissionDelta {
  version: 1;
  priorBindingsSha256: string;
  nextBindingsSha256: string;
  nextBindings: RetainedBrokerBinding[];
  registration: { templatePath: string; templateSha256: string; registrationId: string; principalId: string; uid: number; admittedAt: string; planPath: string; requestId: string };
}
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => completionCanonical(a) === completionCanonical(b);
const members = (value: unknown): unknown[] => record(value) && Array.isArray(value.set) ? value.set : [value];
const portMatch = (match: any, port: number) => match?.op === "==" && same(match.left, { payload: { protocol: "tcp", field: "dport" } }) && members(match.right).includes(port);
const safeRule = (rule: any) => Array.isArray(rule.expr) && rule.expr.every((part: unknown) => record(part) && Object.keys(part).length === 1 && ["match", "reject", "counter"].some(key => key in part) && (!("match" in part) || record(part.match)))
  && rule.expr.slice(0, -1).every((part: any) => !("reject" in part)) && record(rule.expr.at(-1)) && "reject" in rule.expr.at(-1);
const finite = (value: unknown): (string | number)[] | undefined => {
  const values = members(value);
  return values.length > 0 && values.every(v => typeof v === "string" && !v.startsWith("@") || typeof v === "number" && Number.isSafeInteger(v)) ? values as (string | number)[] : undefined;
};
function excludesProtectedTraffic(match: any, binding: RetainedBrokerBinding, direction: "output" | "input"): boolean {
  if (!record(match)) return false;
  const values = finite(match.right);
  if (!values) return false;
  if (same(match.left, { payload: { protocol: "tcp", field: "dport" } })) return match.op === "==" && !values.includes(binding.port) || match.op === "!=" && values.includes(binding.port);
  if (same(match.left, { meta: { key: "l4proto" } })) return match.op === "==" && !values.includes("tcp") && !values.includes(6) || match.op === "!=" && (values.includes("tcp") || values.includes(6));
  if (direction === "output" && same(match.left, { meta: { key: "skuid" } })) return match.op === "==" && values.every(uid => typeof uid === "number" && binding.authorizedUids.includes(uid));
  if (direction === "input" && same(match.left, { meta: { key: "iifname" } })) return match.op === "==" && values.every(name => name === "lo");
  return false;
}
function protectedPrefix(rules: any[], gate: number, binding: RetainedBrokerBinding, direction: "output" | "input"): boolean {
  return rules.slice(0, gate).every(rule => {
    if (safeRule(rule)) return true;
    if (!Array.isArray(rule.expr)) return false;
    for (const part of rule.expr) {
      if (!record(part) || Object.keys(part).length !== 1) return false;
      if ("match" in part && record(part.match)) { if (excludesProtectedTraffic(part.match, binding, direction)) return true; }
      else if (!("counter" in part)) return false;
    }
    return false;
  });
}

/** Proves exact terminal port gates and every preceding path. Later confinement
 * cannot bypass their rejects; earlier effects need a proved disjoint guard. */
export function verifyUidBoundRules(value: unknown, binding: RetainedBrokerBinding): boolean {
  if (!record(value) || !Array.isArray(value.nftables)) return false;
  const objects = value.nftables;
  if (objects.some((item: unknown) => !record(item))) return false;
  const inTable = (item: any) => item.family === binding.family && item.table === binding.table;
  const base = (name: string, hook: string) => objects.some((item: any) => record(item.chain) && inTable(item.chain) && item.chain.name === name && item.chain.type === "filter" && item.chain.hook === hook && item.chain.policy === "accept" && typeof item.chain.prio === "number");
  if (!base(binding.outputChain, "output") || !base(binding.inputChain, "input")) return false;
  const rules = objects.flatMap((item: any) => record(item.rule) && inTable(item.rule) ? [item.rule] : []);
  const chainRules = (name: string) => rules.filter((rule: any) => rule.chain === name);
  const matches = (rule: any) => rule.expr.flatMap((part: any) => part.match ? [part.match] : []);
  const rejects = (rule: any) => rule.expr.some((part: any) => part.reject !== undefined);
  const allowed = [...binding.authorizedUids].sort((a, b) => a - b);
  const outputRules = chainRules(binding.outputChain), inputRules = chainRules(binding.inputChain);
  const output = outputRules.findIndex(rule => {
    if (!safeRule(rule)) return false;
    const conditions = matches(rule);
    return rejects(rule) && conditions.length === 3 && conditions.some((match: any) => portMatch(match, binding.port))
      && conditions.some((match: any) => match.op === "==" && same(match.left, { fib: { result: "type", flags: ["daddr"] } }) && match.right === "local")
      && conditions.some((match: any) => match.op === "!=" && same(match.left, { meta: { key: "skuid" } }) && same(members(match.right).sort((a, b) => Number(a) - Number(b)), allowed));
  });
  const input = inputRules.findIndex(rule => {
    if (!safeRule(rule)) return false;
    const conditions = matches(rule);
    return rejects(rule) && conditions.length === 2 && conditions.some((match: any) => portMatch(match, binding.port))
      && conditions.some((match: any) => match.op === "!=" && same(match.left, { meta: { key: "iifname" } }) && match.right === "lo");
  });
  return output >= 0 && input >= 0 && protectedPrefix(outputRules, output, binding, "output") && protectedPrefix(inputRules, input, binding, "input");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const brokerBindingsSha256 = (bindings: readonly RetainedBrokerBinding[]) => sha256(completionCanonical(bindings));
const absolute = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !value.includes("\0");
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function rootEvidence(path: string): string {
  if (!absolute(path)) throw Error("Admission evidence must use an absolute path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4 * 1024 * 1024) throw Error("Admission evidence must be a bounded root-owned file without group/other write");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function verifyBrokerDrainReceipt(config: Extract<RetainedBrokerListeners, { kind: "uid-bound" }>, ledgerPath: string): CoreResult<void> {
  try {
    const receipt = JSON.parse(rootEvidence(config.adoptionReceiptPath)), ledger = statSync(ledgerPath, { bigint: true });
    const drainedAt = Date.parse(receipt.previousOwner?.drainedAt);
    if (receipt.version !== 1 || receipt.state !== "drained" || receipt.ledgerPath !== ledgerPath
      || receipt.databaseIdentity?.dev !== String(ledger.dev) || receipt.databaseIdentity?.ino !== String(ledger.ino)
      || typeof receipt.previousOwner?.identity !== "string" || !receipt.previousOwner.identity || !Number.isFinite(drainedAt) || drainedAt > Date.now()
      || receipt.streams?.state !== "drained" || receipt.streams?.accepted !== 0 || !Array.isArray(receipt.bindings)) return { ok: false, error: { code: "ownership-conflict", message: "Broker drain receipt does not bind the original ledger, exact UID listeners and settled streams" } };
    if (!Array.isArray(config.admissionDeltaPaths) || config.admissionDeltaPaths.length > 256 || new Set(config.admissionDeltaPaths).size !== config.admissionDeltaPaths.length) throw Error("Declare a finite unique ordered admission delta chain, empty when none");
    let current: RetainedBrokerBinding[] = receipt.bindings, admittedAfter = drainedAt;
    const registrations = new Set<string>();
    for (const path of config.admissionDeltaPaths) {
      const delta: BrokerAdmissionDelta = JSON.parse(rootEvidence(path));
      const r = delta.registration;
      if (delta.version !== 1 || !hash(delta.priorBindingsSha256) || delta.priorBindingsSha256 !== brokerBindingsSha256(current)
        || !Array.isArray(delta.nextBindings) || !hash(delta.nextBindingsSha256) || delta.nextBindingsSha256 !== brokerBindingsSha256(delta.nextBindings)
        || !record(r) || !nonempty(r.registrationId) || !nonempty(r.requestId) || !nonempty(r.principalId) || !Number.isSafeInteger(r.uid) || r.uid < 0 || !hash(r.templateSha256)
        || registrations.has(r.registrationId)) throw Error("Admission delta does not bind its exact prior/next policy and unique registration");
      const admittedAt = Date.parse(r.admittedAt);
      if (!Number.isFinite(admittedAt) || admittedAt < admittedAfter || admittedAt > Date.now()) throw Error("Admission delta time is outside its ordered ownership chain");
      const templateBytes = rootEvidence(r.templatePath), template = JSON.parse(templateBytes), admission = template.nativeModelAdmission;
      if (sha256(templateBytes) !== r.templateSha256 || template.version !== 1 || !record(admission) || admission.kind !== "existing"
        || template.principal?.kind !== "person" || template.principal?.id !== "{{principalId}}" || template.principal?.person !== "{{user}}" || template.scope?.custody?.uid !== "{{uid}}") throw Error("Admission requires its exact root-owned existing-listener enrollment template");
      const plan = JSON.parse(rootEvidence(r.planPath));
      // The registration producer verifies issuer/subject and materializes this plan.
      if (plan.version !== 1 || !["prepared", "adopted"].includes(plan.state) || plan.registration?.id !== r.registrationId || plan.requestId !== r.requestId || plan.registration?.requestId !== r.requestId
        || plan.registration?.scope?.principalId !== r.principalId || plan.registration?.scope?.custody?.uid !== r.uid || plan.user !== r.principalId
        || plan.additions?.principal?.kind !== "person" || plan.additions?.principal?.id !== r.principalId || plan.additions?.principal?.person !== plan.user
        || !same(plan.additions?.nativeModelAdmission, admission) || plan.registration?.creatorPrincipalId !== template.creatorPrincipalId
        || plan.templateHash !== sha256(completionCanonical(template)) || !hash(plan.identityHash) || r.registrationId !== `oidc-account-${plan.identityHash}`) throw Error("Admission registration provenance differs from its root-owned plan");
      let changed = 0;
      if (current.length !== delta.nextBindings.length) throw Error("Enrollment cannot create or remove an original transport");
      for (const [i, prior] of current.entries()) {
        const next = delta.nextBindings[i]!;
        if (!record(prior) || !record(next) || !same({ ...prior, authorizedUids: undefined }, { ...next, authorizedUids: undefined })) throw Error("Enrollment cannot change original listener identity");
        if (same(prior.authorizedUids, next.authorizedUids)) continue;
        if (prior.principalId !== admission.principalId || prior.uid !== admission.uid || prior.port !== admission.port
          || !Array.isArray(prior.authorizedUids) || !Array.isArray(next.authorizedUids) || prior.authorizedUids.includes(r.uid)
          || next.authorizedUids.length !== prior.authorizedUids.length + 1 || new Set(next.authorizedUids).size !== next.authorizedUids.length
          || !next.authorizedUids.includes(r.uid) || prior.authorizedUids.some(uid => !next.authorizedUids.includes(uid))) throw Error("Enrollment may add only its registered UID to the template's exact existing listener");
        changed++;
      }
      if (changed !== 1) throw Error("Admission delta must add exactly one registered listener UID");
      registrations.add(r.registrationId); admittedAfter = admittedAt; current = delta.nextBindings;
    }
    if (!same(current, config.bindings)) return { ok: false, error: { code: "ownership-conflict", message: "Configured listener UID policy is not the immutable drain receipt plus its exact admission chain" } };
    return { ok: true, value: undefined };
  } catch (cause) { return { ok: false, error: { code: "unavailable", message: `Retained broker drain receipt unavailable: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
}
const execute = promisify(execFile);
export async function verifyLiveBrokerIdentity(binding: RetainedBrokerBinding): Promise<CoreResult<void>> {
  try {
    const result = await execute("/usr/sbin/nft", ["--json", "list", "table", binding.family, binding.table], { timeout: 1_000, maxBuffer: 4 * 1024 * 1024 });
    if (!verifyUidBoundRules(JSON.parse(result.stdout), binding)) return { ok: false, error: { code: "ownership-conflict", message: "Retained broker's live host UID/loopback gate differs from its exact custody binding" } };
    return { ok: true, value: undefined };
  } catch (cause) { return { ok: false, error: { code: "unavailable", message: `Cannot prove retained broker host identity: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
}
