import { describe, expect, test } from "bun:test";
import { moveThreadToIndex, threadsInOrder } from "./src/thread-order";

const threads = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }];

describe("thread ordering", () => {
  test("moves a thread without changing its object", () => {
    const reordered = moveThreadToIndex(threads, "c", 1);
    expect(reordered.map(({ id }) => id)).toEqual(["a", "c", "b"]);
    expect(reordered[1]).toBe(threads[2]);
    expect(threads.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });

  test("applies a saved order while retaining newly discovered threads", () => {
    expect(threadsInOrder(threads, ["c", "a"]).map(({ id }) => id)).toEqual(["c", "a", "b"]);
  });
});
