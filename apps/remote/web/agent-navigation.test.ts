import { expect, test } from "bun:test";
import { formatRoute, parseRoute, routeHome, routeThreadId, TABS } from "./src/app/routes";

test("old worker deep links open the original agent in Chats, including inspector links", () => {
  const route = parseRoute("#/workers/background-agent/inspector");
  expect(route).toEqual({ tab: "chats", chat: "ai:background-agent", panel: "inspector" });
  expect(routeThreadId(route)).toBe("background-agent");
});

test("Agents is a navigable directory and old worker home links redirect there", () => {
  const route = parseRoute("#/agents");
  expect(route).toEqual({ tab: "agents" });
  expect(formatRoute(routeHome(route))).toBe("#/agents");
  expect(routeThreadId(route)).toBeNull();
  expect(parseRoute("#/workers")).toEqual(route);
  expect(TABS).toContain("agents");
});

test("Notifications is a persistent top-level destination, not a worker hierarchy", () => {
  expect(parseRoute("#/notifications")).toEqual({ tab: "notifications" });
  expect(TABS).toContain("notifications");
  expect(TABS).not.toContain("workers");
});
