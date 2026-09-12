import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreExecutionLedger } from "../src/cores/execution.js";
import { CoreController } from "../src/cores/controller.js";
import type { CoreExecutionSnapshot } from "../src/cores/contracts.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const directory = () => { const value = mkdtempSync(join(tmpdir(), "execution-")); directories.push(value); return value; };
const snapshot = (revision: number, state: "running" | "succeeded"): CoreExecutionSnapshot => ({ revision,
  status: state === "running" ? "running" : "idle", operations: [{ workId: "work", state, agentId: "root", ...(state === "succeeded" ? { result: { text: "requested result" } } : {}) }] });

describe("durable execution ownership", () => {
  it("retains every steer outcome and never lets a delayed acceptance overwrite settlement", () => {
    const ledger = new CoreExecutionLedger(directory(), () => {});
    for (const workId of ["prompt", "steer-a", "steer-b"]) ledger.begin(workId, workId, "root");
    ledger.settleAgent("root", "running");
    ledger.settleAgent("root", "succeeded", undefined, { text: "integrated result" });
    ledger.transition("steer-a", "accepted");
    expect(ledger.snapshot()).toMatchObject({ status: "idle", operations: [
      { workId: "prompt", state: "succeeded" }, { workId: "steer-a", state: "succeeded" }, { workId: "steer-b", state: "succeeded" },
    ] });
    expect(() => ledger.begin("prompt", "different", "root")).toThrow("different input");
  });

  it("reopens pending effects as unknown without replay, and preserves terminal receipts", () => {
    const path = directory();
    const ledger = new CoreExecutionLedger(path, () => {});
    ledger.begin("pending", "effect", "root");
    ledger.begin("complete", "finished effect", "child");
    ledger.transition("complete", "failed", "provider rejected");
    const reopened = new CoreExecutionLedger(path, () => {});
    reopened.recover();
    expect(reopened.begin("pending", "effect", "root")).toMatchObject({ dispatch: false, operation: { state: "unknown" } });
    reopened.transition("pending", "accepted");
    reopened.settleAgent("root", "succeeded");
    expect(reopened.snapshot()).toMatchObject({ status: "blocked", operations: [
      { workId: "pending", state: "unknown" }, { workId: "complete", state: "failed", error: "provider rejected" },
    ] });
    expect(new CoreExecutionLedger(path, () => {}).snapshot()).toEqual(reopened.snapshot());
  });
});

describe("shared core controller", () => {
  it("keeps newer terminal events when get_state replies arrive out of order", async () => {
    const controller = new CoreController();
    controller.session = { close: async () => {}, command: async command => {
      controller.output({ type: "execution_update", execution: snapshot(3, "succeeded") });
      controller.output({ type: "response", id: command.id, command: command.type, success: true, data: { execution: snapshot(1, "running"), lastAssistantMessage: { text: "unrelated" } } });
    } };
    expect(await controller.request("get_state", { workId: "work" })).toMatchObject({ ok: true, value: { execution: snapshot(3, "succeeded") } });
    expect(controller.operation("work")).toMatchObject({ ok: true, value: { state: "succeeded", result: { text: "requested result" } } });
    expect(controller.operation("other")).toEqual({ ok: true, value: undefined });
  });

  it("uses an operation outcome emitted before its command acknowledgement", async () => {
    const controller = new CoreController();
    controller.session = { close: async () => {}, command: async command => {
      controller.output({ type: "execution_update", execution: snapshot(3, "succeeded") });
      controller.output({ type: "response", id: command.id, command: command.type, success: true });
    } };
    expect(await controller.dispatch({ workId: "work", kind: "prompt", message: "task" })).toMatchObject({ ok: true, value: { state: "succeeded" } });
  });

  it("does not turn foreign failure into rejection or erase the ambiguous receipt", async () => {
    const controller = new CoreController();
    controller.session = { close: async () => {}, command: async () => {
      controller.output({ type: "execution_update", execution: { revision: 1, status: "running", operations: [{ workId: "work", state: "pending" }] } });
      throw new Error("transport disconnected after sending");
    } };
    expect(await controller.dispatch({ workId: "work", kind: "prompt", message: "task" })).toMatchObject({ ok: false, error: { kind: "unknown" } });
    expect(controller.operation("work")).toMatchObject({ ok: true, value: { state: "pending" } });
  });

  it("blocks runtimes without execution and rejects contradictory snapshots", async () => {
    const controller = new CoreController();
    controller.session = { close: async () => {}, command: async command => {
      controller.output({ type: "response", id: command.id, command: command.type, success: true, data: { treeComplete: true, isStreaming: false } });
    } };
    expect(await controller.request("get_state")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(controller.observe({ revision: 1, status: "idle", operations: [{ workId: "effect", state: "unknown" }] })).toMatchObject({ ok: false });
    expect(controller.observe(snapshot(1, "running"))).toMatchObject({ ok: true });
    expect(controller.observe(snapshot(1, "succeeded"))).toMatchObject({ ok: false });
  });
});
