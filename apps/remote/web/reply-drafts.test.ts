import { expect, test } from "bun:test";
import { ReplyDrafts } from "./src/reply-drafts";

function drafts() {
  const items = new Map<string, string>();
  return new ReplyDrafts({
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: key => { items.delete(key); },
  }, id => `reply:${id}`);
}

const target = { identity: { id: "pi/thread/message", timestamp: 1, sender: { id: "agent", name: "Agent" } }, text: "Original" };

test("an accepted reply clears its original chat after switching without touching the new chat", () => {
  const selections = drafts();
  selections.save("first", target);
  const sentVersion = selections.version("first");
  selections.save("second", { ...target, text: "Other conversation" });
  expect(selections.accept("first", sentVersion)).toBe(true);
  expect(selections.load("first")).toBeNull();
  expect(selections.load("second")?.text).toBe("Other conversation");
});

test("a late receipt does not clear a newer reply choice in the same chat", () => {
  const selections = drafts();
  selections.save("first", target);
  const sentVersion = selections.version("first");
  selections.save("first", { ...target, text: "New choice" });
  expect(selections.accept("first", sentVersion)).toBe(false);
  expect(selections.load("first")?.text).toBe("New choice");
});
