import { expect, test } from "bun:test";
import { RuntimeAdmission } from "./runtime-admission";

test("startup is bounded while priority coordinators overtake queued leaves", async () => {
  const gate = new RuntimeAdmission(2);
  let active = 0, peak = 0;
  const order: string[] = [];
  const jobs = Array.from({length: 165}, (_, i) => gate.admit(() => 0, async () => {
    active++; peak = Math.max(peak, active); order.push(`leaf-${i}`);
    await Bun.sleep(1); active--;
  }));
  const coordinator = gate.admit(() => 2, async () => { order.push("coordinator"); });
  await Promise.all([...jobs, coordinator]);
  expect(order[0]).toBe("coordinator");
  expect(peak).toBe(2);
  expect(new Set(order).size).toBe(166);
});

test("failed startup releases its slot", async () => {
  const gate = new RuntimeAdmission(1);
  const failed = gate.admit(() => 0, async () => { throw new Error("start failed"); });
  const next = gate.admit(() => 0, async () => 42);
  await expect(failed).rejects.toThrow("start failed");
  expect(await next).toBe(42);
});
