import { expect, test } from "bun:test";
import { formatBytes, formatResetDistance } from "./src/features/machine/format";

test("formats byte values with 1024-based units and one decimal place", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1024)).toBe("1.0 KiB");
  expect(formatBytes(1024 ** 2 * 2.5)).toBe("2.5 MiB");
  expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
});

test("formats reset distance in days and hours, then hours and minutes", () => {
  const now = Date.UTC(2026, 8, 20, 12);
  expect(formatResetDistance(new Date(now + (2 * 24 + 3) * 3_600_000 + 27 * 60_000).toISOString(), now)).toBe("in 2 days 3 hours");
  expect(formatResetDistance(new Date(now + 7 * 3_600_000 + 5 * 60_000).toISOString(), now)).toBe("in 7 hours 5 minutes");
  expect(formatResetDistance(null, now)).toBe("Reset time not reported");
});
