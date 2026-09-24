import { afterEach, expect, it, vi } from "vitest";
import { resolveDelivery, type Delivery, type SendThread, type SpawnThread, type ThreadApi } from "../src/threads/contracts.js";
import { threadTools } from "../src/threads/pi-tools.js";

const modes: Delivery[] = ["queue", "steer", "hardSteer"];
afterEach(() => vi.restoreAllMocks());

it.each([undefined, "sender"])("defaults API delivery for sender %s and preserves explicit choices", senderId => {
  expect(resolveDelivery({ senderId })).toBe(senderId ? "steer" : "queue");
  for (const delivery of modes) expect(resolveDelivery({ senderId, delivery })).toBe(delivery);
});

it("defaults bounded tool workers to ephemeral and accepts an explicit persistent choice", async () => {
  const spawn = vi.fn(async (_input: SpawnThread) => ({ ok: true as const, value: {} }));
  const tool = threadTools({ threadId: "parent", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: { spawn } as unknown as ThreadApi })
    .find(tool => tool.name === "thread_spawn")!;
  for (const [choice, expected] of [[undefined, true], [true, true], [false, false]] as const) {
    await tool.execute("call", { message: "Build and deliver a real artifact", ephemeral: choice }, undefined, undefined, {} as never);
    expect(spawn.mock.calls.at(-1)?.[0]).toMatchObject({ parentId: "parent", ephemeral: expected, message: "Build and deliver a real artifact" });
  }
});

it.each(["in-process", "http"])("offers only steer and hard steer in the %s send tool", async transport => {
  const send = vi.fn(async (_input: SendThread) => ({ ok: true as const, value: {} }));
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, value: {} }));
  const tool = threadTools({
    threadId: "sender", cwd: "/work", sessionFile: "/work/session.jsonl", args: [],
    env: { PI_THREAD_API_URL: "http://owner/v1/threads" },
    ...(transport === "in-process" ? { threads: { send } as unknown as ThreadApi } : {}),
  }).find(tool => tool.name === "thread_send")!;
  expect(JSON.stringify(tool.parameters)).not.toContain('"queue"');
  for (const delivery of [undefined, "steer", "hardSteer"] as const) {
    await tool.execute("call", { threadId: "recipient", text: "work", delivery }, undefined, undefined, {} as never);
    const input = transport === "in-process" ? send.mock.calls.at(-1)?.[0]
      : JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
    expect(input).toEqual({ requestId: "sender:call", threadId: "recipient", senderId: "sender", text: "work", delivery: delivery ?? "steer", source: "explicit" });
  }
});
