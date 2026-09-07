import { expect, test } from "bun:test";
import { abortable, deadline } from "./src/abortable";
import { createSyncLoop } from "./src/sync-loop";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("selection cancels a hung transport and reconciles immediately", async () => {
  const first = deferred();
  const second = deferred();
  const stale = deferred();
  const signals: AbortSignal[] = [];
  const waits: number[] = [];
  const errors: unknown[] = [];
  const loop = createSyncLoop(async (signal, waitMs) => {
    signals.push(signal); waits.push(waitMs);
    if (signals.length === 1) { first.resolve(); await stale.promise; }
    else { second.resolve(); await new Promise(() => {}); }
  }, (error) => errors.push(error));
  try {
    loop.start();
    await first.promise;
    loop.kick();
    await deadline(second.promise, 200, "Second selection");
    expect(signals[0].aborted).toBe(true);
    expect(waits).toEqual([0, 0]);
    stale.reject(new Error("late failure"));
    await Promise.resolve();
    expect(errors).toEqual([]);
  } finally { loop.stop(); }
  expect(signals[1].aborted).toBe(true);
});

test("deadline recovers even when an underlying bridge ignores cancellation", async () => {
  const recovered = deferred();
  const errors: unknown[] = [];
  let calls = 0;
  const loop = createSyncLoop(async (_signal, waitMs) => {
    if (++calls === 2) { expect(waitMs).toBe(0); recovered.resolve(); }
    await new Promise(() => {});
  }, (error) => errors.push(error), { timeoutMs: 10, retryMs: 1 });
  try {
    loop.start();
    await deadline(recovered.promise, 500, "Recovery");
    expect(String(errors[0])).toContain("Synchronization timed out");
  } finally { loop.stop(); }
});

test("a pre-aborted signal rejects a pending operation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(abortable(new Promise(() => {}), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
