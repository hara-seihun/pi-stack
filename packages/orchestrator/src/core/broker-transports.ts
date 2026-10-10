import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
export type RetainedBrokerListeners = { kind: "disabled" } | { kind: "uid-bound"; adoptionReceiptPath: string; bindings: RetainedBrokerBinding[] };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => completionCanonical(a) === completionCanonical(b);
const members = (value: unknown): unknown[] => record(value) && Array.isArray(value.set) ? value.set : [value];
const portMatch = (match: any, port: number) => match?.op === "==" && same(match.left, { payload: { protocol: "tcp", field: "dport" } }) && members(match.right).includes(port);
const safeRule = (rule: any) => Array.isArray(rule.expr) && rule.expr.every((part: unknown) => record(part) && Object.keys(part).length === 1 && ["match", "reject", "counter"].some(key => key in part) && (!("match" in part) || record(part.match)));

/** Proves the generated host's reject-only base chains. Unknown expressions,
 * named sets, early accept/jump paths or a widened UID set are not identity proof. */
export function verifyUidBoundRules(value: unknown, binding: RetainedBrokerBinding): boolean {
  if (!record(value) || !Array.isArray(value.nftables)) return false;
  const objects = value.nftables;
  if (objects.some((item: unknown) => !record(item))) return false;
  const inTable = (item: any) => item.family === binding.family && item.table === binding.table;
  const base = (name: string, hook: string) => objects.some((item: any) => record(item.chain) && inTable(item.chain) && item.chain.name === name && item.chain.type === "filter" && item.chain.hook === hook && item.chain.policy === "accept" && typeof item.chain.prio === "number");
  if (!base(binding.outputChain, "output") || !base(binding.inputChain, "input")) return false;
  const rules = objects.flatMap((item: any) => record(item.rule) && inTable(item.rule) ? [item.rule] : []);
  const chainRules = (name: string) => rules.filter((rule: any) => rule.chain === name);
  if ([...chainRules(binding.outputChain), ...chainRules(binding.inputChain)].some(rule => !safeRule(rule))) return false;
  const matches = (rule: any) => rule.expr.flatMap((part: any) => part.match ? [part.match] : []);
  const rejects = (rule: any) => rule.expr.some((part: any) => part.reject !== undefined);
  const allowed = [...binding.authorizedUids].sort((a, b) => a - b);
  const output = chainRules(binding.outputChain).some(rule => {
    const conditions = matches(rule);
    return rejects(rule) && conditions.length === 3 && conditions.some((match: any) => portMatch(match, binding.port))
      && conditions.some((match: any) => match.op === "==" && same(match.left, { fib: { result: "type", flags: ["daddr"] } }) && match.right === "local")
      && conditions.some((match: any) => match.op === "!=" && same(match.left, { meta: { key: "skuid" } }) && same(members(match.right).sort((a, b) => Number(a) - Number(b)), allowed));
  });
  const input = chainRules(binding.inputChain).some(rule => {
    const conditions = matches(rule);
    return rejects(rule) && conditions.length === 2 && conditions.some((match: any) => portMatch(match, binding.port))
      && conditions.some((match: any) => match.op === "!=" && same(match.left, { meta: { key: "iifname" } }) && match.right === "lo");
  });
  return output && input;
}

export function verifyBrokerDrainReceipt(config: Extract<RetainedBrokerListeners, { kind: "uid-bound" }>, ledgerPath: string): CoreResult<void> {
  try {
    const stat = statSync(config.adoptionReceiptPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return { ok: false, error: { code: "ownership-conflict", message: "Retained broker transports require a root-owned drain/host-identity receipt" } };
    const receipt = JSON.parse(readFileSync(config.adoptionReceiptPath, "utf8")), ledger = statSync(ledgerPath, { bigint: true });
    const drainedAt = Date.parse(receipt.previousOwner?.drainedAt);
    if (receipt.version !== 1 || receipt.state !== "drained" || receipt.ledgerPath !== ledgerPath
      || receipt.databaseIdentity?.dev !== String(ledger.dev) || receipt.databaseIdentity?.ino !== String(ledger.ino)
      || typeof receipt.previousOwner?.identity !== "string" || !receipt.previousOwner.identity || !Number.isFinite(drainedAt) || drainedAt > Date.now()
      || receipt.streams?.state !== "drained" || receipt.streams?.accepted !== 0 || !same(receipt.bindings, config.bindings)) return { ok: false, error: { code: "ownership-conflict", message: "Broker drain receipt does not bind the original ledger, exact UID listeners and settled streams" } };
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
