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
test("exact Converge port gates remain proof before later confinement accepts, marks, ct and socket rules", () => {
  const nft: any = fixture(), table = { family: "inet", table: "pi_user_access" };
  nft.nftables.push(
    { rule: { ...table, chain: "output", expr: [{ match: { op: "==", left: { meta: { key: "skuid" } }, right: 1002 } }, { match: { op: "==", left: { ct: { key: "direction" } }, right: "reply" } }, { accept: null }] } },
    { rule: { ...table, chain: "output", expr: [{ match: { op: "==", left: { fib: { result: "type", flags: ["daddr"] } }, right: "local" } }, { mangle: { key: { meta: { key: "mark" } }, value: 1346961409 } }, { accept: null }] } },
    { rule: { ...table, chain: "input", expr: [{ match: { op: "!=", left: { meta: { key: "iifname" } }, right: "lo" } }, { match: { op: "==", left: { socket: { key: "cgroupv2" } }, right: "user.slice/user-1002.slice" } }, { match: { op: "==", left: { meta: { key: "l4proto" } }, right: "tcp" } }, { reject: { type: "tcp reset" } }] } },
    { rule: { ...table, chain: "input", expr: [{ match: { op: "==", left: { meta: { key: "iifname" } }, right: "lo" } }, { mangle: { key: { ct: { key: "mark" } }, value: 1346961409 } }, { accept: null }] } },
  );
  expect(verifyUidBoundRules(nft, binding)).toBe(true);
  const confinement = nft.nftables.splice(5, 1)[0]; nft.nftables.splice(2, 0, confinement);
  expect(verifyUidBoundRules(nft, binding)).toBe(false);
});

test.each(["other-port", "authorized-uid", "other-protocol", "loopback-input"])("earlier %s accepts are proved disjoint, not blanket-permitted", kind => {
  const nft: any = fixture(), table = { family: "inet", table: "pi_user_access" };
  const match = kind === "other-port" ? { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 2482 }
    : kind === "authorized-uid" ? { op: "==", left: { meta: { key: "skuid" } }, right: { set: [0, 1002] } }
    : kind === "other-protocol" ? { op: "==", left: { meta: { key: "l4proto" } }, right: "udp" }
    : { op: "==", left: { meta: { key: "iifname" } }, right: "lo" };
  const prior = { rule: { ...table, chain: kind === "loopback-input" ? "input" : "output", expr: [{ match }, { accept: null }] } };
  nft.nftables.splice(2, 0, prior);
  expect(verifyUidBoundRules(nft, binding)).toBe(true);
  prior.rule.expr.unshift({ mangle: { key: { meta: { key: "mark" } }, value: 1 } } as any);
  expect(verifyUidBoundRules(nft, binding)).toBe(false);
});

test.each(["widen", "early-accept", "early-jump", "early-return", "early-mangle", "early-ct-accept", "named-set", "restricted-address", "no-input"])("rejects %s as listener identity proof", caseName => {
  const nft: any = fixture(), output = nft.nftables[2].rule;
  if (caseName === "widen") output.expr[2].match.right.set.push(1003);
  if (caseName === "early-accept") nft.nftables.splice(2, 0, { rule: { family: "inet", table: "pi_user_access", chain: "output", expr: [{ accept: null }] } });
  if (caseName === "early-jump") nft.nftables.splice(2, 0, { rule: { family: "inet", table: "pi_user_access", chain: "output", expr: [{ jump: { target: "unknown" } }] } });
  if (caseName === "early-return") nft.nftables.splice(2, 0, { rule: { family: "inet", table: "pi_user_access", chain: "input", expr: [{ return: null }] } });
  if (caseName === "early-mangle") nft.nftables.splice(2, 0, { rule: { family: "inet", table: "pi_user_access", chain: "output", expr: [{ mangle: { key: { payload: { protocol: "tcp", field: "dport" } }, value: 2482 } }] } });
  if (caseName === "early-ct-accept") nft.nftables.splice(2, 0, { rule: { family: "inet", table: "pi_user_access", chain: "input", expr: [{ match: { op: "==", left: { ct: { key: "direction" } }, right: "reply" } }, { accept: null }] } });
  if (caseName === "named-set") output.expr[2].match.right = "@unverified_uids";
  if (caseName === "restricted-address") output.expr.push({ match: { op: "==", left: { payload: { protocol: "ip", field: "saddr" } }, right: "127.0.0.2" } });
  if (caseName === "no-input") nft.nftables.pop();
  expect(verifyUidBoundRules(nft, binding)).toBe(false);
});
