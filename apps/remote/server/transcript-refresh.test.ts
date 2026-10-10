import { expect, test } from "bun:test";
import { refreshTranscriptProjection } from "./transcript-refresh";

test("a concurrently appended native transcript reschedules projection without a false transport error", async () => {
  const pending: Array<() => Promise<void>> = [];
  const published: string[] = [];
  const errors: unknown[] = [];
  let reads = 0;
  const run = () => refreshTranscriptProjection(async () => {
    if (++reads === 1) return { ok: false, error: { code: "conflict", message: "Session revision changed; refresh the history index" } };
    published.push("fresh native snapshot");
    return { ok: true, value: undefined };
  }, () => pending.push(run), cause => errors.push(cause));
  await run();
  expect(published).toEqual([]);
  expect(errors).toEqual([]);
  expect(pending).toHaveLength(1);
  await pending.shift()!();
  expect(published).toEqual(["fresh native snapshot"]);
  expect(errors).toEqual([]);
  expect(pending).toHaveLength(0);
});

test.each(["stale-source", "stale_source"])("%s projection churn reschedules without dropping retained state", async code => {
  let retried = false, failed = false;
  await refreshTranscriptProjection(async () => ({ ok: false, error: { code, message: "Session changed during reading" } }),
    () => { retried = true; }, () => { failed = true; });
  expect(retried).toBe(true);
  expect(failed).toBe(false);
});

test("unrelated conflicts are not silently reclassified as native history churn", async () => {
  let retried = false;
  const errors: unknown[] = [];
  await refreshTranscriptProjection(async () => ({ ok: false, error: { code: "conflict", message: "Manager binding changed" } }),
    () => { retried = true; }, error => errors.push(error));
  expect(retried).toBe(false);
  expect(errors).toHaveLength(1);
});

test("non-conflict source failures remain explicit and do not retry", async () => {
  const errors: unknown[] = [];
  let retried = false;
  await refreshTranscriptProjection(async () => ({ ok: false, error: { code: "invalid_record", message: "Invalid native record" } }),
    () => { retried = true; }, cause => errors.push(cause));
  expect(retried).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toEqual({ code: "invalid_record", message: "Invalid native record" });
});
