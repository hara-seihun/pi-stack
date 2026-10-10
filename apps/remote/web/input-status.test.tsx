import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadInputState } from "../../../packages/orchestrator/src/threads/contracts";
import { InputStatus, inputPresentation } from "./src/features/conversation/input-status";
import { validateInputState } from "../shared/state-validation";
import { entryFromHead } from "./src/features/conversation/transcript-entries";
const queued: ThreadInputState = { id: "work-1", threadId: "thread", senderId: null, source: "explicit", delivery: "steer", priority: "human", state: "queued", createdAt: 100, insertedAt: null, landedAt: null };

test("owner custody, native acceptance, consumption and terminal outcomes remain distinct", () => {
  const states: ThreadInputState[] = [queued, { ...queued, state: "dispatched" }, { ...queued, state: "dispatched", insertedAt: 101 },
    { ...queued, state: "dispatched", insertedAt: 101, landedAt: 102 },
    { ...queued, state: "done", outcome: "complete" }, { ...queued, state: "done", outcome: "failed", error: "Provider refused the turn" },
    { ...queued, state: "done", outcome: "cancelled" }, { ...queued, state: "done" }];
  expect(new Set(states.map(state => inputPresentation(state).label)).size).toBe(states.length);
  for (const input of states) {
    validateInputState(input);
    const markup = renderToStaticMarkup(<InputStatus inputId={input.id} input={input} />);
    expect(markup).toContain('data-input-id="work-1"');
  }
  expect(inputPresentation(states[1]!).label).not.toContain("progress");
  expect(inputPresentation(states[5]!).detail).toBe("Provider refused the turn");
  expect(inputPresentation(states[7]!).label).not.toBe("Turn finished");
});

test("receipt updates invalidate memoized bubble without changing canonical message identity", () => {
  const head = { seq: 1, id: "body", sourceKey: "native-user:0", kind: "user" as const, size: 2, text: "hi", inputId: queued.id, inputState: queued };
  const before = entryFromHead(head);
  const after = entryFromHead({ ...head, inputState: { ...queued, state: "done", outcome: "complete" } });
  expect(after.key).toBe(before.key);
  expect(after.itemId).toBe(before.itemId);
  expect(after.signature).not.toBe(before.signature);
  expect(() => entryFromHead({ ...head, inputState: { ...queued, id: "other-work" } })).toThrow("identity mismatch");
  expect(() => validateInputState({ ...queued, state: "invented" })).toThrow("Input state");
});
