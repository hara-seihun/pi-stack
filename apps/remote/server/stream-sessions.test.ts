import { expect, test } from "bun:test";
import type { Session } from "./protocol";
import { fleetSessions, RECENT_FLEET_MS, streamSessions } from "./stream-sessions";
import { isStreamSnapshot, streamWants } from "../shared/stream-resources";

const now = Date.parse("2026-09-28T20:00:00Z");
const old = new Date(now - RECENT_FLEET_MS - 1).toISOString();
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "fleet", model: "m", name: id, color: null, cwd: "/", workspaceName: "/",
  environment: "local", state: "idle", held: false, activity: "idle", activeTools: [], provider: "p",
  createdAt: old, updatedAt: old, revision: 1, idleUnread: true, queuedMessages: [], archivedAt: null, ...extra,
} as Session);

test("every connection carries the person's threads and only current fleet threads", () => {
  const sessions = [
    session("mine", { origin: "person" }),
    session("settled"),
    session("recent", { updatedAt: new Date(now - 1000).toISOString() }),
    session("orchestrator"),
    session("running-child", { parentId: "orchestrator", state: "running" }),
    session("waiting", { activity: "awaiting" }),
    session("finished-child", { parentId: "waiting" }),
    session("open"),
  ];
  expect(streamSessions(sessions, "open", now).map(item => item.id))
    .toEqual(["mine", "recent", "orchestrator", "running-child", "waiting", "finished-child", "open"]);
  expect(streamSessions(sessions, null, now).map(item => item.id)).not.toContain("open");
  const everyone = sessions.map(item => ({ ...item, origin: "person" as const }));
  expect(streamSessions(everyone, null, now)).toBe(everyone);
  expect(fleetSessions(sessions).map(item => item.id)).not.toContain("mine");
});

test("the complete fleet list is a resource only the Workers screen's All view asks for", () => {
  expect(streamWants({ session: null })).not.toContain("workers");
  expect(streamWants({ session: null, workers: true })).toContain("workers");
  expect(isStreamSnapshot("workers", { type: "workers", sessions: [] })).toBe(true);
});
