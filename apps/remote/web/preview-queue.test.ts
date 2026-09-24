import { expect, test } from "bun:test";
import { PreviewQueue } from "./src/preview-queue";

test("preview admission bounds concurrency and removes cancelled offscreen work", async () => {
  const queue = new PreviewQueue();
  const controller = new AbortController();
  const first = await queue.acquire(controller.signal);
  const second = await queue.acquire(controller.signal);
  let started = false;
  const cancelled = new AbortController();
  const skipped = queue.acquire(cancelled.signal);
  const third = queue.acquire(controller.signal).then(release => { started = true; return release; });
  await Promise.resolve();
  expect(started).toBe(false);
  cancelled.abort();
  expect(await skipped).toBeNull();
  first!();
  const release = await third;
  expect(started).toBe(true);
  first!();
  second!();
  release!();
  expect(await queue.acquire(cancelled.signal)).toBeNull();
  (await queue.acquire(controller.signal))!();
});
