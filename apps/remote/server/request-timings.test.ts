import { expect, test } from "bun:test";
import { RequestTimings } from "./request-timings";

const row = { id: 1, method: "POST", path: "/v1/stream/connection", startedAt: 123, durationMs: 1000, state: "pending" };
const report = (requests: unknown[]) => ({ clientId: "page-1", platform: "android", requests });

test("slow request updates retain settlement, omit arbitrary fields and stay bounded", () => {
  const timings = new RequestTimings(2);
  expect(timings.receive(report([{ ...row, headers: "private", body: "private" }]), 100)).toEqual({ ok: true });
  expect(timings.receive(report([{ ...row, durationMs: 7000, state: "settled" }]), 101)).toEqual({ ok: true });
  timings.receive(report([row]), 102);
  expect(timings.list(102)[0]).toMatchObject({ state: "settled", durationMs: 7000 });
  expect(JSON.stringify(timings.list(102))).not.toContain("private");
  timings.receive(report([{ ...row, id: 2 }, { ...row, id: 3 }]), 103);
  expect(timings.list(103).map(item => item.id)).toEqual([3, 2]);
  expect(timings.list(86_400_104)).toEqual([]);
});

test("rejects malformed or query-bearing reports without replacing retained data", () => {
  const timings = new RequestTimings();
  for (const invalid of [{ ...row, path: "/v1/files?session=secret" }, { ...row, method: "INVALID" }, { ...row, durationMs: NaN }, { ...row, state: "unknown" }]) {
    expect(timings.receive(report([invalid])).ok).toBe(false);
  }
  expect(timings.list()).toEqual([]);
});
