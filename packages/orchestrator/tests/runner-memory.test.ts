import { expect, it } from "vitest";
import { underMemoryPressure } from "../src/threads/runner-memory.js";

function reader(values: Record<string, string>) {
  return (path: string) => {
    if (path === "/proc/self/cgroup") return "0::/boundary/runner\n";
    const key = path.replace("/sys/fs/cgroup", "");
    if (key in values) return values[key];
    if (path.endsWith("memory.current")) return "0";
    if (path.endsWith("memory.stat")) return "inactive_file 0";
    return "max";
  };
}
it("refuses before the effective high boundary, not just the larger hard ceiling", () => {
  expect(underMemoryPressure(reader({ "/boundary/runner/memory.high": "600", "/boundary/runner/memory.max": "800",
    "/boundary/runner/memory.current": "500" }))).toBe(true);
});
it("subtracts reclaimable cache and still respects constrained ancestors", () => {
  const values = { "/boundary/runner/memory.high": "600", "/boundary/runner/memory.current": "700",
    "/boundary/runner/memory.stat": "inactive_file 500", "/boundary/memory.max": "1000", "/boundary/memory.current": "790" };
  expect(underMemoryPressure(reader(values))).toBe(false);
  values["/boundary/memory.current"] = "800";
  expect(underMemoryPressure(reader(values))).toBe(true);
});
