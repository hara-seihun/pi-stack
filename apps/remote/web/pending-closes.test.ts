import { expect, test } from "bun:test";
import { hideClosing, reconcileCloses, withClose, withoutClose, type PendingCloses } from "./src/pending-closes";

test("a closing chat leaves the list at once, returns if the close fails, and is forgotten once the server dropped it", () => {
  const rows = [{ chat: { id: "ai:a" as const } }, { chat: { id: "human:b" as const } }];
  let pending: PendingCloses = new Set();
  pending = withClose(pending, "ai:a");
  expect(withClose(pending, "ai:a")).toBe(pending);
  expect(hideClosing(rows, pending).map(row => row.chat.id)).toEqual(["human:b"]);
  // Still in flight and still listed by the server: keep hiding.
  expect(reconcileCloses(pending, ["ai:a", "human:b"])).toBe(pending);
  // The server no longer lists it: nothing left to hide.
  expect(reconcileCloses(pending, ["human:b"]).size).toBe(0);
  // A failed close puts it straight back.
  expect(hideClosing(rows, withoutClose(pending, "ai:a")).length).toBe(2);
  expect(withoutClose(pending, "human:b")).toBe(pending);
  expect(hideClosing(rows, new Set())).toBe(rows);
});
