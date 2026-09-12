import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreCommand, CoreExecutionSnapshot, CoreOperationState, CoreOutput, OpenCoreSession } from "../src/cores/contracts.js";
import type { Run } from "../src/domain.js";
import { assistantUsage, coreOptions, runCoreWorker } from "../src/host/core-worker.js";

const run: Run = { id: "run", source: "direct", profile: "astra", budget: "force", state: "starting", prompt: "Do the work", cwd: "/tmp/work",
  core: "pi", childrenOwner: "core", coreStateDir: "/tmp/custody/run", accountId: "openai-codex-2", provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh", createdAt: 1, updatedAt: 1 };
const workId = "run:run:initial";
const assistant = { role: "assistant", timestamp: 42, provider: "openai-codex-2", model: "gpt-6-astra", stopReason: "stop", content: [{ type: "text", text: "Unrelated assistant message" }], usage: { input: 2, output: 3 } };
function fixture(saved: Partial<Run> = {}) {
  const currentRun = { ...run, ...saved };
  const calls: CoreCommand[] = [], posts: { path: string; value: any }[] = [];
  let output: (event: CoreOutput) => void = () => {};
  const state: any = { core: currentRun.core, execution: { revision: 0, status: "idle", operations: [] } satisfies CoreExecutionSnapshot,
    nativeSessionId: "native-id", sessionFile: "/tmp/native.jsonl", portableFile: "/tmp/portable.jsonl", lastAssistantMessage: assistant };
  const finish = (operationState: CoreOperationState = "succeeded", error?: string) => {
    state.execution = { revision: state.execution.revision + 1, status: operationState === "unknown" ? "blocked" : operationState === "running" ? "running" : "idle",
      operations: [{ workId, state: operationState, result: { text: "Requested result" }, error }] };
    output({ type: "execution_update", execution: state.execution });
  };
  let prompt = async () => { output({ type: "message_end", message: assistant }); finish(); };
  const close = vi.fn(async () => {});
  const open: OpenCoreSession = async (_options, publish) => {
    output = publish;
    return { close, command: async command => {
      calls.push(command);
      if (command.type === "prompt") { finish("running"); await prompt(); }
      if (command.type === "abort") finish("cancelled");
      output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? structuredClone(state) : undefined });
    } };
  };
  let control: any = {};
  return {
    calls, posts, close, state, finish, setPrompt: (fn: typeof prompt) => { prompt = fn; }, emit: (event: CoreOutput) => output(event),
    setControl: (value: any) => { control = value; },
    work: () => runCoreWorker(currentRun, coreOptions(currentRun, {}), open,
      async (path, value) => { posts.push({ path, value }); }, async () => control),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("core worker", () => {
  it("uses pinned custody and the requested receipt, not unrelated last assistant output", async () => {
    const f = fixture();
    await f.work();
    expect(coreOptions(run, { PI_STACK_CORE: "codex" })).toMatchObject({ stateDir: run.coreStateDir, sessionId: run.id, env: { PI_STACK_CORE: "pi" } });
    expect(f.calls.find(call => call.type === "prompt")).toMatchObject({ workId, message: run.prompt });
    expect(f.posts[0]?.value).toEqual({ nativeSessionId: "native-id", sessionFile: "/tmp/native.jsonl", portableSessionFile: "/tmp/portable.jsonl" });
    expect(f.posts.at(-1)?.value).toEqual({ state: "done", result: "Requested result" });
    expect(f.posts.find(post => post.path.endsWith("/usage"))?.value.usage).toEqual({ input: 2, output: 3 });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("reopens a completed receipt without prompting and starts a proven empty native session once", async () => {
    const complete = fixture({ nativeSessionId: "native-id" });
    complete.finish();
    await complete.work();
    expect(complete.calls.some(call => call.type === "prompt")).toBe(false);
    expect(complete.posts.at(-1)?.value.state).toBe("done");
    const empty = fixture({ nativeSessionId: "native-id", sessionFile: "/tmp/native.jsonl" });
    await empty.work();
    expect(empty.calls.filter(call => call.type === "prompt")).toMatchObject([{ workId, message: run.prompt }]);
  });

  it("waits for the core operation after root and children presentation events say idle", async () => {
    const f = fixture();
    f.setPrompt(async () => {
      f.emit({ type: "agent_end" });
      f.emit({ type: "agent_settled" });
      f.emit({ type: "core_agent", agent: { id: "child", state: "idle" } });
      setTimeout(() => {
        expect(f.posts.some(post => post.value.state === "done")).toBe(false);
        f.finish();
      }, 5);
    });
    await f.work();
    expect(f.posts.at(-1)?.value.state).toBe("done");
  });

  it("keeps ambiguous effects waiting instead of settling or replaying them", async () => {
    const f = fixture({ nativeSessionId: "native-id" });
    f.finish("unknown", "native connection lost after dispatch");
    await f.work();
    expect(f.calls.some(call => call.type === "prompt")).toBe(false);
    expect(f.posts.at(-1)?.value).toMatchObject({ state: "waiting", result: expect.stringContaining("blocked") });
  });

  it("blocks released runtimes without execution and refuses unconfirmed isolation", async () => {
    const released = fixture();
    delete released.state.execution;
    released.state.treeComplete = true;
    await released.work();
    expect(released.calls.some(call => call.type === "prompt")).toBe(false);
    expect(released.posts.at(-1)?.value.state).toBe("waiting");
    const isolated = fixture({ context: { tools: ["bash"] } });
    await isolated.work();
    expect(isolated.calls.some(call => call.type === "prompt")).toBe(false);
    expect(isolated.posts.at(-1)?.value.state).toBe("failed");
  });

  it("uses explicit failure/cancellation outcomes even when assistant text looks successful", async () => {
    for (const state of ["failed", "cancelled"] as const) {
      const f = fixture();
      f.setPrompt(async () => { f.finish(state, "native failed"); });
      await f.work();
      expect(f.posts.at(-1)?.value.state).toBe(state === "failed" ? "failed" : "aborted");
    }
  });

  it("does not publish success before native cleanup succeeds", async () => {
    const f = fixture();
    f.close.mockRejectedValue(new Error("owned tool still running"));
    await f.work();
    expect(f.posts.some(post => post.value.state === "done")).toBe(false);
    expect(f.posts.at(-1)?.value).toMatchObject({ state: "failed", result: expect.stringContaining("cleanup failed") });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("refuses replacement of pinned native custody", async () => {
    const f = fixture({ nativeSessionId: "original-native" });
    await f.work();
    expect(f.calls.some(call => call.type === "prompt")).toBe(false);
    expect(f.posts.at(-1)?.value).toMatchObject({ state: "failed", failureKind: "infrastructure", result: expect.stringContaining("replaced") });
  });

  it("gives replayed usage the same receipt", () => {
    const event: CoreOutput = { type: "message_end", message: assistant };
    expect(assistantUsage(event)).toEqual(assistantUsage(JSON.parse(JSON.stringify(event))));
  });
});
