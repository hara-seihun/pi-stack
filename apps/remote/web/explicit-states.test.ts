import { expect, test } from "bun:test";
import type { Session } from "../server/protocol";
import { validateStreamSnapshot, validateThreadObservation } from "../shared/state-validation";
import { threadStatus, attentionRank } from "./src/features/status/thread-status";
import { parseRoute } from "./src/app/routes";
import { queueMessageStatus } from "./src/features/queue/QueueSheet";
import { AppUpdater } from "./src/app-update-state";

const idle = { state: "idle" as const, lifecycle: { kind: "idle" as const }, activity: "idle" as const, held: false, activeTools: [], idleUnread: false, archivedAt: null };
const session = { ...idle, id: "parent", origin: "person", queuedMessages: [] };

test("invalid lifecycle and activity are rejected even when held or archived", () => {
  for (const lifecycle of [{ kind: "future" }, { kind: "working", phase: "thinking" }, { kind: "waiting", target: "capacity", since: 1 }, { kind: "failed", control: "none" }, undefined]) {
    expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, held: true, lifecycle }] })).toThrow();
    expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, archivedAt: "2026", lifecycle }] })).toThrow();
  }
  expect(threadStatus({ ...idle, lifecycle: undefined, held: true } as any)).toMatchObject({ key: "reporting_error", attention: true, busy: false });
  expect(() => validateThreadObservation({ state: "idle" })).toThrow("invalid state");
});

test("durable wait identities stay distinct while human activity is one Waiting state", () => {
  const dependencies: NonNullable<Session["waitingOnAgents"]>[] = [
    { kind: "agents", threadIds: ["child"], after: {}, since: 1000 },
    { kind: "job", jobId: "job", since: 1000 },
    { kind: "deployment", publicationId: "PUB", since: 1000 },
    { kind: "message", fromThreadId: "collaborator", since: 1000 },
  ] as NonNullable<Session["waitingOnAgents"]>[];
  const rows = dependencies.map(waitingOnAgents => ({ ...session, activity: "awaiting" as const, waitingOnAgents, lifecycle: { kind: "waiting" as const, target: waitingOnAgents.kind, since: 1000, dependency: waitingOnAgents } }));
  const statuses = rows.map(row => threadStatus(row));
  expect(new Set(statuses.map(status => status.key))).toEqual(new Set(["waiting"]));
  expect(new Set(statuses.map(status => status.label)).size).toBe(dependencies.length);
  expect(statuses.every(status => !status.busy && !status.attention)).toBe(true);
  expect(threadStatus({ ...idle, dependencies: ["not-authoritative-state"] } as any).key).toBe("idle");
  expect(threadStatus({ ...idle, activity: "thinking" }).key).toBe("idle");
  for (const row of rows) validateStreamSnapshot("state", { type: "state", sessions: [row] });
});

test("legacy waits preserve evidence as defects, unknown waits cannot become agent dependencies", () => {
  const failed = { kind: "failed" as const, reason: "Invalid owned dependency wait", control: "cancel_wait" as const };
  const legacy = { reason: "Original evidence", since: 1000, threadIds: [] };
  expect(threadStatus({ ...idle, humanAttention: true, activity: "status_error", waitingOnAgents: legacy, lifecycle: failed } as any)).toMatchObject({ key: "error", attention: true, title: "Invalid owned dependency wait" });
  validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, activity: "status_error", waitingOnAgents: legacy, lifecycle: failed }] });
  expect(legacy.reason).toBe("Original evidence");
  expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, lifecycle: { kind: "waiting", target: "available", since: 1 } }] })).toThrow();
});

test("route boundaries allow the empty entrance but reject malformed or undescribed routes", () => {
  expect(parseRoute("")).toEqual({ tab: "chats", chat: null, panel: null });
  for (const hash of ["#/unknown", "#/chats/unknown/id", "#/chats/ai", "#/workers/id/unknown", "#/chats/ai/%zz"]) expect(() => parseRoute(hash)).toThrow();
  expect(parseRoute("#/chats/room/room-id/settings")).toEqual({ tab: "chats", chat: "room:room-id", panel: "settings" });
});

test("queue boundaries do not turn unknowns into sent messages", () => {
  expect(() => queueMessageStatus({ state: "new" as any }, false)).toThrow("undescribed state");
  expect(() => queueMessageStatus({ state: "dispatched", acknowledgement: "new" as any }, false)).toThrow("undescribed state");
});

test("unknown Android install acknowledgement is a retryable error, never Restarting", async () => {
  const updater = new AppUpdater({ check: async () => ({ update: { kind: "web", revision: "r" } } as any), install: async () => ({ status: "future" } as any), attempted: () => false, remember: () => {} });
  await updater.check();
  expect(updater.snapshot()).toMatchObject({ busy: false, approval: false });
  expect(updater.snapshot().error).toContain("invalid state");
  expect(updater.snapshot().status).not.toBe("Restarting…");
});
