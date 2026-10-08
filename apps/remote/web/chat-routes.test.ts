import { expect, test } from "bun:test";
import { formatRoute, parseRoute, routeChatId, routeThreadId } from "./src/app/routes";

test("chat routes represent agent threads and shared rooms, rejecting retired human conversations", () => {
  const agent = parseRoute("#/chats/ai/thread/queue");
  const room = parseRoute("#/chats/room/shared/settings");
  expect(routeChatId(agent)).toBe("ai:thread");
  expect(routeThreadId(agent)).toBe("thread");
  expect(formatRoute(agent)).toBe("#/chats/ai/thread/queue");
  expect(routeChatId(room)).toBe("room:shared");
  expect(routeThreadId(room)).toBeNull();
  expect(formatRoute(room)).toBe("#/chats/room/shared/settings");
  expect(() => parseRoute("#/chats/human/contact")).toThrow("Chat route kind");
});
