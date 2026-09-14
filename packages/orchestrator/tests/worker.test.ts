import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreOutput, OpenCoreSession } from "../src/cores/contracts.js";
import type { Run } from "../src/domain.js";
import { assistantUsage, coreOptions, runCoreWorker } from "../src/host/core-worker.js";

const run: Run = { id: "run", source: "direct", profile: "astra", budget: "force", state: "starting", prompt: "Do the work", cwd: "/tmp/work",
  core: "pi", childrenOwner: "core", coreStateDir: "/tmp/custody/run", accountId: "openai-codex-2", provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh", createdAt: 1, updatedAt: 1 };
const assistant = { role: "assistant", timestamp: 42, provider: "openai-codex-2", model: "gpt-6-astra", stopReason: "stop", content: [{ type: "text", text: "Finished" }], usage: { input: 2, output: 3 } };
function fixture(saved: Partial<Run> = {}) {
  const currentRun = { ...run, ...saved };
  const calls: { type: string; [key: string]: any }[] = [], posts: { path: string; value: any }[] = [];
  let output: (event: CoreOutput) => void;
  let state: any = { core: currentRun.core, treeComplete: true, nativeSessionId: "native-id", sessionFile: "/tmp/native.jsonl", portableFile: "/tmp/portable.jsonl" };
  let prompt = async () => { state.lastAssistantMessage = assistant; output({ type: "message_end", message: assistant }); };
  const close = vi.fn(async () => {});
  const open: OpenCoreSession = async (_options, publish) => {
    output = publish;
    return { close, command: async command => {
      calls.push(command);
      if (command.type === "prompt") await prompt();
      if (command.type === "abort") { state.treeComplete = true; state.lastAssistantMessage = { ...assistant, stopReason: "aborted" }; }
      output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? state : undefined });
    } };
  };
  let control: any = {};
  const post = async (path: string, value: any) => { posts.push({ path, value }); };
  return {
    calls, posts, close, state, setPrompt: (fn: typeof prompt) => { prompt = fn; }, emit: (event: CoreOutput) => output(event),
    setControl: (value: any) => { control = value; },
    work: () => runCoreWorker(currentRun, coreOptions(currentRun, {}), open, post, async () => control),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("core worker", () => {
  it("continues the recorded failed session when infrastructure recovery explicitly requests it", async () => {
    const f=fixture({nativeSessionId:"native-id",result:"recovering the recorded core session after infrastructure repair"});
    f.state.lastAssistantMessage={...assistant,stopReason:"error",errorMessage:"request translation failed"};
    await f.work();
    expect(f.calls.some(call=>call.type==="prompt")).toBe(true);
    expect(f.posts.at(-1)?.value.state).toBe("done");
  });
  it("continues a native host interruption but respects durable operator cancellation", async () => {
    for (const abort of [false, true]) {
      const f = fixture({ nativeSessionId: "native-id" });
      f.state.lastAssistantMessage = { ...assistant, stopReason: "aborted" };
      f.setControl({ abort });
      await f.work();
      expect(f.calls.some(call => call.type === "prompt")).toBe(!abort);
      expect(f.posts.at(-1)?.value.state).toBe(abort ? "aborted" : "done");
    }
  });
  it("uses the pinned engine/model/effort and persists native and portable references", async () => {
    const f = fixture();
    await f.work();
    expect(coreOptions(run, {})).toMatchObject({ stateDir: run.coreStateDir, sessionId: run.id });
    expect(coreOptions(run, {}).args).toEqual(["--provider", "openai-codex", "--model", "gpt-6-astra", "--thinking", "xhigh"]);
    expect(f.calls.find(call => call.type === "prompt")?.message).toBe(run.prompt);
    expect(f.posts[0]?.value).toEqual({ nativeSessionId: "native-id", sessionFile: "/tmp/native.jsonl", portableSessionFile: "/tmp/portable.jsonl" });
    expect(f.posts.at(-1)?.value).toEqual({ state: "done", result: "Finished" });
    expect(f.posts.find(post => post.path.endsWith("/usage"))?.value.usage).toEqual({ input: 2, output: 3 });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("pins an empty native session only after the core materializes it", async () => {
    const f = fixture();
    f.state.nativeSessionId = "provisional";
    f.state.nativeSessionDurable = false;
    f.setPrompt(async () => {
      f.state.nativeSessionId = "materialized";
      f.state.nativeSessionDurable = true;
      f.state.lastAssistantMessage = assistant;
    });
    await f.work();
    expect(f.posts[0].value.nativeSessionId).toBeUndefined();
    expect(f.posts.some(post => post.value.nativeSessionId === "materialized")).toBe(true);
    expect(f.posts.at(-1)?.value.state).toBe("done");
  });

  it("settles an already completed recovered tree without another prompt", async () => {
    const f = fixture({ nativeSessionId: "native-id" });
    f.state.lastAssistantMessage = assistant;
    await f.work();
    expect(f.calls.some(call => call.type === "prompt")).toBe(false);
    expect(f.posts.at(-1)?.value.state).toBe("done");
  });

  it("submits the original task after a crash between session creation and first prompt", async () => {
    const f = fixture({ nativeSessionId: "native-id", sessionFile: "/tmp/native.jsonl" });
    f.state.messageCount = 0;
    await f.work();
    expect(f.calls.find(call => call.type === "prompt")).toMatchObject({ id: "run:run:initial", message: run.prompt });
  });

  it("does not settle on root agent_end while the core owns unfinished children", async () => {
    const f = fixture();
    f.setPrompt(async () => {
      f.state.treeComplete = false;
      f.state.lastAssistantMessage = assistant;
      f.emit({ type: "agent_end" });
      setTimeout(() => {
        expect(f.posts.some(post => post.value.state === "done")).toBe(false);
        f.state.treeComplete = true;
        f.emit({ type: "core_agent", agent: { id: "child", state: "idle" } });
      }, 5);
    });
    await f.work();
    expect(f.posts.at(-1)?.value.state).toBe("done");
  });

  it("maps deltas/tools to heartbeat and sends abort through the command wire", async () => {
    const f = fixture();
    let control: (() => void) | undefined;
    const original = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 2_000) control = callback;
      return original(callback, delay);
    }) as any);
    f.setControl({ abort: true });
    f.setPrompt(async () => {
      f.state.lastAssistantMessage = assistant;
      f.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
      f.emit({ type: "tool_execution_start", toolName: "bash" });
      control!();
    });
    await f.work();
    expect(f.calls.some(call => call.type === "abort")).toBe(true);
    expect(f.posts.find(post => post.path.endsWith("/heartbeat"))?.value).toMatchObject({ activity: "WAITING_ON_TOOL", text: "working", tool: "bash", progress: true });
    expect(f.posts.at(-1)?.value.state).toBe("aborted");
  });

  it("rejects missing completion authority and unconfirmed isolation before prompting", async () => {
    for (const isolated of [false, true]) {
      const f = fixture(isolated ? { context: { tools: ["bash"], extensions: ["/app/tool.ts"] } } : {});
      if (!isolated) delete f.state.treeComplete;
      await f.work();
      expect(f.calls.some(call => call.type === "prompt")).toBe(false);
      expect(f.posts.at(-1)?.value.state).toBe("failed");
    }
    expect(() => coreOptions({ ...run, core: "codex" } as unknown as Run, {})).toThrow("imported into Pi");
  });

  it("fails recovery rather than replacing pinned native custody with a fresh session", async () => {
    const f = fixture({ nativeSessionId: "original-native" });
    await f.work();
    expect(f.calls.some(call => call.type === "prompt")).toBe(false);
    expect(f.posts.at(-1)?.value).toMatchObject({ state: "failed", failureKind: "infrastructure", result: expect.stringContaining("replaced") });
    expect(f.posts.some(post => post.value.nativeSessionId)).toBe(false);
  });

  it("keeps compaction/provider failures distinct from operator abort", async () => {
    const f = fixture();
    f.setPrompt(async () => {
      f.emit({ type: "compaction_end", errorMessage: "Native compaction failed" });
      f.state.lastAssistantMessage = { ...assistant, stopReason: "aborted" };
    });
    await f.work();
    expect(f.posts.at(-1)?.value).toMatchObject({ state: "failed", failureKind: "provider" });
  });

  it("does not publish success before native cleanup succeeds", async () => {
    const f = fixture();
    f.close.mockRejectedValue(new Error("owned tool still running"));
    await expect(f.work()).rejects.toThrow("owned tool still running");
    expect(f.posts.some(post => post.value.state === "done")).toBe(false);
    expect(f.posts.at(-1)?.value).toMatchObject({state:"failed",result:expect.stringContaining("cleanup failed")});
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("gives replayed usage the same receipt", () => {
    const event = { type: "message_end", message: assistant };
    expect(assistantUsage(event)).toEqual(assistantUsage(JSON.parse(JSON.stringify(event))));
  });
});
