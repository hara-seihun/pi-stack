import { describe, expect, test } from "bun:test";
import {
  calculateCpuPercent,
  CpuUsageWindow,
  parseGpuPercent,
  parseLinuxAvailableMemoryBytes,
  readMachineUsage,
} from "./machine-usage";

describe("machine usage", () => {
  test("calculates aggregate CPU use between samples", () => {
    expect(calculateCpuPercent(
      { idle: 1_000, total: 2_000 },
      { idle: 1_300, total: 3_000 },
    )).toBe(70);
    expect(calculateCpuPercent(
      { idle: 1_000, total: 2_000 },
      { idle: 1_000, total: 2_000 },
    )).toBeNull();
  });

  test("reports a stable trailing ten-second CPU average", () => {
    let totals = { idle: 0, total: 0 };
    const usage = new CpuUsageWindow(() => totals, 0);

    for (let second = 1; second <= 9; second++) {
      totals = { idle: second * 100, total: second * 100 };
      expect(usage.read(second * 1_000)).toBe(0);
    }

    totals = { idle: 900, total: 1_000 };
    expect(usage.read(10_000)).toBe(10);

    // A second client reading between samples sees the same value instead of
    // replacing the CPU interval with a tiny, noisy one.
    totals = { idle: 900, total: 1_050 };
    expect(usage.read(10_100)).toBe(10);

    for (let second = 11; second <= 20; second++) {
      totals = { idle: second * 100 - 100, total: second * 100 };
      usage.read(second * 1_000);
    }
    expect(usage.read(20_100)).toBe(0);

    // Do not call a long-idle interval a current CPU reading when a client
    // reopens; build a fresh window instead.
    totals = { idle: 2_900, total: 3_000 };
    expect(usage.read(31_000)).toBeNull();
  });

  test("parses GPU engine utilization rather than memory use", () => {
    expect(parseGpuPercent("42\n")).toBe(42);
    expect(parseGpuPercent("")).toBeNull();
    expect(parseGpuPercent("not available")).toBeNull();
    expect(parseGpuPercent("105")).toBe(100);
  });

  test("counts reclaimable Linux pages as available memory", () => {
    const available = parseLinuxAvailableMemoryBytes(`MemTotal:       65854796 kB
MemFree:         5933532 kB
MemAvailable:   59591332 kB
Buffers:        14021936 kB
Cached:         30763308 kB
SReclaimable:    9790584 kB
`);

    expect(available).toBe(59_591_332 * 1_024);
  });

  test("rejects Linux memory data without the kernel availability estimate", () => {
    expect(parseLinuxAvailableMemoryBytes("MemFree: 5933532 kB\n")).toBeNull();
  });

  test("reports bounded memory and disk utilization, plus GPU when available", () => {
    const usage = readMachineUsage();
    if (usage.gpuPercent !== null) expect(usage.gpuPercent).toBeWithin(0, 101);
    expect(usage.memory.totalBytes).toBeGreaterThan(0);
    expect(usage.memory.usedBytes).toBeGreaterThanOrEqual(0);
    expect(usage.memory.percentUsed).toBeWithin(0, 101);
    expect(usage.disk).not.toBeNull();
    expect(usage.disk!.totalBytes).toBeGreaterThan(0);
    expect(usage.disk!.percentUsed).toBeWithin(0, 101);
  });
});
