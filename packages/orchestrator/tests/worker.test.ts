import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/host/session-lifecycle.js", () => ({ openHostedSession: hosted.open }));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({ agentDir: "/tmp/agent" }) }));
vi.mock("../src/host/completion-worker.js", () => ({ workCompletion: async () => false }));

import { work } from "../src/worker.js";

describe("worker settlement", () => {
  let state: string;
  let patches: any[];
  let session: any;
  let dispose: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let control: (() => void) | undefined;

  beforeEach(() => {
    state = "starting";
    patches = [];
    control = undefined;
    dispose = vi.fn();
    unsubscribe = vi.fn();
    session = {
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      subscribe: vi.fn(() => unsubscribe),
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Finished." }] }],
      isStreaming: false,
      isCompacting: false,
    };
    hosted.open.mockResolvedValue({ session, dispose });
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 2000) control = callback;
      return 1;
    }) as any);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/state")) {
        const patch = JSON.parse(String(init?.body));
        patches.push(patch);
        state = patch.state;
        return Response.json({ ok: true });
      }
      if (path.endsWith("/control")) return Response.json({ abort: "operator request" });
      if (path === "/internal/runs/test-run") return Response.json({ run: {
        id: "test-run", source: "direct", state, prompt: "Do the work.", cwd: "/tmp",
        accountId: "openai-codex", provider: "openai-codex", model: "gpt-6-astra",
      } });
      throw new Error(`unexpected request ${path}`);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("finishes after one settled turn and releases its session", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "");
    await work("test-run");
    expect(session.prompt).toHaveBeenCalledExactlyOnceWith("Do the work.");
    expect(patches.map(patch => patch.state)).toEqual(["running", "done"]);
    expect(patches.at(-1).result).toBe("Finished.");
    expect(dispose).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("waits for an asynchronous continuation before finishing", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "");
    session.prompt.mockImplementation(async () => { session.isStreaming = true; });
    session.waitForIdle = vi.fn(async () => {
      expect(state).toBe("running");
      session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Continuation finished." }] });
      session.isStreaming = false;
    });
    await work("test-run");
    expect(session.waitForIdle).toHaveBeenCalledOnce();
    expect(patches.at(-1)).toEqual({ state: "done", result: "Continuation finished." });
  });

  it("honours an operator abort through the worker control endpoint", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "");
    session.prompt.mockImplementation(async () => { control!(); });
    await work("test-run");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(patches.at(-1)).toEqual({ state: "aborted", failureKind: "operator", result: "aborted" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("records native compaction failure instead of reporting done or operator-aborted", async () => {
    session.prompt.mockImplementation(async () => {
      for (const [listener] of session.subscribe.mock.calls) listener({ type: "compaction_end", errorMessage: "Native compaction idle-timeout; explicit recovery required", aborted: false });
      session.messages.push({ role: "assistant", stopReason: "aborted", content: [] });
    });
    await work("test-run");
    expect(patches.at(-1)).toEqual({ state: "failed", failureKind: "provider", result: "Native compaction idle-timeout; explicit recovery required" });
  });

  it("does not overwrite a terminal state set by the daemon", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "");
    session.prompt.mockImplementation(async () => { state = "aborted"; });
    await work("test-run");
    expect(patches.map(patch => patch.state)).toEqual(["running"]);
    expect(state).toBe("aborted");
    expect(dispose).toHaveBeenCalledOnce();
  });
});
