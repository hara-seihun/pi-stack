import { describe, expect, test } from "bun:test";
import { createStateReconciler, parseStateVersion } from "./reconciliation.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("state reconciliation targets", () => {
  test("parses an epoch and monotonic version from the mutation acknowledgement", () => {
    expect(parseStateVersion("epoch-a/42")).toEqual({ epoch: "epoch-a", version: 42 });
    expect(parseStateVersion("epoch-a/not-a-number")).toBeNull();
    expect(parseStateVersion("42")).toBeNull();
  });

  test("retains the newest target until an authoritative snapshot reaches it", () => {
    const storage = memoryStorage();
    let polls = 0;
    const reconciler = createStateReconciler(storage, () => { polls++; });

    expect(reconciler.require("epoch-a/12", "epoch-a", 8)).toBeTrue();
    expect(reconciler.require("epoch-a/10", "epoch-a", 10)).toBeTrue();
    expect(reconciler.target).toEqual({ epoch: "epoch-a", version: 12 });
    expect(polls).toBe(2);
    expect(reconciler.accepts("epoch-a", 11)).toBeFalse();
    expect(reconciler.accepts("epoch-a", 12)).toBeTrue();
    expect(reconciler.settle("epoch-a", 11, true)).toBeFalse();
    expect(reconciler.settle("epoch-a", 12, true)).toBeTrue();
    expect(reconciler.target).toBeNull();
  });

  test("restores an unfinished target and accepts a full snapshot from a replacement supervisor", () => {
    const key = "target";
    const storage = memoryStorage({ [key]: "epoch-a/17" });
    const reconciler = createStateReconciler(storage, () => {}, key);

    expect(reconciler.target).toEqual({ epoch: "epoch-a", version: 17 });
    expect(reconciler.settle("epoch-b", 1, false)).toBeFalse();
    expect(reconciler.settle("epoch-b", 1, true)).toBeTrue();
    expect(storage.getItem(key)).toBeNull();
  });
});
