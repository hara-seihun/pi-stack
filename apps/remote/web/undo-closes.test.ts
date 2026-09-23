import { expect, test } from "bun:test";
import type { Chat } from "./src/chats";
import { shouldUndoClose, UndoCloses } from "./src/undo-closes";

test("archive undo does not steal editing, dialog, drawing or redo shortcuts", () => {
  const original = globalThis.Element;
  class Target {
    constructor(private editable = false) {}
    closest() { return this.editable ? this : null; }
  }
  globalThis.Element = Target as unknown as typeof Element;
  const root = { querySelector: () => null } as unknown as Document;
  const event = { key: "z", ctrlKey: true, metaKey: false, target: new Target() } as unknown as KeyboardEvent;
  try {
    expect(shouldUndoClose(event, root)).toBe(true);
    expect(shouldUndoClose({ ...event, ctrlKey: false, metaKey: true }, root)).toBe(true);
    expect(shouldUndoClose({ ...event, target: new Target(true) } as unknown as KeyboardEvent, root)).toBe(false);
    expect(shouldUndoClose({ ...event, shiftKey: true }, root)).toBe(false);
    expect(shouldUndoClose({ ...event, defaultPrevented: true }, root)).toBe(false);
    expect(shouldUndoClose(event, { querySelector: () => ({}) } as unknown as Document)).toBe(false);
  } finally { globalThis.Element = original; }
});

const chat = (id: string) => ({ id: `ai:${id}`, kind: "ai", title: id, session: { id } }) as Chat;
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("only successful closes are undoable, in tap order even when requests finish out of order", async () => {
  const undo = new UndoCloses();
  undo.setScope("alice:host");
  const first = deferred();
  const second = deferred();
  const closingFirst = undo.close(chat("first"), () => first.promise);
  const closingSecond = undo.close(chat("second"), () => second.promise);
  expect(undo.snapshot().entries).toHaveLength(0);
  second.resolve();
  expect(await closingSecond).toEqual({ ok: true });
  first.resolve();
  expect(await closingFirst).toEqual({ ok: true });
  const restored: string[] = [];
  expect(await undo.undo(async item => { restored.push(item.id); })).toEqual({ ok: true });
  expect(await undo.undo(async item => { restored.push(item.id); })).toEqual({ ok: true });
  expect(restored).toEqual(["ai:second", "ai:first"]);
  expect(await undo.undo(async () => {})).toBeNull();
});

test("failed close is not recorded and can be retried; failed restore retains its place", async () => {
  const undo = new UndoCloses();
  undo.setScope("alice:host");
  expect(await undo.close(chat("one"), async () => { throw new Error("archive failed"); })).toEqual({ ok: false, error: "archive failed" });
  expect(undo.snapshot().entries).toHaveLength(0);
  expect(await undo.close(chat("one"), async () => {})).toEqual({ ok: true });
  expect(await undo.undo(async () => { throw new Error("offline"); })).toEqual({ ok: false, error: "offline" });
  expect(undo.snapshot().entries.map(item => item.chat.id)).toEqual(["ai:one"]);
  expect(undo.snapshot().error).toBe("offline");
  expect(await undo.undo(async () => {})).toEqual({ ok: true });
  expect(undo.snapshot().entries).toHaveLength(0);
  expect(undo.snapshot().error).toBe("");
});

test("double undo and double close cannot issue duplicate requests", async () => {
  const undo = new UndoCloses();
  undo.setScope("alice:host");
  const closing = deferred();
  const first = undo.close(chat("one"), () => closing.promise);
  expect(await undo.close(chat("one"), async () => { throw new Error("duplicate close"); })).toBeNull();
  expect(await undo.undo(async () => { throw new Error("premature restore"); })).toBeNull();
  closing.resolve();
  await first;
  const restoring = deferred();
  const firstUndo = undo.undo(() => restoring.promise);
  expect(await undo.undo(async () => { throw new Error("duplicate restore"); })).toBeNull();
  expect(await undo.close(chat("one"), async () => { throw new Error("close during restore"); })).toBeNull();
  restoring.resolve();
  expect(await firstUndo).toEqual({ ok: true });
});

test("person or environment switch discards old closes, including responses still in flight", async () => {
  const undo = new UndoCloses();
  undo.setScope("alice:host-a");
  await undo.close(chat("old"), async () => {});
  const closing = deferred();
  const staleClose = undo.close(chat("later"), () => closing.promise);
  undo.setScope("alice:host-b");
  closing.resolve();
  expect(await staleClose).toBeNull();
  expect(undo.snapshot().entries).toHaveLength(0);
  await undo.close(chat("current"), async () => {});
  const restoring = deferred();
  const staleUndo = undo.undo(() => restoring.promise);
  undo.setScope("bob:host-b");
  restoring.reject(new Error("old request failed"));
  expect(await staleUndo).toBeNull();
  expect(undo.snapshot()).toEqual({ entries: [], restoring: false, error: "" });
});
