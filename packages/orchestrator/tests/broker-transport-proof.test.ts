import { expect, test } from "vitest";
import { verifyUidBoundRules, type RetainedBrokerBinding } from "../src/core/broker-transports.js";
const binding: RetainedBrokerBinding = { principalId: "alice", port: 2461, uid: 1002, authorizedUids: [0, 1000, 1002], family: "inet", table: "pi_user_access", outputChain: "output", inputChain: "input" };
function fixture() {
  const table = { family: "inet", table: "pi_user_access" }, port = { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: { set: [2461, 2471] } } };
  return { nftables: [
    { chain: { ...table, name: "output", type: "filter", hook: "output", prio: -20, policy: "accept" } },
    { chain: { ...table, name: "input", type: "filter", hook: "input", prio: -20, policy: "accept" } },
    { rule: { ...table, chain: "output", expr: [
      { match: { op: "==", left: { fib: { result: "type", flags: ["daddr"] } }, right: "local" } }, port,
      { match: { op: "!=", left: { meta: { key: "skuid" } }, right: { set: [1002, 1000, 0] } } }, { reject: { type: "tcp reset" } },
    ] } },
    { rule: { ...table, chain: "input", expr: [
      { match: { op: "!=", left: { meta: { key: "iifname" } }, right: "lo" } }, port, { reject: { type: "tcp reset" } },
    ] } },
  ] };
}
test("proves exact generated UID and loopback gates independently of set ordering", () => {
  expect(verifyUidBoundRules(fixture(), binding)).toBe(true);
  expect(verifyUidBoundRules(fixture(), { ...binding, port: 2462 })).toBe(false);
  expect(verifyUidBoundRules(fixture(), { ...binding, authorizedUids: [0, 1002] })).toBe(false);
});
test.each(["widen", "early-accept", "named-set", "restricted-address", "no-input"])("rejects %s as listener identity proof", caseName => {
  const nft: any = fixture(), output = nft.nftables[2].rule;
  if (caseName === "widen") output.expr[2].match.right.set.push(1003);
  if (caseName === "early-accept") nft.nftables.splice(2, 0, { rule: { family: "inet", table: "pi_user_access", chain: "output", expr: [{ accept: null }] } });
  if (caseName === "named-set") output.expr[2].match.right = "@unverified_uids";
  if (caseName === "restricted-address") output.expr.push({ match: { op: "==", left: { payload: { protocol: "ip", field: "saddr" } }, right: "127.0.0.2" } });
  if (caseName === "no-input") nft.nftables.pop();
  expect(verifyUidBoundRules(nft, binding)).toBe(false);
});
