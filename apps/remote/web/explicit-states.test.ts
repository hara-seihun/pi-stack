import { expect, test } from "bun:test";
import type { Session } from "../server/protocol";
import { validateStreamSnapshot, validateThreadObservation } from "../shared/state-validation";
import { threadStatus, attentionRank } from "./src/features/status/thread-status";
import { parseRoute } from "./src/app/routes";
import { parseWriteFrame } from "./src/write-wire";
import { queueMessageStatus } from "./src/features/queue/QueueSheet";
import { AppUpdater } from "./src/app-update-state";

const idle = { state: "idle" as const, activity: "idle" as const, held: false, activeTools: [], idleUnread: false, archivedAt: null };
const session = { ...idle, id: "parent", origin: "person", queuedMessages: [] };

test("invalid lifecycle and activity are rejected even when held or archived", () => {
  for (const patch of [{ state: "future" }, { activity: "running" }, { activity: undefined }]) {
    expect(() => threadStatus({ ...idle, ...patch, held: true } as any)).toThrow("invalid state");
    expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, ...patch }] })).toThrow("invalid state");
  }
  expect(() => validateThreadObservation({ state: "idle" })).toThrow("invalid state");
});

test("durable dependency types stay distinct from each other and idle", () => {
  const dependencies: NonNullable<Session["waitingOnAgents"]>[] = [
    { kind: "agents", threadIds: ["child"], after: {}, reason: "Worker result", since: 1000 },
    { kind: "job", jobId: "job", reason: "Heavy job", since: 1000 },
    { kind: "deployment", publicationId: "PUB", reason: "Release", since: 1000 },
    { kind: "message", fromThreadId: "collaborator", reason: "Reply", since: 1000 },
  ];
  const statuses = dependencies.map(waitingOnAgents => threadStatus({ ...idle, activity: "awaiting", waitingOnAgents }));
  expect(new Set(statuses.map(status => status.key)).size).toBe(4);
  expect(statuses.every(status => status.busy && !status.attention && attentionRank(status) === 11)).toBe(true);
  expect(threadStatus(idle).busy).toBe(false);
  expect(threadStatus({ ...idle, activity: "thinking" })).toMatchObject({ key: "reporting_error", busy: false, attention: true });
  expect(threadStatus({ ...idle, activity: "awaiting" })).toMatchObject({ key: "reporting_error", busy: false, attention: true });
  expect(threadStatus({ ...idle, activity: "awaiting", waitingForChildren: true } as any)).toMatchObject({ key: "reporting_error", busy: false, attention: true });
  for (const waitingOnAgents of dependencies) validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, activity: "awaiting", waitingOnAgents }] });
});

test("legacy waits preserve evidence as defects, unknown waits cannot become agent dependencies", () => {
  const legacy = { reason: "Original evidence", since: 1000, threadIds: [] };
  expect(threadStatus({ ...idle, activity: "awaiting", waitingOnAgents: legacy } as any)).toMatchObject({ label: "Wait type missing", attention: true });
  expect(() => validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, activity: "awaiting", waitingOnAgents: legacy }] })).toThrow("wait type missing");
  validateStreamSnapshot("state", { type: "state", sessions: [{ ...session, activity: "status_error", waitingOnAgents: legacy }] });
  expect(legacy.reason).toBe("Original evidence");
  expect(() => threadStatus({ ...idle, activity: "awaiting", waitingOnAgents: { ...legacy, kind: "available" } } as any)).toThrow("undescribed state");
});

test("route boundaries allow the empty entrance but reject malformed or undescribed routes", () => {
  expect(parseRoute("")).toEqual({ tab: "chats", chat: null, panel: null });
  for (const hash of ["#/unknown", "#/chats/unknown/id", "#/chats/ai", "#/workers/id/unknown", "#/chats/ai/%zz"]) expect(() => parseRoute(hash)).toThrow();
  expect(parseRoute("#/chats/room/room-id/settings")).toEqual({ tab: "chats", chat: "room:room-id", panel: "settings" });
});

test("queue and Write boundaries do not turn unknowns into sent messages or dictation", () => {
  expect(() => queueMessageStatus({ state: "new" as any, delivery: "queue" }, false)).toThrow("undescribed state");
  expect(() => queueMessageStatus({ state: "queued", delivery: "new" as any }, false)).toThrow("invalid state");
  for (const value of [{ type: "future" }, { type: "final" }, { type: "final", text: "text", rewrite: { status: "new", reason: null } }]) expect(() => parseWriteFrame(JSON.stringify(value))).toThrow();
  expect(parseWriteFrame('{"type":"final","text":"text","rewrite":null}')).toEqual({ type: "final", text: "text", rewrite: null });
});

test("unknown Android install acknowledgement is a retryable error, never Restarting", async () => {
  const updater = new AppUpdater({ check: async () => ({ update: { kind: "web", revision: "r" } } as any), install: async () => ({ status: "future" } as any), attempted: () => false, remember: () => {} });
  await updater.check();
  expect(updater.snapshot()).toMatchObject({ busy: false, approval: false });
  expect(updater.snapshot().error).toContain("invalid state");
  expect(updater.snapshot().status).not.toBe("Restarting…");
});
