import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSession } from "../src/cores/codex.js";
import { credentialGuard } from "../src/cores/codex-auth.js";
import type { CoreOutput, CoreSessionOptions } from "../src/cores/contracts.js";
import type { CodexRpcOptions, Json, RpcResult } from "../src/cores/codex-rpc.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const token = "fixture-secret-access-token", accountId = "fixture-secret-account-id";
const thread = (id = "root", parentThreadId: string | null = null) => ({ id, parentThreadId, name: null, agentNickname: parentThreadId ? "Scout" : null,
  agentRole: null, canAcceptDirectInput: true, status: { type: "idle" }, turns: [] });
const model = { id: "gpt-codex", model: "gpt-codex", displayName: "Codex", inputModalities: ["text", "image"],
  supportedReasoningEfforts: [{ reasoningEffort: "none" }, { reasoningEffort: "high" }], defaultReasoningEffort: "high" };
function fixture(existingOptions?: CoreSessionOptions) {
  const stateDir = existingOptions?.stateDir ?? mkdtempSync(join(tmpdir(), "codex-core-"));
  if (!existingOptions) dirs.push(stateDir);
  const options: CoreSessionOptions = existingOptions ?? { cwd: stateDir, args: ["--model", "gpt-codex", "--thinking", "high"], env: { HOME: stateDir }, sessionId: "portable-root", stateDir };
  let callbacks: CodexRpcOptions;
  const events: CoreOutput[] = [], requests: { method: string; params: Json }[] = [], usage: unknown[] = [];
  let children: unknown[] = [], history: unknown[] = [], closeCount = 0, refreshed = 0;
  let hook: ((method: string, params: Json) => RpcResult<unknown> | undefined) | undefined;
  const open = createCodexSession({
    openAccount: async () => ({
      credentials: async request => { if (request?.refresh) refreshed++; return { accessToken: token, chatgptAccountId: accountId }; },
      recordUsage: value => { usage.push(value); }, close: () => { closeCount++; },
    }),
    openRpc: value => {
      callbacks = value;
      return {
        async request<T>(method: string, params: Json): Promise<RpcResult<T>> {
          requests.push({ method, params });
          const custom = hook?.(method, params);
          if (custom) return custom as RpcResult<T>;
          let result: unknown = {};
          if (method === "model/list") result = { data: [model], nextCursor: null };
          if (["thread/start", "thread/resume", "thread/fork"].includes(method)) result = { thread: thread(method === "thread/fork" ? "fork" : String(params.threadId ?? "root"), params.threadId && params.threadId !== "root" ? "root" : null), model: model.model, reasoningEffort: "high" };
          if (method === "thread/read") result = { thread: thread(String(params.threadId), "root") };
          if (method === "thread/turns/list") result = { data: history, nextCursor: null };
          if (method === "thread/list") result = { data: children, nextCursor: null };
          if (method === "skills/list") result = { data: [{ cwd: stateDir, skills: [{ name: "inspect", path: "/skills/inspect/SKILL.md", description: "Inspect", enabled: true }], errors: [] }] };
          if (method === "turn/start") result = { turn: { id: "turn-1", status: "inProgress", items: [] } };
          if (method === "turn/steer") result = { turnId: "turn-1" };
          return { ok: true, value: result as T };
        },
        notify() {}, async close() { callbacks.exit(0); },
      };
    },
  });
  return { options, events, requests, usage, open: () => open(options, value => events.push(value), () => {}),
    send(method: string, params: Json) { callbacks.notification(method, params); },
    server(method: string, params: Json = {}) { return callbacks.serverRequest(method, params); },
    hook(value: typeof hook) { hook = value; }, history(value: unknown[]) {
      history = value;
      if (value.length && !existsSync(join(stateDir, "codex-session.json"))) writeFileSync(join(stateDir, "codex-session.json"), JSON.stringify({ version: 1, sessionId: options.sessionId, threadId: "root", materialized: true, receipts: {}, timestamps: {} }));
    }, children(value: unknown[]) { children = value; },
    get closeCount() { return closeCount; }, get refreshed() { return refreshed; },
    response(id: string) { return [...events].reverse().find(event => event.type === "response" && event.id === id); },
  };
}

describe("Codex app-server adapter", () => {
  it("serves the child inspection/control rendezvous without disturbing streamed child messages", async () => {
    const f = fixture();
    f.children([thread("child", "root"), thread("grandchild", "child")]);
    const session = await f.open();
    let running = false;
    f.hook((method, params) => {
      if (method === "thread/turns/list" && params.threadId === "child") return { ok: true, value: {
        data: [{ id: "turn-1", status: running ? "inProgress" : "completed", startedAt: 10, items: [
          { type: "agentMessage", id: "stored-child", text: "Stored child answer" },
        ] }], nextCursor: null,
      } };
      return undefined;
    });
    await session.command({ type: "core_agents", id: "agents" });
    expect(f.response("agents")?.data).toMatchObject({ agents: [
      { id: "child", parentId: "portable-root" }, { id: "grandchild", parentId: "child" },
    ] });
    f.send("item/started", { threadId: "child", turnId: "live", item: { type: "agentMessage", id: "stream", text: "" } });
    f.send("item/agentMessage/delta", { threadId: "child", itemId: "stream", delta: "A" });
    await session.command({ type: "core_agent_read", id: "read", agentId: "child" });
    expect(f.response("read")?.data).toMatchObject({
      agent: { id: "child" }, messages: [{ role: "assistant", content: [{ text: "Stored child answer" }] }],
      state: { nativeSessionId: "child", messageCount: 1, canAcceptDirectInput: true },
    });
    f.send("item/agentMessage/delta", { threadId: "child", itemId: "stream", delta: "B" });
    const update = [...f.events].reverse().find(event => event.type === "core_child_event" && (event.event as any)?.type === "message_update");
    expect((update?.event as any).message.content[0].text).toBe("AB");
    expect(f.requests.some(request => request.method === "thread/resume")).toBe(false);
    await session.command({ type: "core_agent_command", id: "continue-child", agentId: "child", action: "steer", message: "Continue" });
    expect(f.response("continue-child")?.data).toMatchObject({ accepted: true, agentId: "child", action: "steer" });
    expect(f.requests.find(request => request.method === "turn/start")?.params.threadId).toBe("child");
    running = true;
    await session.command({ type: "core_agent_command", id: "steer-child", agentId: "child", action: "steer", message: "Use README" });
    expect(f.requests.find(request => request.method === "turn/steer")?.params.expectedTurnId).toBe("turn-1");
    await session.command({ type: "core_agent_command", id: "abort-child", agentId: "child", action: "abort" });
    expect(f.response("abort-child")?.data).toMatchObject({ accepted: true, agentId: "child", action: "abort" });
    expect(f.requests.find(request => request.method === "turn/interrupt")?.params).toEqual({ threadId: "child", turnId: "turn-1" });
    await session.command({ type: "core_agent_read", id: "missing-id" });
    expect(f.response("missing-id")?.error).toMatch(/agentId is required/);
    await session.command({ type: "core_agent_command", id: "bad-action", agentId: "child", action: "delete" });
    expect(f.response("bad-action")?.error).toMatch(/steer or abort/);
    f.hook(method => method === "thread/read" ? { ok: true, value: { thread: { ...thread("child", "root"), canAcceptDirectInput: false } } } : undefined);
    await session.command({ type: "core_agent_command", id: "unavailable", agentId: "child", action: "steer", message: "Continue" });
    expect(f.response("unavailable")?.error).toMatch(/does not accept direct input/);
    await session.close();
  });

  it("acks on native acceptance, isolates auth callbacks, steers, and leaves busy queues to PiStack", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "prompt", workId: "work", message: "Read the repo", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });
    expect(f.response("prompt")?.success).toBe(true);
    expect(f.events.some(event => event.type === "agent_end")).toBe(false);
    const start = f.requests.find(request => request.method === "turn/start")!;
    expect(start.params.clientUserMessageId).toBe("work");
    expect(start.params.input).toEqual([{ type: "text", text: "Read the repo", text_elements: [] }, { type: "image", url: "data:image/png;base64,aGVsbG8=" }]);
    await session.command({ type: "follow_up", id: "queue", message: "Then read docs" });
    expect(f.response("queue")?.error).toMatch(/PiStack must queue/);
    await session.command({ type: "steer", id: "steer", message: "Only README" });
    expect(f.requests.find(request => request.method === "turn/steer")?.params.expectedTurnId).toBe("turn-1");
    await session.command({ type: "abort", id: "abort" });
    expect(f.requests.find(request => request.method === "turn/interrupt")?.params).toEqual({ threadId: "root", turnId: "turn-1" });
    const refreshed = await f.server("account/chatgptAuthTokens/refresh", { previousAccountId: accountId });
    expect(refreshed).toEqual({ ok: true, value: { accessToken: token, chatgptAccountId: accountId, chatgptPlanType: null } });
    expect(f.refreshed).toBe(1);
    expect(JSON.stringify(f.events)).not.toContain(token);
    expect(JSON.stringify(f.events)).not.toContain(accountId);
    expect(readFileSync(join(f.options.stateDir, "codex-session.json"), "utf8")).not.toContain(token);
    await session.close(); expect(f.closeCount).toBe(1);
  });

  it("recreates only untouched unmaterialized threads and never requests their unavailable history", async () => {
    const f = fixture(), session = await f.open();
    expect(f.requests.some(request => request.method === "thread/turns/list")).toBe(false);
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    expect(resumed.requests.some(request => request.method === "thread/resume")).toBe(false);
    expect(resumed.requests.some(request => request.method === "thread/start")).toBe(true);
    await next.close();
  });

  it("handles turn and compaction completion arriving before their acceptance response", async () => {
    const f = fixture(), session = await f.open();
    f.hook(method => {
      if (method === "turn/start") {
        f.send("turn/started", { threadId: "root", turn: { id: "turn-1" } });
        f.send("turn/completed", { threadId: "root", turn: { id: "turn-1", status: "completed" } });
      }
      if (method === "thread/compact/start") {
        f.send("item/started", { threadId: "root", turnId: "compact", item: { type: "contextCompaction", id: "compact" } });
        f.send("item/completed", { threadId: "root", turnId: "compact", item: { type: "contextCompaction", id: "compact" } });
      }
      return undefined;
    });
    await session.command({ type: "prompt", id: "fast", message: "Read" });
    await session.command({ type: "compact", id: "compact" });
    await session.command({ type: "get_state", id: "state" });
    expect(f.response("state")?.data).toMatchObject({ isStreaming: false, isCompacting: false, treeComplete: true });
    expect(f.events.filter(event => event.type === "compaction_start")).toHaveLength(1);
    expect(f.events.filter(event => event.type === "compaction_end")).toHaveLength(1);
    f.send("turn/completed", { threadId: "root", turn: { id: "failed", status: "failed", error: { message: "Provider failure" } } });
    await session.command({ type: "get_state", id: "failure-state" });
    expect(f.response("failure-state")?.data).toMatchObject({ lastAssistantMessage: { stopReason: "error", errorMessage: "Provider failure" } });
    await session.close();
  });

  it("resumes native history without replay and deduplicates a stable work ID across restarts", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "rpc-1", workId: "work", message: "Read" });
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    expect(resumed.requests.some(request => request.method === "thread/start")).toBe(false);
    expect(resumed.requests.find(request => request.method === "thread/resume")?.params.threadId).toBe("root");
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    await next.command({ type: "prompt", id: "rpc-2", workId: "work", message: "Read" });
    expect(resumed.response("rpc-2")?.success).toBe(true);
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    await next.command({ type: "prompt", id: "rpc-3", workId: "work", message: "Write" });
    expect(resumed.response("rpc-3")?.success).toBe(false);
    await next.close();
  });

  it("does not retry ambiguous dispatch and reconciles a persisted native client ID", async () => {
    const f = fixture(), session = await f.open();
    f.hook(method => method === "turn/start" ? { ok: false, error: "Codex turn/start timed out; outcome unknown" } : undefined);
    await session.command({ type: "prompt", id: "request", workId: "work", message: "Read" });
    await session.close();
    const resumed = fixture(f.options);
    resumed.history([{ id: "turn-native", startedAt: 10, status: "completed", items: [{ id: "user", type: "userMessage", clientId: "work", content: [{ type: "text", text: "Read", text_elements: [] }] }] }]);
    const next = await resumed.open();
    await next.command({ type: "prompt", id: "again", workId: "work", message: "Read" });
    expect(resumed.response("again")?.data).toEqual({ accepted: true, nativeTurnId: "turn-native" });
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    await next.close();
  });

  it("projects native tools/messages and children without claiming model context", async () => {
    const f = fixture(), session = await f.open();
    f.send("turn/started", { threadId: "root", turn: { id: "turn-1" } });
    const shell = { type: "commandExecution", id: "shell", command: "pwd", cwd: "/repo", aggregatedOutput: null, exitCode: null, status: "inProgress" };
    f.send("item/started", { threadId: "root", turnId: "turn-1", item: shell });
    f.send("item/completed", { threadId: "root", turnId: "turn-1", item: { ...shell, status: "completed", aggregatedOutput: "/repo", exitCode: 0 } });
    const message = { type: "agentMessage", id: "answer", text: "", phase: "final_answer" };
    f.send("item/started", { threadId: "root", turnId: "turn-1", item: message });
    f.send("item/agentMessage/delta", { threadId: "root", turnId: "turn-1", itemId: "answer", delta: "Done" });
    f.send("item/completed", { threadId: "root", turnId: "turn-1", item: { ...message, text: `Done ${token}` } });
    f.send("thread/started", { thread: thread("child", "root") });
    f.send("thread/started", { thread: thread("grandchild", "child") });
    f.send("item/started", { threadId: "child", turnId: "child-turn", item: { ...message, id: "child-answer" } });
    f.send("item/completed", { threadId: "child", turnId: "child-turn", item: { ...message, id: "child-answer", text: "Child done" } });
    expect(f.events.find(event => event.type === "tool_execution_start")?.toolName).toBe("exec_command");
    expect(f.events.find(event => event.type === "tool_execution_end")?.result).toEqual({ content: [{ type: "text", text: "/repo" }] });
    const context = [...f.events].reverse().find(event => event.type === "context_update")!;
    expect(context.projection).toBe("activity");
    expect(context).not.toHaveProperty("finalizedMessage");
    expect(context).not.toHaveProperty("finalizesMessage");
    expect((context.context as any).systemPrompt).toBe("");
    expect(JSON.stringify(context)).not.toContain("Child done");
    expect(f.events.some(event => event.type === "core_child_event" && event.agentId === "child" && (event.event as any)?.type === "message_end")).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain(token);
    expect(f.events.some(event => event.type === "core_agent" && (event.agent as any)?.parentId === "child")).toBe(true);
    await session.command({ type: "prompt", id: "child-input", agentId: "child", message: "Read" });
    expect(f.requests.find(request => request.method === "turn/start")?.params.threadId).toBe("child");
    await session.close();
  });

  it("imports structured transfer once without starting a turn or replacing native instructions", async () => {
    const f = fixture();
    f.options.transfer = { version: 1, sourceCore: "pi", agents: [], messages: [
      { role: "user", content: [{ type: "text", text: "Prior request" }] },
      { role: "assistant", content: [{ type: "text", text: "Prior answer" }] },
      { role: "toolResult", content: [{ type: "text", text: "Native evidence" }] },
    ] };
    const session = await f.open();
    const injection = f.requests.find(request => request.method === "thread/inject_items")!;
    expect((injection.params.items as any[]).map(item => item.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(f.requests)).not.toContain("baseInstructions");
    expect(JSON.stringify(f.requests)).not.toContain("developerInstructions");
    expect(f.requests.some(request => request.method === "turn/start")).toBe(false);
    await session.command({ type: "get_messages", id: "transferred" });
    expect((f.response("transferred")?.data as any).messages).toHaveLength(3);
    await session.close();
    const resumed = fixture({ ...f.options, transfer: undefined }), next = await resumed.open();
    expect(resumed.requests.some(request => request.method === "thread/inject_items")).toBe(false);
    await next.command({ type: "get_messages", id: "resumed-transfer" });
    expect((resumed.response("resumed-transfer")?.data as any).messages).toHaveLength(3);
    await next.close();
  });

  it("maps settings and skills, forks before a user turn, and rejects unsupported operations", async () => {
    const f = fixture();
    f.history([{ id: "turn-a", startedAt: 10, status: "completed", items: [{ id: "user-a", type: "userMessage", clientId: null, content: [{ type: "text", text: "Read", text_elements: [] }] }] }]);
    const session = await f.open();
    await session.command({ type: "set_thinking_level", id: "effort", level: "off" });
    expect([...f.requests].reverse().find(request => request.method === "thread/settings/update")?.params.effort).toBe("none");
    await session.command({ type: "set_model", id: "model", provider: "openai-codex", modelId: "gpt-codex" });
    await session.command({ type: "get_commands", id: "skills" });
    expect((f.response("skills")?.data as any).commands[0].name).toBe("skill:inspect");
    await session.command({ type: "fork", id: "fork", entryId: "user-a" });
    expect(f.requests.find(request => request.method === "thread/fork")?.params.beforeTurnId).toBe("turn-a");
    await session.command({ type: "prompt", id: "skill-prompt", message: "/skill:inspect source" });
    expect((f.requests.find(request => request.method === "turn/start")?.params.input as any[])[1]).toEqual({ type: "skill", name: "inspect", path: "/skills/inspect/SKILL.md" });
    await session.command({ type: "set_auto_compaction", id: "unsupported", enabled: false });
    expect(f.response("unsupported")?.error).toMatch(/does not support/);
    await session.command({ type: "compact", id: "custom", customInstructions: "Summarize" });
    expect(f.response("custom")?.error).toMatch(/does not accept custom instructions/);
    expect((await f.server("item/tool/requestUserInput")).ok).toBe(false);
    await session.close();
  });
});

it("redacts nested credential fields and token echoes without mutating caller-owned data", () => {
  const guard = credentialGuard(); guard.remember({ accessToken: token, chatgptAccountId: accountId });
  const original = { type: "tool", arguments: { accessToken: "other", Authorization: "Bearer other" }, output: `echo ${token} ${accountId}` };
  expect(JSON.stringify(guard.clean(original))).not.toContain(token);
  expect(guard.clean(original).arguments).toEqual({ accessToken: "[redacted]", Authorization: "[redacted]" });
  expect(original.arguments.accessToken).toBe("other");
});
