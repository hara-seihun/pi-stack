import { expect, it } from "vitest";
import { measureJsonBytes } from "../src/threads/json-size.js";

it("measures JSON transport bytes without materializing documents", () => {
  for (const value of [null, true, -0, NaN, "λ🌿\n\"\\\u0000\ud800", [1, undefined, "β"], { text: "\n\t", absent: undefined, value: [false, null] }]) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(measureJsonBytes(value, bytes)).toEqual({ ok: true, value: bytes });
    expect(measureJsonBytes(value, bytes - 1)).toMatchObject({ ok: false, error: { code: "oversized" } });
  }
});

it("rejects oversized strings and cyclic/non-JSON values explicitly", () => {
  expect(measureJsonBytes({ content: "x".repeat(100_000) }, 100)).toMatchObject({ ok: false, error: { code: "oversized" } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(measureJsonBytes(cycle, 1000)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(measureJsonBytes({ value: 1n }, 100)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});
