import { expect, test } from "bun:test";
import type { Session } from "../server/protocol";
import { validateStreamSnapshot, validateThreadObservation } from "../shared/state-validation";
import { threadStatus, attentionRank } from "./src/features/status/thread-status";
import { parseRoute } from "./src/app/routes";
import { queueMessageStatus } from "./src/features/queue/QueueSheet";
import { AppUpdater } from "./src/app-update-state";

const idle = { lifecycle: { kind: "idle" as const }, state: "idle" as const, activity: "idle" as const, held: false, activeTools: [], idleUnread: false, humanAttention: true, archivedAt: null };
const session = { ...idle, id: "parent", origin: "person", queuedMessages: [] };

test("invalid observations are rejected at the stream boundary even when held or archived", () => {
  for (const patch of [{ state: "future" }, { activity: "running" }, { activity: undefined }, { lifecycle: { kind: "future" } }]) {
    for (const placement of [{ held: true }, { archivedAt: "2026-01-01", lifecycle: { kind: "archived" } }]) {
      expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, ...placement, ...patch }] })).toThrow("invalid state");
    }
  }
  expect(() => validateThreadObservation({ state: "idle" })).toThrow("invalid state");
  expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, lifecycle: undefined }] })).toThrow("expected object");
});

test("durable wait identities stay distinct while human activity is one Waiting state", () => {
  const dependencies: NonNullable<Session["waitingOnAgents"]>[] = [
    { kind: "agents", threadIds: ["child"], after: {}, reason: "Worker result", since: 1000 },
    { kind: "job", jobId: "job", reason: "Heavy job", since: 1000 },
    { kind: "deployment", publicationId: "PUB", reason: "Release", since: 1000 },
    { kind: "message", fromThreadId: "collaborator", reason: "Reply", since: 1000 },
  ];
  const observations = dependencies.map(waitingOnAgents => ({ ...session, activity: "awaiting" as const, waitingOnAgents,
    lifecycle: { kind: "waiting" as const, target: waitingOnAgents.kind, reason: waitingOnAgents.reason, since: waitingOnAgents.since, dependency: waitingOnAgents } }));
  const statuses = observations.map(threadStatus);
  expect(new Set(statuses.map(status => status.key))).toEqual(new Set(["waiting"]));
  expect(statuses.map(status => status.title)).toEqual(dependencies.map(wait => wait.reason));
  expect(statuses.every(status => !status.busy && !status.attention && attentionRank(status) === 11)).toBe(true);
  const subscription = threadStatus({ ...idle, lifecycle: { kind: "waiting", target: "agents", reason: "Waiting for agent results", since: 1000 } });
  expect(subscription).toMatchObject({ key: "waiting", busy: false, title: "Waiting for agent results" });
  for (const row of observations) validateStreamSnapshot("state", { type: "state", sessions: [row] });
  for (const patch of [{ activity: "thinking" }, { activity: "awaiting" }, { waitingForChildren: true }, { dependencies: ["child"] }]) {
    expect(threadStatus({ ...idle, ...patch } as any)).toMatchObject({ key: "idle", busy: false });
    expect(threadStatus({ ...idle, ...patch, lifecycle: undefined } as any)).toMatchObject({ key: "reporting_error", busy: false, attention: true });
  }
});

test("legacy wait evidence stays at the boundary while the owner supplies its failure lifecycle", () => {
  const legacy = { reason: "Original evidence", since: 1000, threadIds: [] };
  expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, activity: "awaiting", waitingOnAgents: legacy }] })).toThrow("wait type missing");
  const defect = { ...session, activity: "status_error", waitingOnAgents: legacy,
    lifecycle: { kind: "failed" as const, reason: "Invalid owned dependency wait", control: "cancel_wait" as const } };
  validateStreamSnapshot("state", { type: "state", sessions: [defect] });
  expect(threadStatus(defect)).toMatchObject({ key: "error", title: "Invalid owned dependency wait", attention: true });
  expect(defect.waitingOnAgents.reason).toBe("Original evidence");
  expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, waitingOnAgents: { ...legacy, kind: "available" } }] })).toThrow("invalid state");
});

test("route boundaries allow the empty entrance but reject malformed or undescribed routes", () => {
  expect(parseRoute("")).toEqual({ tab: "chats", chat: null, panel: null });
  for (const hash of ["#/unknown", "#/chats/unknown/id", "#/chats/ai", "#/workers/id/unknown", "#/chats/ai/%zz"]) expect(() => parseRoute(hash)).toThrow();
  expect(parseRoute("#/chats/room/room-id/settings")).toEqual({ tab: "chats", chat: "room:room-id", panel: "settings" });
});

test("queue boundaries do not turn unknowns into sent messages", () => {
  expect(() => queueMessageStatus({ state: "new" as any, delivery: "queue" }, false)).toThrow("undescribed state");
  expect(() => queueMessageStatus({ state: "queued", delivery: "new" as any }, false)).toThrow("invalid state");
});

test("unknown Android install acknowledgement is a retryable error, never Restarting", async () => {
  const updater = new AppUpdater({ check: async () => ({ update: { kind: "web", revision: "r" } } as any), install: async () => ({ status: "future" } as any), attempted: () => false, remember: () => {} });
  await updater.check();
  expect(updater.snapshot()).toMatchObject({ busy: false, approval: false });
  expect(updater.snapshot().error).toContain("invalid state");
  expect(updater.snapshot().status).not.toBe("Restarting…");
});
