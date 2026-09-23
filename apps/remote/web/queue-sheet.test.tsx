import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueuedMessage } from "./src/types";
import { QueueSheet, queueMessageStatus } from "./src/features/queue/QueueSheet";

const message = (patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: "message", text: "Do the next thing", delivery: "queue", state: "queued",
  canSteer: true, canHardSteer: true, canCancel: true, createdAt: "", ...patch,
});

function render(messages: QueuedMessage[], held = false) {
  return renderToStaticMarkup(createElement(QueueSheet, {
    open: true, messages, held, pending: false, onClose() {}, onAction() {},
  }));
}

test("queue wording is composed from delivery, dispatch and the thread's held state", () => {
  expect(queueMessageStatus(message(), false)).toBe("Queued for after completion");
  expect(queueMessageStatus(message({ delivery: "steer" }), false)).toBe("Steering after current tool calls");
  expect(queueMessageStatus(message({ delivery: "hardSteer" }), false)).toBe("Interrupting current work");
  expect(queueMessageStatus(message(), true)).toBe("Held until resumed");
  expect(queueMessageStatus(message({ state: "dispatched" }), true)).toBe("Sent to agent");
});

test("only queued messages offer actions, and held threads cannot steer", () => {
  const queued = render([message()]);
  expect(queued).toContain("Edit");
  expect(queued).toContain("Make it steer");
  expect(queued).toContain("Hard steer");
  expect(queued).toContain("Remove");

  const held = render([message()], true);
  expect(held).toContain("Edit");
  expect(held).toContain("Remove");
  expect(held).not.toContain("Make it steer");
  expect(held).not.toContain("Hard steer");

  const dispatched = render([message({ state: "dispatched" })]);
  expect(dispatched).toContain("Sent to agent");
  expect(dispatched).not.toContain("Edit");
  expect(dispatched).not.toContain("Remove");
});
