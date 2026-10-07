import { expect, test } from "bun:test";
import { parseRoute, routeThreadId, TABS } from "./src/app/routes";

test("old worker deep links open the original agent in Chats, including inspector links", () => {
  const route = parseRoute("#/workers/background-agent/inspector");
  expect(route).toEqual({ tab: "chats", chat: "ai:background-agent", panel: "inspector" });
  expect(routeThreadId(route)).toBe("background-agent");
});

test("Notifications is a persistent top-level destination, not a worker hierarchy", () => {
  expect(parseRoute("#/notifications")).toEqual({ tab: "notifications" });
  expect(TABS).toContain("notifications");
  expect(TABS).not.toContain("workers");
});
