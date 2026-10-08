import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { closeAiChat } from "./chat-lifecycle";

test("closing delegates one selected agent to its owner", async () => {
  const calls: unknown[] = [];
  const api = { async control(input: unknown) { calls.push(input); return { ok: true as const, value: { id: "root", state: "idle", held: true } as Thread }; } };
  expect((await closeAiChat(api, "root")).ok).toBe(true);
  expect(calls).toEqual([{ threadId: "root", action: "close" }]);
});

test("unconfirmed native cancellation keeps the agent visible", async () => {
  const calls: unknown[] = [];
  const result = { ok: false as const, error: { code: "cancellation_failed" as const, message: "Native cancellation unconfirmed" } };
  const api: Pick<ThreadApi, "control"> = { async control(input) { calls.push(input); return result; } };
  expect(await closeAiChat(api, "root")).toEqual(result);
  expect(calls).toHaveLength(1);
});
