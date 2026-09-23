import { describe, expect, test } from "bun:test";
import { ReconcilePublisher, ReconcileReplica, readReconcileHave } from "./reconcile.ts";

const transfer = (publisher: ReconcilePublisher, replica: ReconcileReplica, resource = "thread") => {
  const frame = publisher.reconcile(resource, replica.have()[resource] ?? null);
  expect(frame).not.toBeNull();
  const result = replica.apply(frame!);
  expect(result.ok).toBe(true);
  return { frame: frame!, result };
};

describe("JSON reconciliation", () => {
  test("canonical JSON identity, revision reuse, and independent returned copies", () => {
    const publisher = new ReconcilePublisher();
    const replica = new ReconcileReplica();
    const first = publisher.publish("thread", { z: 3, a: { y: 2, x: 1 } });
    expect(publisher.publish("thread", { a: { x: 1, y: 2 }, z: 3 })).toBe(first);
    expect(transfer(publisher, replica).frame.kind).toBe("full");
    expect(publisher.reconcile("thread", first)).toBeNull();
    (replica.get("thread")!.value as { a: { x: number } }).a.x = 900;
    expect(replica.get("thread")!.value).toEqual({ a: { x: 1, y: 2 }, z: 3 });
    expect(replica.have().thread).toBe(first);
    const seeded = new ReconcileReplica();
    seeded.seed("thread", first, { z: 3, a: { y: 2, x: 1 } });
    expect(seeded.have().thread).toBe(first);
    expect(() => seeded.seed("thread", "wrong", {})).toThrow();
  });

  test("nested edits, deletion, string append, and bounded old revision selection", () => {
    const publisher = new ReconcilePublisher({ maxHistoryPerResource: 2 });
    const replica = new ReconcileReplica();
    const old = publisher.publish("thread", { meta: { status: "draft", gone: true }, body: "A".repeat(1000) });
    transfer(publisher, replica);
    publisher.publish("thread", { meta: { status: "edited", here: true }, body: "A".repeat(1000) + "!" });
    const { frame } = transfer(publisher, replica);
    expect(frame.kind).toBe("patch");
    expect(replica.get("thread")!.value).toEqual({ meta: { status: "edited", here: true }, body: "A".repeat(1000) + "!" });
    publisher.publish("thread", { meta: { status: "final" }, body: "A".repeat(1000) + "!!" });
    const revisitor = new ReconcileReplica();
    revisitor.seed("thread", old, { meta: { status: "draft", gone: true }, body: "A".repeat(1000) });
    expect(transfer(publisher, revisitor).frame.kind).toBe("patch");
    publisher.publish("thread", { body: "other" });
    expect(publisher.reconcile("thread", old)?.kind).toBe("full");
  });

  test("large transcript appends, middle insertion and removal, item edits and reorder", () => {
    const publisher = new ReconcilePublisher();
    const replica = new ReconcileReplica();
    const items = Array.from({ length: 60 }, (_, id) => ({ id, text: `message ${id}: ${"x".repeat(100)}` }));
    publisher.publish("thread", items);
    transfer(publisher, replica);
    const states = [
      [...items, { id: 60, text: "last" }],
      [...items.slice(0, 12), { id: -1, text: "inserted" }, ...items.slice(12), { id: 60, text: "last" }],
      [...items.slice(0, 12), ...items.slice(12), { id: 60, text: "last" }],
      items.map(item => item.id === 17 ? { ...item, text: item.text + "changed" } : item),
      [items[1], items[0], ...items.slice(2)],
    ];
    for (const state of states) {
      publisher.publish("thread", state);
      const { frame } = transfer(publisher, replica);
      expect(frame.kind).toBe("patch");
      expect(replica.get("thread")!.value).toEqual(state);
    }
  });

  test("wrong base and tampered result leave prior state intact; full repairs it", () => {
    const publisher = new ReconcilePublisher();
    const replica = new ReconcileReplica();
    publisher.publish("thread", { body: "a".repeat(800) });
    transfer(publisher, replica);
    publisher.publish("thread", { body: "a".repeat(800) + "new" });
    const patch = publisher.reconcile("thread", replica.have().thread)!;
    expect(patch.kind).toBe("patch");
    const initial = replica.get("thread");
    expect(replica.apply({ ...patch, base: "bad" } as typeof patch)).toEqual({ ok: false, reason: "Base revision mismatch" });
    expect(replica.apply({ ...patch, revision: "wrong" })).toEqual({ ok: false, reason: "Result revision mismatch" });
    expect(replica.get("thread")).toEqual(initial);
    expect(replica.apply(publisher.reconcile("thread", null)!)).toMatchObject({ ok: true });
    replica.forget("thread");
    expect(replica.have()).toEqual({});
    replica.clear();
    publisher.forget("thread");
    expect(publisher.reconcile("thread", null)).toBeNull();
  });

  test("limits evict old revisions and replica resources without inventing state", () => {
    const publisher = new ReconcilePublisher({ maxEntries: 2, maxBytes: 2000 });
    const replica = new ReconcileReplica({ maxEntries: 1 });
    const earliest = publisher.publish("thread", { text: "x".repeat(300) });
    publisher.publish("thread", { text: "y".repeat(300) });
    publisher.publish("thread", { text: "z".repeat(300) });
    expect(publisher.reconcile("thread", earliest)?.kind).toBe("full");
    transfer(publisher, replica);
    publisher.publish("other", { value: 2 });
    transfer(publisher, replica, "other");
    expect(replica.get("thread")).toBeUndefined();
    expect(() => publisher.publish("large", "x".repeat(5_000_000))).toThrow();
  });

  test("hostile have maps and prototype keys", () => {
    expect(readReconcileHave({ thread: "v1" })).toEqual({ thread: "v1" });
    expect(readReconcileHave(JSON.parse('{"__proto__":"a","constructor":"b"}'))?.["__proto__"]).toBe("a");
    expect(readReconcileHave({ thread: 1 })).toBeUndefined();
    expect(readReconcileHave({ "": "v1" })).toBeUndefined();
    expect(readReconcileHave(Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), "v"])))).toBeUndefined();
    const publisher = new ReconcilePublisher();
    const replica = new ReconcileReplica();
    const resource = "__proto__";
    publisher.publish(resource, JSON.parse('{"__proto__":{"safe":true},"constructor":"ok"}'));
    const frame = publisher.reconcile(resource, null)!;
    expect(replica.apply(frame).ok).toBe(true);
    expect(replica.have()[resource]).toBe(frame.revision);
    expect(({} as { safe?: boolean }).safe).toBeUndefined();
  });
});
