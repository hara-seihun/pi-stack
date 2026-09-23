import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { closeAiChat } from "./chat-lifecycle";

test("closing an AI stops its complete descendant tree before hiding it", async () => {
  const calls: unknown[] = [];
  const api = { async control(input: unknown) { calls.push(input); return { ok: true as const, value: { id: "root", state: "idle", held: true } as Thread }; } };
  expect((await closeAiChat(api, "root")).ok).toBe(true);
  expect(calls).toEqual([{ threadId: "root", action: "stop", descendants: true }, { threadId: "root", action: "update", archived: true }]);
});

test("a failed descendant stop keeps the chat visible and reports the failure", async () => {
  const calls: unknown[] = [];
  const result = { ok: false as const, error: { code: "unavailable" as const, message: "Child owner unavailable" } };
  const api: Pick<ThreadApi, "control"> = { async control(input) { calls.push(input); return result; } };
  expect(await closeAiChat(api, "root")).toEqual(result);
  expect(calls).toHaveLength(1);
});
