import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import type { OpenPiSession } from "../src/threads/contracts.js";
import { deriveThreadLifecycle, lifecycleControl, type LifecycleObservation } from "../src/threads/lifecycle.js";
const idle: LifecycleObservation = { archived: false, cancelling: false, execution: null, pending: null, delay: null, dependency: null, subscriptions: [], error: null, updatedAt: 10 };
describe("owner lifecycle controls follow custody, not scheduler flags or future timers", () => {
  it("actual owner snapshots distinguish a future wake from a durable wait across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "thread-lifecycle-"));
    const options = { databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" as const }, openSession: (async () => { throw new Error("No native session in lifecycle observation tests"); }) as OpenPiSession };
    let service = new ThreadService(options);
    try {
      expect(service.importThread({ id: "quiet", title: "Quiet", cwd: root, sessionFile: join(root, "quiet.jsonl"), settings: { model: "sol", thinkingLevel: "high", speed: "standard" }, metadata: { foreground: true } }).ok).toBe(true);
      expect((await service.wakeSchedule({ action: "set", threadId: "quiet", requestId: "future", reason: "Recovery", cadenceMs: 60_000, nextDueAt: Date.now() + 60_000 })).ok).toBe(true);
      expect(service.get("quiet")?.lifecycle).toEqual({ kind: "idle" });
      expect((await service.agentWait({ action: "set", threadId: "quiet", requestId: "wait", kind: "job", jobId: "job", reason: "Build result" })).ok).toBe(true);
      expect(service.get("quiet")?.lifecycle).toMatchObject({ kind: "waiting", target: "job", reason: "Build result" });
      await service.close(); service = new ThreadService(options);
      expect(service.get("quiet")?.lifecycle).toMatchObject({ kind: "waiting", target: "job" });
      expect((await service.agentWait({ action: "clear", threadId: "quiet", requestId: "clear" })).ok).toBe(true);
      expect(service.get("quiet")?.lifecycle).toEqual({ kind: "idle" });
    } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("quiet owners and completed cancellation have no stop control", () => {
    for (const source of [idle, { ...idle, cancelling: true }]) {
      const state = deriveThreadLifecycle(source);
      expect(state).toEqual({ kind: "idle" });
      expect(lifecycleControl(state)).toBe("none");
    }
  });
  it("queued work and durable dependency waits cancel the wait without claiming execution", () => {
    for (const source of [
      { ...idle, pending: { since: 20 } },
      { ...idle, dependency: { kind: "job" as const, jobId: "job", since: 20, reason: "Build result" } },
      { ...idle, subscriptions: ["peer"] },
      { ...idle, delay: { target: "capacity" as const, since: 20, reason: "No capacity" } },
    ]) {
      const state = deriveThreadLifecycle(source);
      expect(state.kind).toBe("waiting");
      expect(lifecycleControl(state)).toBe("cancel_wait");
    }
  });
  it("a live execution takes precedence over its retained dependency", () => {
    const state = deriveThreadLifecycle({ ...idle, execution: { since: 20, activity: { activity: "responding" } }, dependency: { kind: "job", jobId: "job", since: 10, reason: "Build" } });
    expect(state).toMatchObject({ kind: "working", phase: "responding" });
    expect(lifecycleControl(state)).toBe("stop");
  });
  it("missing execution phase and invalid dependency are explicit failures", () => {
    expect(deriveThreadLifecycle({ ...idle, execution: { since: 20, activity: {} } })).toMatchObject({ kind: "failed", control: "stop" });
    expect(deriveThreadLifecycle({ ...idle, dependency: { kind: "job", jobId: "", since: 10, reason: "Build" } })).toMatchObject({ kind: "failed", control: "cancel_wait" });
  });
  it("failure retains only the control belonging to actual custody", () => {
    expect(deriveThreadLifecycle({ ...idle, error: "No final result" })).toEqual({ kind: "failed", reason: "No final result", control: "none" });
    expect(deriveThreadLifecycle({ ...idle, error: "Cancellation failed", cancelling: true, execution: { since: 20, activity: { activity: "thinking" } } })).toMatchObject({ kind: "failed", control: "stop" });
  });
});
