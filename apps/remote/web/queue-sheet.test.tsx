import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueuedMessage } from "./src/types";
import { QueueSheet, queueMessageStatus } from "./src/features/queue/QueueSheet";
const message = (patch: Partial<QueuedMessage> = {}): QueuedMessage => ({ id: "message", text: "Next thing", state: "queued", delivery: "pending", canCancel: true, createdAt: "", ...patch });
function render(messages: QueuedMessage[], held = false) {
  return renderToStaticMarkup(createElement(QueueSheet, { open: true, messages, held, pending: false, onClose() {}, onAction() {} }));
}
test("one mode: queued input waits for output boundary; a hold still owns resumption", () => {
  expect(queueMessageStatus(message(), false)).toBe("Waiting for the next output boundary");
  expect(queueMessageStatus(message(), true)).toBe("Held until resumed");
});
test("uncertain acknowledgement offers no replay, cancellation or editing", () => {
  for (const acknowledgement of ["pending", "unconfirmed", undefined] as const) {
    const value = message({ state: "dispatched", acknowledgement });
    const markup = render([value]);
    expect(markup).not.toContain("Remove");
    expect(markup).not.toContain("Edit");
    expect(markup).not.toContain("steer");
  }
  expect(queueMessageStatus(message({ state: "dispatched", acknowledgement: "unconfirmed" }), false)).toContain("not resent");
});
test("only owner-cancellable pending input can be edited or removed", () => {
  expect(render([message()])).toContain("Edit");
  expect(render([message()], true)).toContain("Remove");
  expect(render([message({ canCancel: false })])).not.toContain("Remove");
  expect(render([message()])).not.toContain("steer");
});
