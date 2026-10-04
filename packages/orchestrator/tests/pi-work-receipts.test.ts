import { expect, it } from "vitest";
import { piWorkReceipts } from "../src/threads/pi-work-receipts.js";

it("recovers unlanded steers from a cancelled receipt written by an earlier runner", () => {
  const input = (workId: string, delivery = "steer") => ({ type: "custom", customType: "thread_input", data: { workId, delivery, message: "same text" } });
  const user = { type: "message", message: { role: "user", content: [{ type: "text", text: "same text" }] } };
  const entries = [input("root", "prompt"), user, input("landed"), user, input("unlanded"),
    { type: "custom", customType: "thread_settled", data: { workIds: ["root", "landed", "unlanded"], outcome: "cancelled" } }];
  expect(piWorkReceipts(entries)).toMatchObject({ acceptedWorkIds: ["root", "landed"], completedWorkIds: ["root", "landed"], landedWorkIds: ["root", "landed"], unlandedWorkIds: [] });
  expect(piWorkReceipts([...entries, input("unlanded"), user,
    { type: "custom", customType: "thread_settled", data: { workIds: ["unlanded"], outcome: "complete" } }])).toMatchObject({
    acceptedWorkIds: ["root", "landed", "unlanded"], completedWorkIds: ["root", "landed", "unlanded"], landedWorkIds: ["root", "landed", "unlanded"], unlandedWorkIds: [],
  });
});
