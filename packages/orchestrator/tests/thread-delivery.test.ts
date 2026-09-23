import { afterEach, expect, it, vi } from "vitest";
import { resolveDelivery, type Delivery, type SendThread, type ThreadApi } from "../src/threads/contracts.js";
import { threadTools } from "../src/threads/pi-tools.js";

const modes: Delivery[] = ["queue", "steer", "hardSteer"];
afterEach(() => vi.restoreAllMocks());

it.each([undefined, "sender"])("defaults API delivery for sender %s and preserves explicit choices", senderId => {
  expect(resolveDelivery({ senderId })).toBe(senderId ? "steer" : "queue");
  for (const delivery of modes) expect(resolveDelivery({ senderId, delivery })).toBe(delivery);
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
