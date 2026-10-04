import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { openPiSession } from "../src/threads/pi-session.js";
import type { PiEvent } from "../src/threads/contracts.js";

const captured = vi.hoisted(() => ({ session: undefined as AgentSession | undefined, prepare: undefined as ((session: AgentSession) => void) | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, createAgentSessionFromServices: async (...args: Parameters<typeof sdk.createAgentSessionFromServices>) => {
    const result = await sdk.createAgentSessionFromServices(...args);
    captured.session = result.session;
    captured.prepare?.(result.session);
    return result;
  } };
});

vi.mock("../src/threads/pi-sandbox.js", async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  return { createSandboxTools: vi.fn(async () => [sdk.createReadTool("/workspace"), sdk.createWriteTool("/workspace"), sdk.createEditTool("/workspace"), sdk.createBashTool("/workspace")]
    .map(tool => ({ ...tool, description: `${tool.description} Confined test implementation.` }))) };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(prepare?: (session: AgentSession) => void, extension?: string, env: NodeJS.ProcessEnv = {}, raw = false, sandbox = false) {
  captured.prepare = prepare;
  const cwd = mkdtempSync(join(tmpdir(), "pi-halt-")), events: PiEvent[] = [];
  const args: string[] = [...(raw ? ["--raw"] : []), ...(sandbox ? ["--sandbox"] : [])];
  if (raw) env = { PI_ORCHESTRATOR_CONFIG: join(cwd, "config.json"), PI_ORCHESTRATOR_LEDGER: join(cwd, "ledger.sqlite3"),
    PI_ORCHESTRATOR_AUTH: join(cwd, "auth.json"), PI_MODEL_BROKER_URL: undefined, PI_ORCHESTRATOR_ASSIGNED: "0", PI_SUBAGENT_MODEL: undefined, ...env };
  if (extension) {
    const path = join(cwd, "fixture.mjs");
    writeFileSync(path, extension);
    args.push("--extension", path);
  }
  const waiters = new Set<() => void>();
  const session = await openPiSession({ cwd, args, env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1", ...env }, threadId: "halt-fixture", sessionFile: join(cwd, "native.jsonl") }, event => {
    events.push(event);
    for (const notify of waiters) notify();
  }, () => {});
  cleanups.push(async () => { await session.command({ type: "abort", id: "cleanup" }); await session.close(); rmSync(cwd, { recursive: true, force: true }); });
  const native = captured.session!;
  const model = native.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
  native.agent.state.model = model;
  vi.spyOn(native.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const reply = (result: AssistantMessage) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: result.stopReason as "stop" | "toolUse", message: result });
    stream.end();
    return stream;
  };
  native.agent.streamFunction = () => reply(message([{ type: "text", text: "done" }], "stop"));
  const waitFor = (predicate: (event: PiEvent) => boolean): Promise<PiEvent> => new Promise(resolve => {
    const notify = () => { const event = events.find(predicate); if (event) { waiters.delete(notify); resolve(event); } };
    waiters.add(notify); notify();
  });
  const command = async (type: string, fields = {}) => {
    const id = `${type}-${events.length}`;
    await session.command({ type, id, ...fields });
    return waitFor(event => event.type === "response" && event.id === id);
  };
  return { session, native, events, command, waitFor, reply, message };
}

it.each([
  { remote: false, raw: false },
  { remote: true, raw: false },
  { remote: true, raw: true },
])("captures the request and finished reply with correct ownership: $remote / raw=$raw", async ({ remote, raw }) => {
  const f = await fixture(undefined, undefined, remote
    ? { PI_REMOTE_SESSION_ID: "mirror-owner", PI_REMOTE_SERVER_URL: "http://127.0.0.1:1" }
    : { PI_REMOTE_SESSION_ID: "", PI_REMOTE_SERVER_URL: "" }, raw);
  const answer = f.message([{ type: "text", text: "done" }], "stop");
  f.native.agent.streamFunction = () => f.reply(answer);
  expect(await f.command("prompt", { workId: "capture", message: "capture" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  const contextOwner = remote && !raw ? "remote-mirror" : "runner";
  const request = { role: "user", content: [{ type: "text", text: "capture" }] };
  const updates = f.events.filter(event => event.type === "context_update");
  expect(updates).toMatchObject([
    { contextOwner, context: { tools: expect.any(Array), messages: [request] } },
    { contextOwner, context: { tools: expect.any(Array), messages: [request, answer] } },
  ]);
  if (raw) for (const update of updates) expect(update.context).toMatchObject({ systemPrompt: "", tools: [] });
  expect(f.events.indexOf(updates[1]!)).toBeLessThan(f.events.findIndex(event => event.type === "agent_settled"));
}, 3000);

it("sandbox exposes exactly four tools without instructions, discovered extensions, or host shell RPC", async () => {
  const f = await fixture(undefined, `export default pi => { throw new Error("must not load sandbox extensions"); };`, {}, true, true);
  expect(f.native.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
  expect(await f.command("prompt", { workId: "sandbox-context", message: "hello" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  const context = (await f.command("get_context")).data as { systemPrompt: string; tools: { name: string; description: string }[] };
  expect(context.systemPrompt).toBe("");
  expect(context.tools.map(tool => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
  expect(context.tools.every(tool => tool.description.includes("Confined test implementation."))).toBe(true);
  expect(await f.command("bash", { command: "id" })).toMatchObject({ success: false });
  expect(await f.command("switch_session", { sessionPath: "/etc/passwd" })).toMatchObject({ success: false });
}, 3000);

it("captures tool results before the next request without duplicating completed messages", async () => {
  const f = await fixture(undefined, `export default pi => {
    pi.registerTool({ name: "fixture_result", label: "Fixture", description: "Fixture result",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "tool output" }], details: {} }) });
  }`);
  const call = f.message([{ type: "toolCall", id: "result", name: "fixture_result", arguments: {} }], "toolUse");
  const answer = f.message([{ type: "text", text: "done" }], "stop");
  let requests = 0;
  f.native.agent.streamFunction = () => f.reply(requests++ === 0 ? call : answer);
  expect(await f.command("prompt", { workId: "tool", message: "use tool" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  const user = { role: "user", content: [{ type: "text", text: "use tool" }] };
  const result = { role: "toolResult", toolCallId: "result", toolName: "fixture_result", isError: false,
    content: [{ type: "text", text: "tool output" }] };
  expect(requests).toBe(2);
  expect(f.events.filter(event => event.type === "context_update")).toMatchObject([
    { context: { messages: [user] } },
    { context: { messages: [user, call] } },
    { context: { messages: [user, call, result] } },
    { context: { messages: [user, call, result] } },
    { context: { messages: [user, call, result, answer] } },
  ]);
}, 3000);

it("applies validated speed changes to this session's provider requests", async () => {
  const processSpeed = process.env.PI_THREAD_SPEED;
  const f = await fixture(undefined, undefined, { PI_THREAD_SPEED: "standard", PI_MODEL_BROKER_URL: "http://127.0.0.1:1" });
  f.native.agent.state.model = { ...f.native.agent.state.model!, api: "openai-responses" };
  const providerPayload = () => f.native.extensionRunner.emitBeforeProviderRequest({ request: "fixture" });

  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "default" });
  expect(await f.command("set_speed", { speed: "priority" })).toMatchObject({ success: false, error: expect.stringContaining("Priority speed is unavailable") });
  expect(await providerPayload()).toMatchObject({ service_tier: "default" });
  f.native.agent.state.model = f.native.modelRuntime.getModel("openai-codex", "gpt-6-sol")!;
  expect(await f.command("set_speed", { speed: "priority" })).toMatchObject({ success: true, data: { speed: "priority" } });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "priority" });
  expect(await f.command("set_speed", { speed: "turbo" })).toMatchObject({ success: false, error: "Invalid thread speed: turbo" });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "priority" });
  expect(await f.command("set_speed", { speed: "ultrafast" })).toMatchObject({ success: false, error: "Ultrafast speed requires OpenAI Codex Astra" });
  f.native.agent.state.model = f.native.modelRuntime.getModel("openai-codex", "gpt-6-astra")!;
  expect(await f.command("set_speed", { speed: "ultrafast" })).toMatchObject({ success: true, data: { speed: "ultrafast" } });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "ultrafast" });
  const other = await fixture(undefined, undefined, { PI_THREAD_SPEED: "standard" });
  other.native.agent.state.model = f.native.agent.state.model;
  expect(await other.native.extensionRunner.emitBeforeProviderRequest({})).toMatchObject({ service_tier: "default" });
  expect(await f.command("set_speed", { speed: "standard" })).toMatchObject({ success: true });
  expect(await providerPayload()).toMatchObject({ service_tier: "default" });
  expect(process.env.PI_THREAD_SPEED).toBe(processSpeed);
}, 3000);

it("settles normal completion once, then admits the next turn", async () => {
  const f = await fixture();
  expect(await f.command("prompt", { workId: "first", message: "first" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: ["first"], outcome: "complete" }]);
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, completedWorkIds: ["first"] } });
  expect(await f.command("prompt", { workId: "second", message: "second" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[]).includes("second"));
  expect(f.events.filter(event => event.type === "agent_settled")).toHaveLength(2);
}, 3000);

it("puts every queued steer into one model turn after the current response", async () => {
  const f = await fixture(), started = deferred();
  const first = createAssistantMessageEventStream();
  const requests: string[][] = [];
  f.native.agent.streamFunction = (_model, context) => {
    requests.push(context.messages.filter(message => message.role === "user").map(message =>
      typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("")));
    if (requests.length === 1) { started.resolve(); return first; }
    return f.reply(f.message([{ type: "text", text: "All results considered" }], "stop"));
  };
  expect(await f.command("prompt", { workId: "root", message: "Coordinate workers" })).toMatchObject({ success: true });
  await started.promise;
  for (let index = 0; index < 20; index++) {
    expect(await f.command("steer", { workId: `worker-${index}`, message: `Result ${index}` })).toMatchObject({ success: true });
  }
  first.push({ type: "done", reason: "stop", message: f.message([{ type: "text", text: "Waiting for results" }], "stop") });
  first.end();
  const settlement = await f.waitFor(event => event.type === "agent_settled");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toHaveLength(21);
  for (let index = 0; index < 20; index++) expect(requests[1]![index + 1]).toContain(`Result ${index}`);
  expect(settlement.workIds).toEqual(["root", ...Array.from({ length: 20 }, (_, index) => `worker-${index}`)]);
}, 3000);

function userTexts(context: { messages: { role: string; content: unknown }[] }) {
  return context.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join(""));
}

it("answers a steer that the controller sends after native settlement instead of stranding it in Pi's queue", async () => {
  const f = await fixture();
  const requests: string[][] = [];
  f.native.agent.streamFunction = (_model, context) => {
    requests.push(userTexts(context));
    return f.reply(f.message([{ type: "text", text: `reply ${requests.length}` }], "stop"));
  };
  expect(await f.command("prompt", { workId: "root", message: "first" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  // The controller has not processed that settlement yet, still believes the execution is live, and steers.
  expect(await f.command("steer", { workId: "late", message: "late steer" })).toMatchObject({ success: true });
  const late = await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[]).includes("late"));
  expect(late).toMatchObject({ workIds: ["late"], outcome: "complete", lastAssistantMessage: { content: [{ text: "reply 2" }] } });
  expect(requests.at(-1)?.at(-1)).toContain("late steer");
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, pendingMessageCount: 0, completedWorkIds: ["root", "late"] } });
}, 3000);

it("runs steers stranded by a terminal error instead of leaving the execution open forever", async () => {
  const f = await fixture(), started = deferred();
  const first = createAssistantMessageEventStream();
  const requests: string[][] = [];
  f.native.agent.streamFunction = (_model, context) => {
    requests.push(userTexts(context));
    if (requests.length === 1) { started.resolve(); return first; }
    return f.reply(f.message([{ type: "text", text: "steers answered" }], "stop"));
  };
  expect(await f.command("prompt", { workId: "root", message: "work" })).toMatchObject({ success: true });
  await started.promise;
  for (const index of [1, 2, 3]) expect(await f.command("steer", { workId: `steer-${index}`, message: `steer ${index}` })).toMatchObject({ success: true });
  // Production Pi ends this run without consuming its queue (a propagated compaction failure, or a settle boundary
  // that cannot continue from an error); that is the exit the October 3 integrator wedge took.
  const native = f.native as unknown as { _handlePostAgentRun(): Promise<boolean>; _runBeforeSettleBoundary(): Promise<boolean> };
  vi.spyOn(native, "_handlePostAgentRun").mockResolvedValueOnce(false);
  vi.spyOn(native, "_runBeforeSettleBoundary").mockResolvedValueOnce(false);
  const failed = f.message([], "error");
  failed.errorMessage = "Context rejected: Native compaction failed: fixture fence";
  first.push({ type: "error", reason: "error", error: failed });
  first.end();
  const settled = await f.waitFor(event => event.type === "agent_settled");
  expect(settled.workIds).toEqual(["root", "steer-1", "steer-2", "steer-3"]);
  expect(requests.at(-1)?.slice(-3)).toEqual(["steer 1", "steer 2", "steer 3"]);
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, pendingMessageCount: 0 } });
}, 3000);

it("answers a steer that arrives while Pi is emitting settlement, and settles it only after its reply", async () => {
  const gate = deferred(), settling = deferred();
  Object.assign(globalThis, { __piSettleGate: gate.promise, __piSettling: settling.resolve });
  cleanups.push(async () => { delete (globalThis as Record<string, unknown>).__piSettleGate; delete (globalThis as Record<string, unknown>).__piSettling; });
  const f = await fixture(undefined, `export default pi => pi.on("agent_settled", async () => { globalThis.__piSettling?.(); await globalThis.__piSettleGate; });`);
  let calls = 0;
  f.native.agent.streamFunction = () => f.reply(f.message([{ type: "text", text: `reply ${++calls}` }], "stop"));
  expect(await f.command("prompt", { workId: "root", message: "first" })).toMatchObject({ success: true });
  await settling.promise;
  await f.session.command({ type: "steer", id: "window", workId: "window", message: "during settlement" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.events.filter(event => event.type === "agent_settled")).toEqual([]);
  gate.resolve();
  const settled = await f.waitFor(event => event.type === "agent_settled");
  expect(settled).toMatchObject({ workIds: ["root", "window"], outcome: "complete", lastAssistantMessage: { content: [{ text: "reply 2" }] } });
  expect(calls).toBe(2);
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, pendingMessageCount: 0 } });
}, 3000);

it("orders concurrent steers to an idle session into one run rather than overlapping runs", async () => {
  const f = await fixture(), started = deferred();
  const first = createAssistantMessageEventStream();
  const requests: string[][] = [];
  f.native.agent.streamFunction = (_model, context) => {
    requests.push(userTexts(context));
    if (requests.length === 1) { started.resolve(); return first; }
    return f.reply(f.message([{ type: "text", text: "both considered" }], "stop"));
  };
  const steer = (id: string) => { void f.session.command({ type: "steer", id, workId: id, message: `steer ${id}` }); return f.waitFor(event => event.type === "response" && event.id === id); };
  const a = steer("a"), b = steer("b");
  await started.promise;
  first.push({ type: "done", reason: "stop", message: f.message([{ type: "text", text: "saw a" }], "stop") });
  first.end();
  expect(await a).toMatchObject({ success: true });
  expect(await b).toMatchObject({ success: true });
  const settled = await f.waitFor(event => event.type === "agent_settled");
  expect(settled).toMatchObject({ workIds: ["a", "b"], outcome: "complete" });
  expect(f.events.filter(event => event.type === "agent_settled")).toHaveLength(1);
  // b is acknowledged only once a's run is live, so Pi delivers it into that run (here, its first request).
  expect(requests.at(-1)).toEqual(expect.arrayContaining([expect.stringContaining("steer a"), expect.stringContaining("steer b")]));
}, 3000);

it("lets halt own settlement when native completion arrives before the prompt returns", async () => {
  const f = await fixture(), nativeSettled = deferred();
  f.native.subscribe(event => { if (event.type === "agent_settled") nativeSettled.resolve(); });
  await f.session.command({ type: "prompt", id: "race", workId: "race", message: "finish" });
  await nativeSettled.promise;
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: ["race"], outcome: "cancelled" }]);
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(f.events.filter(event => event.type === "agent_settled")).toHaveLength(1);
}, 3000);

it("halts a real shell inside a native prompt and acknowledges after one cancelled receipt", async () => {
  const f = await fixture();
  const started = deferred();
  let pid = 0;
  let calls = 0;
  f.native.agent.streamFunction = (_model, _context, options) => {
    options?.signal?.throwIfAborted();
    if (calls++) throw new Error("Cancelled tools must not start another model call");
    return f.reply(f.message([{ type: "toolCall", id: "sleep", name: "bash", arguments: { command: "echo $$; sleep 30", timeout: 32 } }], "toolUse"));
  };
  f.native.subscribe(event => {
    if (event.type !== "tool_execution_update") return;
    const text = event.partialResult.content.find((block: { type: string; text?: string }) => block.type === "text");
    if (text?.type === "text") { pid = Number(text.text.trim()); if (pid) started.resolve(); }
  });
  expect(await f.command("prompt", { workId: "sleep", message: "sleep" })).toMatchObject({ success: true });
  await started.promise;
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(calls).toBe(1);
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: ["sleep"], outcome: "cancelled" }]);
  const settledAt = f.events.findIndex(event => event.type === "agent_settled");
  expect(f.events.slice(settledAt + 1)).toContainEqual(expect.objectContaining({ type: "response", command: "abort", success: true }));
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, cancellationFailed: false, localTools: 0 } });
}, 3000);

it("returns aborted unlanded native steers to their owner and delivers the same IDs after the interrupt", async () => {
  const f = await fixture(), toolStarted = deferred(), urgentStarted = deferred();
  const urgentReply = createAssistantMessageEventStream(), requests: string[][] = [];
  f.native.agent.streamFunction = (_model, context, options) => {
    options?.signal?.throwIfAborted();
    requests.push(userTexts(context));
    if (requests.length === 1) return f.reply(f.message([{ type: "toolCall", id: "sleep", name: "bash", arguments: { command: "echo ready; sleep 30", timeout: 32 } }], "toolUse"));
    if (requests.length === 2) { urgentStarted.resolve(); return urgentReply; }
    return f.reply(f.message([{ type: "text", text: "All queued messages answered" }], "stop"));
  };
  f.native.subscribe(event => { if (event.type === "tool_execution_update") toolStarted.resolve(); });
  expect(await f.command("prompt", { workId: "root", message: "initial work" })).toMatchObject({ success: true });
  await toolStarted.promise;
  const queued = ["agent", "notification", "human"];
  for (const workId of queued) expect(await f.command("steer", { workId, message: `queued ${workId}` })).toMatchObject({ success: true });
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(f.events.find(event => event.type === "agent_settled")).toMatchObject({ workIds: ["root"], deferredWorkIds: queued, outcome: "cancelled" });
  expect(await f.command("get_state")).toMatchObject({ data: { acceptedWorkIds: ["root"], completedWorkIds: ["root"], isStreaming: false } });
  expect(await f.command("prompt", { workId: "urgent", message: "hard steer" })).toMatchObject({ success: true });
  await urgentStarted.promise;
  for (const workId of queued) expect(await f.command("steer", { workId, message: `queued ${workId}` })).toMatchObject({ success: true });
  urgentReply.push({ type: "done", reason: "stop", message: f.message([{ type: "text", text: "Interrupt handled" }], "stop") });
  urgentReply.end();
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[]).includes("urgent"));
  expect(requests).toHaveLength(3);
  expect(requests[2]!.slice(-4)).toEqual(["hard steer", ...queued.map(id => `queued ${id}`)]);
  for (const workId of queued) expect(f.events.filter(event => event.type === "message_start" && (event.message as any)?.role === "user" && userTexts({ messages: [event.message as any] })[0] === `queued ${workId}`)).toHaveLength(1);
  expect(await f.command("get_state")).toMatchObject({ data: { completedWorkIds: ["root", "urgent", ...queued] } });
}, 3000);

it("rejects overlap during preflight and waits for that preflight before acknowledging halt", async () => {
  const f = await fixture(), entered = deferred(), finish = deferred();
  vi.spyOn(f.native.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
  vi.spyOn(f.native.modelRuntime, "checkAuth").mockImplementation(async () => { entered.resolve(); await finish.promise; return undefined; });
  await f.session.command({ type: "prompt", id: "preflight", workId: "preflight", message: "wait" });
  await entered.promise;
  expect(await f.command("prompt", { workId: "overlap", message: "overlap" })).toMatchObject({ success: false, error: "Cannot overlap active Pi execution" });
  const stopped = f.command("abort");
  await Promise.resolve();
  expect(f.events.some(event => event.command === "abort" && event.type === "response")).toBe(false);
  finish.resolve();
  expect(await stopped).toMatchObject({ success: true });
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, acceptedWorkIds: [], completedWorkIds: [] } });
}, 3000);

it("reports native halt failure at 20 seconds before the controller's 30-second timeout", async () => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(native => {
    vi.spyOn(native, "prompt").mockImplementation(async () => { entered.resolve(); await finish.promise; });
  });
  await f.session.command({ type: "prompt", id: "deadline", workId: "deadline", message: "wait" });
  await entered.promise;
  vi.useFakeTimers();
  try {
    const stopped = f.command("abort");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(f.events.some(event => event.type === "response" && event.command === "abort")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopped).toMatchObject({ success: false, error: expect.stringContaining("did not stop within 20000ms") });
    expect(await f.command("get_state")).toMatchObject({ data: { cancellationFailed: true, isStreaming: true } });
  } finally {
    finish.resolve();
    vi.useRealTimers();
  }
  expect(await f.command("abort")).toMatchObject({ success: true });
}, 3000);

it("halts manual compaction and waits for its native command result", async () => {
  const started = deferred(), aborted = deferred(), finish = deferred();
  const f = await fixture(native => {
    vi.spyOn(native, "abortCompaction").mockImplementation(aborted.resolve);
    vi.spyOn(native, "compact").mockImplementation(async () => { started.resolve(); await finish.promise; throw new Error("Compaction cancelled"); });
  });
  await f.command("compact");
  await started.promise;
  const stopped = f.command("abort");
  await aborted.promise;
  expect(f.events.some(event => event.command === "abort" && event.type === "response")).toBe(false);
  finish.resolve();
  expect(await stopped).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "command_settled");
  expect(f.events.filter(event => event.type === "command_settled")).toHaveLength(1);
  expect(f.events.findIndex(event => event.type === "command_settled")).toBeLessThan(f.events.findIndex(event => event.type === "response" && event.command === "abort"));
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, pendingCommandCount: 0 } });
}, 3000);

it("dismisses a native extension dialog before acknowledging prompt cancellation", async () => {
  const f = await fixture(undefined, `export default pi => {
    pi.registerCommand("dialog", { description: "fixture", handler: async (_args, ctx) => { await ctx.ui.input("Wait for cancellation"); } });
  }`);
  await f.session.command({ type: "prompt", id: "dialog", workId: "dialog", message: "/dialog" });
  await f.waitFor(event => event.type === "extension_ui_request");
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: ["dialog"], outcome: "cancelled" }]);
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, completedWorkIds: ["dialog"] } });
}, 3000);
