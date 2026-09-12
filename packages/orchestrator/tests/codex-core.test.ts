import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSession } from "../src/cores/codex.js";
import { CoreExecutionLedger } from "../src/cores/execution.js";
import { credentialGuard } from "../src/cores/codex-auth.js";
import type { CoreCommand, CoreExecutionSnapshot, CoreOutput, CorePresentationEvent, CoreResponse, CoreSessionOptions } from "../src/cores/contracts.js";
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
  let children: unknown[] = [], history: unknown[] = [], closeCount = 0, refreshed = 0, rpcCloseCount = 0;
  let accountOptions: CoreSessionOptions | undefined;
  let closeWait = async () => {};
  const order: string[] = [];
  const eventWaiters = new Map<string, (() => void)[]>();
  const executionWaiters = new Set<{ predicate: (snapshot: CoreExecutionSnapshot) => boolean; resolve: () => void }>();
  let hook: ((method: string, params: Json) => RpcResult<unknown> | undefined | Promise<RpcResult<unknown> | undefined>) | undefined;
  const open = createCodexSession({
    openAccount: async value => { accountOptions = value; return ({
      credentials: async request => { if (request?.refresh) refreshed++; return { accessToken: token, chatgptAccountId: accountId }; },
      recordUsage: value => { usage.push(value); }, close: () => { closeCount++; order.push("account-close"); },
    }); },
    openRpc: value => {
      callbacks = value;
      return {
        async request<T>(method: string, params: Json): Promise<RpcResult<T>> {
          requests.push({ method, params });
          const custom = await hook?.(method, params);
          if (custom) return custom as RpcResult<T>;
          let result: unknown = {};
          if (method === "model/list") result = { data: [model], nextCursor: null };
          if (["thread/start", "thread/resume", "thread/fork"].includes(method)) result = { thread: thread(method === "thread/fork" ? "fork" : String(params.threadId ?? "root"), params.threadId && params.threadId !== "root" ? "root" : null), model: model.model, reasoningEffort: "high" };
          if (method === "thread/read") result = { thread: thread(String(params.threadId), "root") };
          if (method === "thread/turns/list") result = { data: history, nextCursor: null };
          if (method === "thread/list") result = { data: children, nextCursor: null };
          if (method === "thread/backgroundTerminals/list") result = { data: [], nextCursor: null };
          if (method === "skills/list") result = { data: [{ cwd: stateDir, skills: [{ name: "inspect", path: "/skills/inspect/SKILL.md", description: "Inspect", enabled: true }], errors: [] }] };
          if (method === "turn/start") result = { turn: { id: "turn-1", status: "inProgress", items: [] } };
          if (method === "turn/steer") result = { turnId: "turn-1" };
          return { ok: true, value: result as T };
        },
        notify() {}, async close() { rpcCloseCount++; await closeWait(); order.push("rpc-close"); callbacks.exit(0); },
      };
    },
  });
  return { options, events, requests, usage, order,
    open: () => open(options, value => {
      events.push(value); if (value.type === "response") order.push(`response:${value.id}`);
      for (const resolve of eventWaiters.get(value.type) ?? []) resolve();
      eventWaiters.delete(value.type);
      if (value.type === "execution_update") for (const waiter of executionWaiters) {
        if (waiter.predicate(value.execution)) { executionWaiters.delete(waiter); waiter.resolve(); }
      }
    }, () => { order.push("exit"); }),
    event(type: string) {
      return events.some(event => event.type === type) ? Promise.resolve() : new Promise<void>(resolve => eventWaiters.set(type, [...eventWaiters.get(type) ?? [], resolve]));
    },
    crash: () => callbacks.exit(1), closeWait(value: typeof closeWait) { closeWait = value; },
    get accountOptions() { return accountOptions; }, get rpcCloseCount() { return rpcCloseCount; },
    send(method: string, params: Json) { callbacks.notification(method, params); },
    server(method: string, params: Json = {}) { return callbacks.serverRequest(method, params); },
    hook(value: typeof hook) { hook = value; }, history(value: unknown[], receipts: Record<string, unknown> = {}) {
      history = value;
      if (value.length && !existsSync(join(stateDir, "codex-session.json"))) writeFileSync(join(stateDir, "codex-session.json"), JSON.stringify({ version: 1, sessionId: options.sessionId, threadId: "root", materialized: true, receipts, timestamps: {} }));
    }, children(value: unknown[]) { children = value; },
    get closeCount() { return closeCount; }, get refreshed() { return refreshed; },
    response(id: string) { return [...events].reverse().find((event): event is CoreResponse => event.type === "response" && event.id === id); },
    execution() { return [...events].reverse().find(event => event.type === "execution_update")!.execution as CoreExecutionSnapshot; },
    untilExecution(predicate: (snapshot: CoreExecutionSnapshot) => boolean) {
      const current = [...events].reverse().find(event => event.type === "execution_update");
      return current && predicate(current.execution) ? Promise.resolve() : new Promise<void>(resolve => executionWaiters.add({ predicate, resolve }));
    },
  };
}

describe("Codex app-server adapter", () => {
  it("keeps the root busy for descendants and aborts child-only turns and background terminals", async () => {
    const f = fixture(); f.children([thread("child", "root"), thread("grandchild", "child")]);
    const session = await f.open();
    f.hook((method, params) => method === "thread/backgroundTerminals/list" && params.threadId === "child"
      ? { ok: true, value: { data: [{ processId: "terminal-child" }], nextCursor: null } } : undefined);
    for (const id of ["child", "grandchild"]) f.send("turn/started", { threadId: id, turn: { id: `turn-${id}` } });
    await session.command({ type: "get_state", id: "busy" });
    expect(f.response("busy")?.data).toMatchObject({ isStreaming: true, coreBusy: true, treeComplete: false });
    await session.command({ type: "prompt", id: "blocked", message: "New root work" });
    expect(f.response("blocked")?.error).toMatch(/native tree is busy/);
    expect(f.requests.some(request => request.method === "turn/start")).toBe(false);
    await session.command({ type: "abort", id: "tree-abort" });
    expect(f.response("tree-abort")?.data).toMatchObject({ accepted: true, coreClosed: false });
    expect(f.requests.filter(request => request.method === "turn/interrupt").map(request => request.params.threadId).sort()).toEqual(["child", "grandchild"]);
    expect(f.requests.find(request => request.method === "thread/backgroundTerminals/terminate")?.params).toEqual({ threadId: "child", processId: "terminal-child" });
    expect(f.events.filter(event => event.type === "agent_end")).toHaveLength(0);
    f.send("turn/completed", { threadId: "child", turn: { id: "turn-child", status: "interrupted" } });
    await session.command({ type: "get_state", id: "one-left" });
    expect(f.response("one-left")?.data).toMatchObject({ isStreaming: true, coreBusy: true });
    f.send("thread/closed", { threadId: "grandchild" });
    await f.event("agent_end");
    await session.command({ type: "get_state", id: "idle" });
    expect(f.response("idle")?.data).toMatchObject({ isStreaming: false, coreBusy: false, treeComplete: false, execution: { status: "blocked" } });
    expect(f.events.filter(event => event.type === "agent_end")).toHaveLength(1);
    await session.close();
  });

  it("closes the owned runtime when a native child cannot be interrupted and confirms before exit", async () => {
    const f = fixture(), session = await f.open();
    f.send("item/started", { threadId: "root", turnId: "root-turn", item: { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent",
      receiverThreadIds: ["pending-child"], agentsStates: { "pending-child": { status: "pendingInit" } } } });
    await session.command({ type: "abort", id: "hard-tree-stop" });
    expect(f.response("hard-tree-stop")?.data).toMatchObject({ accepted: true, coreClosed: true });
    await session.close();
    expect(f.rpcCloseCount).toBe(1); expect(f.closeCount).toBe(1);
    expect(f.order.indexOf("response:hard-tree-stop")).toBeLessThan(f.order.indexOf("exit"));
  });

  it("resolves saved provider/model before leasing on --session-only resume", async () => {
    const f = fixture(); f.options.args.push("--provider", "openai-codex-7");
    const session = await f.open();
    await session.command({ type: "prompt", id: "persist-work", message: "Read" });
    await session.close();
    const resumed = fixture({ ...f.options, args: ["--session", join(f.options.stateDir, "codex-session.json")] });
    const next = await resumed.open();
    expect(resumed.accountOptions?.args).toContain("gpt-codex");
    expect(resumed.accountOptions?.args).toContain("openai-codex-7");
    expect(resumed.requests.find(request => request.method === "thread/resume")?.params).toMatchObject({ threadId: "root", model: "gpt-codex" });
    await next.close();
    const override = fixture({ ...f.options, args: ["--session", join(f.options.stateDir, "codex-session.json"), "--model", "override-model"] });
    const third = await override.open();
    expect(override.requests.find(request => request.method === "thread/resume")?.params.model).toBe("override-model");
    await third.close();
  });

  it("awaits process cleanup before releasing the lease or notifying native exit", async () => {
    const f = fixture(), session = await f.open();
    let release!: () => void;
    f.closeWait(() => new Promise<void>(resolve => { release = resolve; }));
    f.crash();
    const closing = session.close();
    await Promise.resolve(); await Promise.resolve();
    expect(f.rpcCloseCount).toBe(1); expect(f.closeCount).toBe(0); expect(f.order).not.toContain("exit");
    release(); await closing; await Promise.resolve();
    expect(f.closeCount).toBe(1);
    expect(f.order.indexOf("rpc-close")).toBeLessThan(f.order.indexOf("account-close"));
    expect(f.order.indexOf("account-close")).toBeLessThan(f.order.indexOf("exit"));
  });

  it("serves the child inspection/control rendezvous without disturbing streamed child messages", async () => {
    const f = fixture();
    f.children([thread("child", "root"), thread("grandchild", "child")]);
    const session = await f.open();
    let running = false;
    f.hook((method, params) => {
      if (method === "thread/turns/list" && params.threadId === "child") return { ok: true, value: {
        data: [{ id: running ? "turn-1" : "stored-turn", status: running ? "inProgress" : "completed", startedAt: 10, items: [
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
    const update = [...f.events].reverse().find((event): event is CorePresentationEvent => event.type === "core_child_event" && (event.event as any)?.type === "message_update");
    expect((update?.event as any).message.content[0].text).toBe("AB");
    expect(f.requests.filter(request => request.method === "thread/resume").map(request => request.params.threadId)).toEqual(["child", "grandchild"]);
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
    await session.command({ type: "core_agent_command", id: "bad-action", agentId: "child", action: "delete" } as unknown as CoreCommand);
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
    await f.untilExecution(snapshot => snapshot.operations.some(operation => operation.workId === "fast" && operation.state === "succeeded"));
    await session.command({ type: "compact", id: "compact" });
    await session.command({ type: "get_state", id: "state" });
    expect(f.response("state")?.data).toMatchObject({ isStreaming: false, isCompacting: false, treeComplete: true });
    expect(f.events.filter(event => event.type === "compaction_start")).toHaveLength(1);
    expect(f.events.filter(event => event.type === "compaction_end")).toHaveLength(1);
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "compact", kind: "compact", state: "succeeded" }));
    f.send("turn/completed", { threadId: "root", turn: { id: "failed", status: "failed", error: { message: "Provider failure" } } });
    await session.command({ type: "get_state", id: "failure-state" });
    expect(f.response("failure-state")?.data).toMatchObject({ lastAssistantMessage: { stopReason: "error", errorMessage: "Provider failure" } });
    await session.close();
  });

  it.each([ ["completed", "succeeded"], ["failed", "failed"], ["interrupted", "cancelled"] ] as const)("owns manual compaction until its matching native turn is %s", async (status, outcome) => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "compact", id: "compact-request", workId: "compact-work" });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "compact-work", kind: "compact", state: "running" }));
    f.send("turn/completed", { threadId: "root", turn: { id: "unrelated", status: "completed", items: [] } });
    f.send("thread/status/changed", { threadId: "root", status: { type: "idle" } });
    expect(f.execution().operations.find(operation => operation.workId === "compact-work")?.state).toBe("running");
    f.send("turn/started", { threadId: "root", turn: { id: "compact-turn", status: "inProgress", items: [] } });
    f.send("item/started", { threadId: "root", turnId: "compact-turn", item: { type: "contextCompaction", id: "compact-item" } });
    f.send("turn/completed", { threadId: "root", turn: { id: "compact-turn", status, items: [], error: status === "failed" ? { message: "Compaction failed" } : null } });
    expect(f.execution().operations.find(operation => operation.workId === "compact-work")?.state).toBe(outcome);
    await session.command({ type: "compact", id: "duplicate", workId: "compact-work" });
    expect(f.requests.filter(request => request.method === "thread/compact/start")).toHaveLength(1);
    await session.command({ type: "get_state", id: "compact-outcome", workId: "compact-work" });
    expect(f.response("compact-outcome")?.data).toMatchObject({ operation: { workId: "compact-work", kind: "compact", state: outcome } });
    await session.close();
  });

  it("keeps ambiguous compaction unknown through later completion and restart", async () => {
    const f = fixture(), session = await f.open();
    f.hook(method => method === "thread/compact/start" ? { ok: false, error: "Codex thread/compact/start timed out; outcome unknown" } : undefined);
    await session.command({ type: "compact", id: "compact-work" });
    f.send("item/completed", { threadId: "root", turnId: "late-compact", item: { type: "contextCompaction", id: "late-item" } });
    f.send("turn/completed", { threadId: "root", turn: { id: "late-compact", status: "completed", items: [] } });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "compact-work", kind: "compact", state: "unknown" }));
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    await next.command({ type: "compact", id: "compact-work" });
    expect(resumed.execution().operations).toContainEqual(expect.objectContaining({ workId: "compact-work", kind: "compact", state: "unknown" }));
    expect(resumed.requests.some(request => request.method === "thread/compact/start")).toBe(false);
    await next.close();
  });

  it("records rejected compaction without disturbing generation ownership", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "generation", message: "Read" });
    await session.command({ type: "compact", id: "busy-compact" });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "busy-compact", kind: "compact", state: "failed" }));
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "generation", kind: "prompt", state: "running" }));
    expect(f.requests.some(request => request.method === "thread/compact/start")).toBe(false);
    await session.close();
  });

  it("settles abort only after native tree termination and preserves a nonempty answer during empty teardown", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "generation", message: "Read" });
    f.send("item/completed", { threadId: "root", turnId: "turn-1", item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Substantive answer" } });
    f.send("turn/started", { threadId: "child", turn: { id: "child-turn", status: "inProgress", items: [] } });
    await session.command({ type: "abort", id: "stop-work" });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "stop-work", kind: "abort", state: "running" }));
    for (const threadId of ["root", "child"]) f.send("thread/status/changed", { threadId, status: { type: "idle" } });
    expect(f.execution().operations.find(operation => operation.workId === "stop-work")?.state).toBe("running");
    f.send("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "interrupted", items: [] } });
    f.send("item/completed", { threadId: "root", turnId: "turn-1", item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "" } });
    f.send("turn/completed", { threadId: "root", turn: { id: "turn-1", status: "interrupted", items: [{ type: "agentMessage", id: "answer", phase: "final_answer", text: "" }] } });
    await f.untilExecution(snapshot => snapshot.operations.some(operation => operation.workId === "generation" && operation.state === "cancelled"));
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "stop-work", kind: "abort", state: "succeeded" }));
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "generation", state: "cancelled", result: { text: "Substantive answer" } }));
    await session.command({ type: "abort", id: "stop-work" });
    expect(f.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(2);
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    await next.command({ type: "get_state", id: "answer-outcome", workId: "generation" });
    expect(resumed.response("answer-outcome")?.data).toMatchObject({ operation: { workId: "generation", state: "cancelled", result: { text: "Substantive answer" } } });
    await next.close();
  });

  it("does not resolve an ambiguous abort when process exit races its interrupt reply", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "generation", message: "Read" });
    f.hook(method => {
      if (method !== "turn/interrupt") return undefined;
      f.crash();
      return { ok: false, error: "Codex turn/interrupt timed out; outcome unknown" };
    });
    await session.command({ type: "abort", id: "unknown-stop" });
    expect(f.response("unknown-stop")?.data).toMatchObject({ coreClosed: true });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "unknown-stop", kind: "abort", state: "unknown" }));
    await session.close();
  });

  it("owns a no-op abort without pretending an empty native session was materialized", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "abort", id: "empty-stop" });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "empty-stop", kind: "abort", state: "succeeded" }));
    expect(f.rpcCloseCount).toBe(0);
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    expect(resumed.requests.some(request => request.method === "thread/resume")).toBe(false);
    await next.command({ type: "prompt", id: "first-generation", message: "Read" });
    expect(resumed.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    await next.close();
  });

  it("handles an authoritative terminal turn returned directly by dispatch", async () => {
    const f = fixture(), session = await f.open();
    f.hook(method => method === "turn/start" ? { ok: true, value: { turn: { id: "fast-turn", status: "completed",
      items: [{ type: "agentMessage", id: "fast-answer", text: "Complete", phase: "final_answer" }] } } } : undefined);
    await session.command({ type: "prompt", id: "fast-work", message: "Read" });
    await f.untilExecution(snapshot => snapshot.operations.some(operation => operation.workId === "fast-work" && operation.state === "succeeded"));
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "fast-work", result: { text: "Complete" } }));
    await session.command({ type: "get_state", id: "finished" });
    expect(f.response("finished")?.data).toMatchObject({ treeComplete: true, isStreaming: false });
    await session.close();
  });

  it("owns each steer outcome and ignores final messages, idle status, and unrelated turns", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "first", workId: "first-work", message: "Read" });
    await session.command({ type: "steer", id: "second", workId: "second-work", message: "Read README" });
    await session.command({ type: "steer", id: "third", workId: "third-work", message: "Read tests too" });
    f.send("item/completed", { threadId: "root", turnId: "turn-1", item: { type: "agentMessage", id: "answer", text: "Done", phase: "final_answer" } });
    f.send("thread/status/changed", { threadId: "root", status: { type: "idle" } });
    f.send("turn/completed", { threadId: "root", turn: { id: "unrelated", status: "completed", items: [] } });
    await session.command({ type: "get_state", id: "still-running" });
    expect(f.execution().operations.map(operation => [operation.workId, operation.state])).toEqual([
      ["first-work", "running"], ["second-work", "running"], ["third-work", "running"],
    ]);
    f.send("turn/completed", { threadId: "root", turn: { id: "turn-1", status: "failed", error: { message: "Provider failed" }, items: [] } });
    await session.command({ type: "core_agents", id: "drain-discovery" });
    expect(f.execution().operations).toEqual(expect.arrayContaining(["first-work", "second-work", "third-work"].map(workId =>
      expect.objectContaining({ workId, state: "failed", error: "Provider failed" }))));
    expect(f.events.some(event => event.type === "agent_settled")).toBe(false);
    await session.close();
  });

  it("registers descendant execution before publishing a root turn outcome", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "root-work", message: "Delegate" });
    let release!: (result: RpcResult<unknown>) => void;
    f.hook(method => method === "thread/list" ? new Promise(resolve => { release = resolve; }) : undefined);
    f.send("turn/completed", { threadId: "root", turn: { id: "turn-1", status: "completed", items: [] } });
    expect(f.execution().operations.find(operation => operation.workId === "root-work")?.state).toBe("running");
    f.hook((method, params) => method === "thread/turns/list" && params.threadId === "child"
      ? { ok: true, value: { data: [{ id: "child-turn", status: "inProgress", items: [] }], nextCursor: null } } : undefined);
    release({ ok: true, value: { data: [{ ...thread("child", "root"), status: { type: "active" } }], nextCursor: null } });
    await session.command({ type: "core_agent_read", id: "registered", agentId: "child" });
    await session.command({ type: "core_agents", id: "drain-discovery" });
    expect(f.execution().operations.find(operation => operation.workId === "root-work")?.state).toBe("succeeded");
    expect(f.execution().operations.some(operation => operation.agentId === "child" && operation.state === "running")).toBe(true);
    f.send("thread/status/changed", { threadId: "child", status: { type: "idle" } });
    expect(f.execution().status).toBe("running");
    await session.command({ type: "prompt", id: "blocked-after-idle", message: "More work" });
    expect(f.response("blocked-after-idle")?.success).toBe(false);
    expect(f.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    f.send("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "interrupted", items: [] } });
    expect(f.execution().operations.filter(operation => operation.agentId === "child").every(operation => operation.state === "cancelled")).toBe(true);
    expect(f.execution().status).toBe("idle");
    await session.close();
  });

  it("records native child initialization failure without inventing a completed turn", async () => {
    const f = fixture(), session = await f.open();
    const item = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "pendingInit", message: null } } };
    f.send("item/started", { threadId: "root", turnId: "turn-1", item });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ agentId: "child", state: "running" }));
    f.send("item/completed", { threadId: "root", turnId: "turn-1", item: { ...item, agentsStates: { child: { status: "errored", message: "Child initialization failed" } } } });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ agentId: "child", state: "failed", error: "Child initialization failed" }));
    await session.close();
  });

  it("distinguishes rejection from unknown dispatch and never replays either", async () => {
    const f = fixture(), session = await f.open();
    f.hook(method => method === "turn/start" ? { ok: false, error: "Codex rejected turn/start: invalid input" } : undefined);
    await session.command({ type: "prompt", id: "rejected", message: "Read" });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "rejected", state: "failed" }));
    f.hook(method => method === "turn/start" ? { ok: false, error: "Codex turn/start timed out; outcome unknown" } : undefined);
    await session.command({ type: "prompt", id: "unknown", message: "Read" });
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "unknown", state: "unknown" }));
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    for (const id of ["rejected", "unknown"]) await next.command({ type: "prompt", id, message: "Read" });
    await next.command({ type: "prompt", id: "new-work", message: "Write" });
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    expect(resumed.execution().status).toBe("blocked");
    await next.close();
  });

  it("keeps adopted acceptance unknown even when later native history shows completion", async () => {
    const f = fixture();
    const hash = createHash("sha256").update(JSON.stringify({ threadId: "root", type: "prompt", content: [{ type: "text", text: "Read", text_elements: [] }] })).digest("hex");
    writeFileSync(join(f.options.stateDir, "codex-session.json"), JSON.stringify({ version: 1, sessionId: f.options.sessionId,
      threadId: "root", materialized: true, receipts: { work: { hash, state: "accepted", turnId: "native-turn" } }, timestamps: {} }));
    const session = await f.open();
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "work", state: "unknown" }));
    await session.close();
    const resumed = fixture(f.options);
    resumed.history([{ id: "native-turn", status: "completed", items: [{ type: "agentMessage", id: "answer", text: "Read complete", phase: "final_answer" }] }]);
    const next = await resumed.open();
    expect(resumed.execution().operations).toContainEqual(expect.objectContaining({ workId: "work", state: "unknown" }));
    await next.command({ type: "get_state", id: "requested-outcome", workId: "work" });
    expect(resumed.response("requested-outcome")?.data).toMatchObject({ operation: { workId: "work", state: "unknown" } });
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    await next.close();
  });

  it("adopts materialized history without dispatch ownership as unknown, never idle", async () => {
    const f = fixture();
    f.history([{ id: "untracked-turn", status: "completed", items: [{ type: "agentMessage", id: "untracked-answer", text: "Previous answer" }] }]);
    const session = await f.open();
    expect(f.events.filter(event => event.type === "execution_update").every(event => event.execution.status === "blocked")).toBe(true);
    expect(f.execution().operations).toContainEqual(expect.objectContaining({ workId: "native:portable-root:untracked", state: "unknown" }));
    await session.command({ type: "prompt", id: "unsafe-replay", message: "Read" });
    expect(f.requests.some(request => request.method === "turn/start")).toBe(false);
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    expect(resumed.execution().status).toBe("blocked");
    await next.close();
  });

  it("keeps child steer ownership unknown after restart despite a later native failure", async () => {
    const f = fixture(); f.children([thread("child", "root")]);
    const session = await f.open();
    await session.command({ type: "steer", id: "child-steer", agentId: "child", message: "Read" });
    await session.close();
    const resumed = fixture(f.options); resumed.children([thread("child", "root")]);
    resumed.hook((method, params) => method === "thread/turns/list" && params.threadId === "child" ? { ok: true, value: {
      data: [{ id: "turn-1", status: "failed", error: { message: "Child failed" }, items: [] }], nextCursor: null,
    } } : undefined);
    const next = await resumed.open();
    expect(resumed.execution().operations).toContainEqual(expect.objectContaining({ workId: "child-steer", agentId: "child", state: "unknown" }));
    await next.close();
  });

  it("resumes native history without replay and deduplicates a stable work ID across restarts", async () => {
    const f = fixture(), session = await f.open();
    await session.command({ type: "prompt", id: "rpc-1", workId: "work", message: "Read" });
    await session.close();
    const resumed = fixture(f.options), next = await resumed.open();
    expect(resumed.requests.some(request => request.method === "thread/start")).toBe(false);
    expect(resumed.requests.find(request => request.method === "thread/resume")?.params.threadId).toBe("root");
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    expect(resumed.execution().operations).toContainEqual(expect.objectContaining({ workId: "work", state: "unknown" }));
    await next.command({ type: "prompt", id: "rpc-2", workId: "work", message: "Read" });
    expect(resumed.response("rpc-2")?.success).toBe(true);
    expect(resumed.requests.some(request => request.method === "turn/start")).toBe(false);
    await next.command({ type: "prompt", id: "rpc-3", workId: "work", message: "Write" });
    expect(resumed.response("rpc-3")?.success).toBe(false);
    await next.close();
  });

  it("does not retry or resolve ambiguous dispatch after finding its native client ID", async () => {
    const f = fixture(), session = await f.open();
    f.hook(method => method === "turn/start" ? { ok: false, error: "Codex turn/start timed out; outcome unknown" } : undefined);
    await session.command({ type: "prompt", id: "request", workId: "work", message: "Read" });
    await session.close();
    const resumed = fixture(f.options);
    resumed.history([{ id: "turn-native", startedAt: 10, status: "completed", items: [{ id: "user", type: "userMessage", clientId: "work", content: [{ type: "text", text: "Read", text_elements: [] }] }] }]);
    const next = await resumed.open();
    await next.command({ type: "prompt", id: "again", workId: "work", message: "Read" });
    expect(resumed.response("again")?.data).toEqual({ accepted: true, nativeTurnId: "turn-native" });
    expect(resumed.execution().operations).toContainEqual(expect.objectContaining({ workId: "work", state: "unknown" }));
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
    expect(f.events.find((event): event is CorePresentationEvent => event.type === "tool_execution_start")?.toolName).toBe("exec_command");
    expect(f.events.find((event): event is CorePresentationEvent => event.type === "tool_execution_end")?.result).toEqual({ content: [{ type: "text", text: "/repo" }] });
    const context = [...f.events].reverse().find((event): event is CorePresentationEvent => event.type === "context_update")!;
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
    f.history([{ id: "turn-a", startedAt: 10, status: "completed", items: [{ id: "user-a", type: "userMessage", clientId: null, content: [{ type: "text", text: "Read", text_elements: [] }] }] }],
      { "historical-work": { hash: createHash("sha256").update("historical-work").digest("hex"), state: "accepted", turnId: "turn-a" } });
    new CoreExecutionLedger(f.options.stateDir, () => {}).adopt({ workId: "historical-work", state: "succeeded" }, createHash("sha256").update("historical-work").digest("hex"));
    const session = await f.open();
    await session.command({ type: "set_thinking_level", id: "effort", level: "off" });
    expect([...f.requests].reverse().find(request => request.method === "thread/settings/update")?.params.effort).toBe("none");
    await session.command({ type: "set_model", id: "model", provider: "openai-codex", modelId: "gpt-codex" });
    await session.command({ type: "get_commands", id: "skills" });
    expect((f.response("skills")?.data as any).commands.map((command: any) => command.name)).toEqual(["compact", "skill:inspect"]);
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
