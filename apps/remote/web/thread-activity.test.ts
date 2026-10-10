import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../server/protocol";
import { activityTiming, attentionRank, threadStatus, roomThreadStatus, monoThreadStatus } from "./src/features/status/thread-status";
import { StatusPill, StatusQuiet } from "./src/features/status/StatusPill";
import { validateStreamSnapshot } from "../shared/state-validation";
import type { ThreadLifecycle } from "../../../packages/orchestrator/src/threads/lifecycle";

const observation = (lifecycle: ThreadLifecycle, patch: Partial<Session> = {}) => ({
  lifecycle, state: "idle" as const, held: false, activity: "idle" as Session["activity"], activeTools: [], idleUnread: false, humanAttention: true, archivedAt: null, ...patch,
});

test("missing owner lifecycle is an instrumentation error, never inferred from old activity", () => {
  const status = threadStatus({ state: "running", activity: "thinking", activeTools: ["bash"], idleUnread: false } as unknown as Session);
  expect(status).toMatchObject({ key: "reporting_error", attention: true, busy: false });
  expect(status.title).toBeTruthy();
});

test("canonical lifecycle controls presentation even when coarse state and activity are stale", () => {
  const statuses: Array<[ThreadLifecycle, string, boolean]> = [
    [{ kind: "idle" }, "idle", false],
    [{ kind: "archived" }, "archived", false],
    [{ kind: "working", phase: "thinking", since: 1000, detail: "Reading source" }, "working", true],
    [{ kind: "working", phase: "responding", since: 1000 }, "typing", true],
    [{ kind: "cancelling" }, "stopping", true],
    [{ kind: "waiting", target: "agents", reason: "Need result", since: 1000 }, "waiting", false],
    [{ kind: "failed", reason: "Runner exited", control: "none" }, "error", false],
  ];
  for (const [lifecycle, key, busy] of statuses) {
    for (const patch of [{}, { state: "running" as const, activity: "waiting_on_tool" as const, activeTools: ["bash"], held: true }]) {
      const status = threadStatus(observation(lifecycle, patch));
      expect(status).toMatchObject({ key, busy });
      expect(Number.isFinite(attentionRank(status))).toBe(true);
    }
  }
});

test("durable waits name all dependency and scheduling targets without pretending to execute", () => {
  for (const target of ["agents", "job", "deployment", "message", "capacity", "retry", "dispatch"] as const) {
    const lifecycle = (target === "capacity" || target === "retry" ? { kind: "waiting", target, reason: "Owner receipt", since: 1000 } : { kind: "waiting", target, since: 1000 }) as ThreadLifecycle;
    const status = threadStatus(observation(lifecycle, { lastActivityAt: 1000 }));
    expect(status).toMatchObject({ key: "waiting", busy: false, since: 1000 });
    expect(status.title).toBe(target === "capacity" || target === "retry" ? "Owner receipt" : undefined);
    expect(status.label).toContain("Waiting for");
    expect(activityTiming(status, 80000)).toEqual({ elapsed: "1m 19s" });
    const mono = monoThreadStatus(observation(lifecycle));
    expect(mono).toMatchObject({ key: "working", label: "Working" });
    expect(mono.title).toBeUndefined();
  }
});

test("idle launchers keep idle icons and no execution clocks", () => {
  const parent = observation({ kind: "idle" }, { hasChildren: true, activitySince: 1000, lastActivityAt: 1000 });
  const status = threadStatus(parent);
  expect(status).toMatchObject({ key: "idle", busy: false, attention: false });
  expect(attentionRank(status)).toBe(21);
  expect(activityTiming(status, 80000)).toEqual({});
  expect(renderToStaticMarkup(createElement(StatusPill, { status }))).not.toContain("Agents working");
  expect(attentionRank(threadStatus({ ...parent, idleUnread: true }))).toBe(2);
});

test("canonical lifecycle crosses state and workers streams without client reconstruction", () => {
  const lifecycles: ThreadLifecycle[] = [
    { kind: "idle" }, { kind: "archived" }, { kind: "cancelling" },
    { kind: "working", phase: "waiting_on_tool", since: 1000 },
    { kind: "waiting", target: "deployment", reason: "Publication worker", since: 1000 },
    { kind: "failed", reason: "Execution owner unavailable", control: "cancel_wait" },
  ];
  for (const lifecycle of lifecycles) {
    const row = { ...observation(lifecycle), id: "parent", origin: "person", queuedMessages: [] };
    for (const resource of ["state", "workers"]) validateStreamSnapshot(resource, { type: resource, sessions: [row] });
    expect(Number.isFinite(attentionRank(threadStatus(row)))).toBe(true);
  }
});

test("room statuses consume canonical room evidence and show a missing owner explicitly", () => {
  expect(roomThreadStatus({ id: "room", title: "Room", members: [], lifecycle: { kind: "working", phase: "waiting_for_model", since: 1 } })).toMatchObject({ key: "working", busy: true });
  expect(roomThreadStatus({ id: "room", title: "Room", members: [], error: "Room owner cannot be reached" })).toMatchObject({ key: "reporting_error", title: "Room owner cannot be reached", attention: true });
});

test("phase age and lack of updates are separate, and observation time never implies failure", () => {
  const status = threadStatus(observation({ kind: "working", phase: "thinking", since: 1000 }, { lastActivityAt: 60000 }));
  expect(activityTiming(status, 65000)).toEqual({ elapsed: "1m 4s" });
  expect(activityTiming(status, 80000)).toEqual({ elapsed: "1m 19s", quiet: "20s" });
  expect(status.key).toBe("working");
  expect(activityTiming(status, 500)).toEqual({ elapsed: "0s" });
  for (const lifecycle of [{ kind: "idle" }, { kind: "archived" }, { kind: "failed", reason: "Runner exited", control: "none" }] as const) {
    expect(activityTiming(threadStatus(observation(lifecycle, { activitySince: 1000, lastActivityAt: 2000 })), 80000)).toEqual({});
  }
});

test("confirmed failure and cancellation are distinct, and failure preserves the actual cause", () => {
  expect(threadStatus(observation({ kind: "cancelling" }))).toMatchObject({ key: "stopping", busy: true });
  const failure = threadStatus(observation({ kind: "failed", reason: "Runner could not cancel", control: "stop" }));
  expect(failure).toMatchObject({ key: "error", busy: false, attention: true, title: "Runner could not cancel" });
  expect(renderToStaticMarkup(createElement(StatusPill, { status: failure }))).toContain('class="status-error-detail">Runner could not cancel</span>');
});

test("lack of updates is visible in dense rows, not hidden in a desktop tooltip", () => {
  const status = threadStatus(observation({ kind: "working", phase: "waiting_on_tool", since: Date.now() - 70000 }, { lastActivityAt: Date.now() - 60000 }));
  const markup = renderToStaticMarkup(createElement(StatusQuiet, { status }));
  expect(markup).toMatch(/class="status-quiet">Quiet for \d+[smh](?: \d+[sm])?<\/span>/);
  expect(markup).not.toContain("Failed");
});
