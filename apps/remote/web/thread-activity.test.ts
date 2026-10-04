import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../server/protocol";
import { activityTiming, threadStatus, roomThreadStatus } from "./src/features/status/thread-status";
import { StatusPill } from "./src/features/status/StatusPill";

const running = (patch: Partial<Session> = {}) => ({
  state: "running" as const, held: false, activity: "running" as Session["activity"], activeTools: [], idleUnread: false, archivedAt: null, ...patch,
});

test("missing owned phase or tool identity is an instrumentation defect, never a normal unknown state", () => {
  for (const session of [running(), running({ activity: "waiting_on_tool" })]) {
    const status = threadStatus(session);
    expect(status.key).toBe("reporting_error");
    expect(status.attention).toBe(true);
    expect(status.title).toBeTruthy();
    expect(status.busy).toBe(true);
    expect(status.label).not.toMatch(/Thinking|Working|unknown/);
  }
});

test("every owned machine boundary has a distinct interpretable status", () => {
  const phases: Session["activity"][] = ["queued", "admitting", "starting", "preparing", "finishing", "cancelling", "recovering", "thinking", "responding", "preparing_tool", "waiting_for_model", "waiting_on_tool", "compacting", "retrying", "waiting_for_capacity", "waiting_to_retry"];
  const statuses = phases.map(activity => threadStatus(running({ activity, activeTools: ["bash"] })));
  expect(new Set(statuses.map(status => status.key)).size).toBe(phases.length);
  for (const status of statuses) {
    expect(status.attention).toBe(false);
    expect(status.label).not.toMatch(/Working|unknown/);
  }
});

test("room statuses use the room owner's evidence, including status retrieval failures", () => {
  expect(roomThreadStatus({ id: "room", title: "Room", members: [], state: "running", activity: "waiting_for_model", activeTools: [] })).toMatchObject({ key: "waiting_for_model" });
  expect(roomThreadStatus({ id: "room", title: "Room", members: [], state: "running", activity: "status_error", error: "Room owner cannot be reached" })).toMatchObject({ key: "reporting_error", attention: true });
});

test("reported generation and request waits remain distinct from executing tools", () => {
  const statuses = ["thinking", "responding", "preparing_tool", "waiting_for_model", "waiting_on_tool"].map(activity =>
    threadStatus(running({ activity: activity as Session["activity"], activeTools: ["bash"] })),
  );
  expect(new Set(statuses.map(status => status.key)).size).toBe(5);
  expect(statuses.every(status => status.busy)).toBe(true);
  expect(statuses.at(-1)?.label).toBe("Running bash");
});

test("phase age and lack of updates are separate, and observation time never implies failure", () => {
  const status = threadStatus(running({ activity: "thinking", activitySince: 1_000, lastActivityAt: 60_000 }));
  expect(activityTiming(status, 65_000)).toEqual({ elapsed: "1m 4s" });
  expect(activityTiming(status, 80_000)).toEqual({ elapsed: "1m 19s", quiet: "20s" });
  expect(status.key).toBe("thinking");
  expect(activityTiming(status, 500)).toEqual({ elapsed: "0s" });
  expect(activityTiming(threadStatus(running()), 80_000)).toEqual({});
});

test("settled or held threads never display stale execution clocks", () => {
  for (const patch of [{ state: "idle" as const }, { held: true, state: "idle" as const }, { archivedAt: "2026-10-04" }]) {
    const status = threadStatus(running({ activity: "responding", activitySince: 1_000, lastActivityAt: 2_000, ...patch }));
    expect(status.busy).toBe(false);
    expect(activityTiming(status, 80_000)).toEqual({});
  }
});

test("confirmed failure and pending cancellation are not confused with idle or stopped", () => {
  expect(threadStatus(running({ held: true }))).toMatchObject({ key: "stopping", busy: true });
  expect(threadStatus(running({ held: true, executionError: "Runner could not cancel" }))).toMatchObject({ key: "error", label: "Stop failed", attention: true });
  expect(threadStatus(running({ held: true, state: "idle" }))).toMatchObject({ key: "stopped", busy: false });
  const failure = threadStatus(running({ state: "idle", executionError: "Runner exited" }));
  expect(failure).toMatchObject({ key: "error", busy: false, attention: true });
  expect(renderToStaticMarkup(createElement(StatusPill, { status: failure }))).toContain('class="status-error-detail">Runner exited</span>');
  expect(threadStatus(running({ activity: "waiting_for_capacity" })).key).toBe("waiting_for_capacity");
  expect(threadStatus(running({ activity: "waiting_to_retry" })).key).toBe("waiting_to_retry");
});

test("lack of activity updates is visible in dense rows, not hidden in a desktop tooltip", () => {
  const status = threadStatus(running({ activity: "waiting_on_tool", activeTools: ["bash"], activitySince: Date.now() - 70_000, lastActivityAt: Date.now() - 60_000 }));
  const markup = renderToStaticMarkup(createElement(StatusPill, { status, compact: true }));
  expect(markup).toMatch(/class="status-quiet">\d+[smh](?: \d+[sm])?<\/span>/);
  expect(markup).toContain('data-status="tool"');
  expect(markup).not.toContain("Failed");
});
