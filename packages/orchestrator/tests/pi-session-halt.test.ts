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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(prepare?: (session: AgentSession) => void, extension?: string, env: NodeJS.ProcessEnv = {}, raw = false) {
  captured.prepare = prepare;
  const cwd = mkdtempSync(join(tmpdir(), "pi-halt-")), events: PiEvent[] = [];
  const args: string[] = raw ? ["--raw"] : [];
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
  const f = await fixture(undefined, undefined, { PI_THREAD_SPEED: "standard" });
  f.native.agent.state.model = { ...f.native.agent.state.model!, api: "openai-responses" };
  const providerPayload = () => f.native.extensionRunner.emitBeforeProviderRequest({ request: "fixture" });

  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "default" });
  expect(await f.command("set_speed", { speed: "priority" })).toMatchObject({ success: true, data: { speed: "priority" } });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "priority" });
  expect(await f.command("set_speed", { speed: "turbo" })).toMatchObject({ success: false, error: "Invalid thread speed: turbo" });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "priority" });
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
