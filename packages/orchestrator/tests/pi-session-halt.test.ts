import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { openPiSession } from "../src/threads/pi-session.js";
import type { PiEvent } from "../src/threads/contracts.js";
import { nativeModels } from "../src/models.js";

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

vi.mock("../src/threads/async-shell.js", async importOriginal => {
  const shell = await importOriginal<typeof import("../src/threads/async-shell.js")>();
  return { ...shell, asynchronousShellTools: async (options: Parameters<typeof shell.asynchronousShellTools>[0]) =>
    shell.asynchronousShellTools({ ...options, backend: await shell.ownedPipeShellOperations(join(process.cwd(), "../runtime/pi-shell-owner.mjs")) }) };
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
  const options = { cwd, args, env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1", PI_MODEL_DELIVERY_TIMEZONE: "null", ...env }, threadId: "halt-fixture", sessionFile: join(cwd, "native.jsonl") };
  const output = (event: PiEvent) => { events.push(event); for (const notify of waiters) notify(); };
  let session = await openPiSession(options, output, () => {});
  cleanups.push(async () => { await session.command({ type: "abort", id: "cleanup" }); await session.close(); rmSync(cwd, { recursive: true, force: true }); });
  let native = captured.session!;
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
  const providerStream = native.agent.streamFunction;
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
  const reopen = async () => {
    await session.close();
    captured.prepare = undefined;
    session = await openPiSession(options, output, () => {});
    native = captured.session!;
    native.agent.state.model = model;
    vi.spyOn(native.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    native.agent.streamFunction = () => reply(message([{ type: "text", text: "done" }], "stop"));
  };
  return { get session() { return session; }, get native() { return native; }, events, command, waitFor, reply, message, providerStream, reopen };
}

it("recovers a lost accepted input acknowledgement by native identity without repeating its prompt", async () => {
  const f = await fixture();
  let calls = 0;
  f.native.agent.streamFunction = () => { calls++; return f.reply(f.message([{ type: "text", text: "done" }], "stop")); };
  await f.session.command({ type: "prompt", id: "lost-input", workId: "lost-work", message: "once" });
  await f.waitFor(event => event.type === "agent_settled");
  f.events.splice(f.events.findIndex(event => event.type === "response" && event.id === "lost-input"), 1);
  const before = readFileSync(f.native.sessionFile!, "utf8");
  expect(await f.command("get_input_status", { commandId: "lost-input", workId: "lost-work" })).toMatchObject({
    success: true, data: { state: "accepted", commandId: "lost-input", workId: "lost-work" },
  });
  expect(await f.command("get_input_status", { commandId: "absent", workId: "absent-work" })).toMatchObject({ data: { state: "never_accepted" } });
  expect(readFileSync(f.native.sessionFile!, "utf8")).toBe(before);
  await f.session.command({ type: "prompt", id: "lost-input", workId: "lost-work", message: "once" });
  expect(calls).toBe(1);
  await f.reopen();
  expect(await f.command("get_input_status", { commandId: "lost-input", workId: "lost-work" })).toMatchObject({ data: { state: "accepted" } });
}, 3000);

it.each([
  { remote: false, raw: false },
  { remote: true, raw: false },
  { remote: true, raw: true },
])("previews current model context only on demand: $remote / raw=$raw", async ({ remote, raw }) => {
  const f = await fixture(undefined, undefined, remote
    ? { PI_REMOTE_SESSION_ID: "mirror-owner", PI_REMOTE_SERVER_URL: "http://127.0.0.1:1" }
    : { PI_REMOTE_SESSION_ID: "", PI_REMOTE_SERVER_URL: "" }, raw);
  const answer = f.message([{ type: "text", text: "done" }], "stop");
  answer.usage = { ...answer.usage, input: 12_000, output: 37, cacheRead: 2_000, cacheWrite: 300, totalTokens: 14_337 };
  let sent: any[] = [];
  f.native.agent.streamFunction = (_model, context) => { sent = JSON.parse(JSON.stringify(context.messages)); return f.reply(answer); };
  expect(await f.command("prompt", { workId: "capture", message: "capture" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  expect(f.events.some(event => event.type === "context_update")).toBe(false);
  const beforeInspection = readFileSync(f.native.sessionFile!, "utf8");
  const context = (await f.command("get_context")).data as any;
  expect(context).toMatchObject({ source: "runtime", tools: expect.any(Array), contextModel: answer.model,
    contextUsage: { tokens: 14_337, contextWindow: f.native.model!.contextWindow, percent: 14_337 / f.native.model!.contextWindow * 100 } });
  expect(JSON.parse(JSON.stringify(context.messages.filter((message: any) => message.role === "user")))).toEqual(sent.filter(message => message.role === "user"));
  expect(context.messages.at(-1)).toEqual(answer);
  expect(readFileSync(f.native.sessionFile!, "utf8")).toBe(beforeInspection);
  if (raw) {
    expect(context.tools).toEqual([]);
    expect(context.systemPrompt).toMatch(/^\[Model delivery:[^\n]*\]\n$/);
    expect(JSON.parse(JSON.stringify(context.messages.slice(0, -1)))).toEqual(sent);
  }
}, 3000);

it("previews an active forced system request without reentering admission or starting another provider call", async () => {
  const f = await fixture(undefined, `export default pi => {
    pi.on("before_agent_start", () => ({systemPrompt:"active approved instructions"}));
    pi.on("context_with_system", event => ({messages:event.messages.map(message => message.role === "user" ? {...message,content:[{type:"text",text:"projected input"}]} : message)}));
  }`);
  const stream = createAssistantMessageEventStream(), started = deferred();
  cleanups.push(async () => stream.end(f.message([], "aborted")));
  let sent: any[] = [];
  const provider = vi.fn((_model: unknown, context: { messages: any[] }) => { sent = JSON.parse(JSON.stringify(context.messages)); started.resolve(); return stream; });
  f.native.agent.streamFunction = provider;
  await f.command("prompt", { workId: "active-preview", message: "raw input" });
  await started.promise;
  const before = readFileSync(f.native.sessionFile!, "utf8"), leaf = f.native.sessionManager.getLeafId();
  const current = await f.command("get_context");
  expect(current).toMatchObject({ success: true, data: { systemPrompt: expect.stringContaining("active approved instructions") } });
  expect(JSON.parse(JSON.stringify((current.data as any).messages))).toEqual(sent);
  expect(readFileSync(f.native.sessionFile!, "utf8")).toBe(before);
  expect(f.native.sessionManager.getLeafId()).toBe(leaf);
  expect(provider).toHaveBeenCalledOnce();
  expect(f.events.filter(event => event.type === "agent_start")).toHaveLength(1);
  stream.push({ type: "done", reason: "stop", message: f.message([], "stop") }); stream.end();
  await f.waitFor(event => event.type === "agent_settled");
}, 3000);

it("rejects oversized current context before emitting the payload", async () => {
  const f = await fixture();
  f.native.agent.state.messages = [{ role: "user", content: "x".repeat(8 * 1024 * 1024), timestamp: Date.now() }];
  expect(await f.command("get_context")).toMatchObject({ success: false, errorCode: "oversized" });
  expect(f.events.at(-1)?.data).toBeUndefined();
  f.native.agent.state.messages = [];
}, 3000);

it.each(["missing", "empty", "authoritative", "redacted"])("persists streamed thinking in native JSONL when final thinking is %s", async final => {
  const f = await fixture();
  const partial = f.message([{ type: "thinking", thinking: "streamed reasoning" }], "stop");
  const answer = f.message(final === "missing" ? [{ type: "text", text: "done" }]
    : [{ type: "thinking", thinking: final === "empty" || final === "redacted" ? "" : "final reasoning", thinkingSignature: "signature", ...(final === "redacted" ? { redacted: true } : {}) }, { type: "text", text: "done" }], "stop");
  f.native.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "streamed reasoning", partial });
    stream.push({ type: "done", reason: "stop", message: answer });
    stream.end();
    return stream;
  };
  await f.command("prompt", { workId: "thinking", message: "think" });
  await f.waitFor(event => event.type === "agent_settled");
  const entries = readFileSync(f.native.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const message = entries.reverse().find(entry => entry.type === "message" && entry.message.role === "assistant").message;
  expect(message.content[0]).toMatchObject({ type: "thinking", thinking: final === "authoritative" ? "final reasoning" : final === "redacted" ? "" : "streamed reasoning" });
  if (final !== "missing") expect(message.content[0].thinkingSignature).toBe("signature");
  expect(f.events.some(event => event.type === "context_update")).toBe(false);
}, 3000);

it("persists a selected older branch across native cold open", async () => {
  const f = await fixture();
  await f.command("prompt", { workId: "branch-first", message: "first branch" });
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[])?.includes("branch-first"));
  const target = f.native.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant")!;
  await f.command("prompt", { workId: "branch-second", message: "abandoned branch" });
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[])?.includes("branch-second"));
  await f.native.navigateTree(target.id, { summarize: false });
  const pinned = f.native.sessionManager.getBranch().at(-1)!;
  expect(pinned).toMatchObject({ type: "custom", customType: "thread_branch", parentId: target.id, data: { selectedLeafId: target.id } });
  await f.reopen();
  const current = (await f.command("get_context")).data as any;
  expect(current.messages.some((message: any) => JSON.stringify(message.content).includes("abandoned branch"))).toBe(false);
  expect(f.native.sessionManager.getLeafId()).toBe(pinned.id);
  expect(f.native.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("abandoned branch"))).toBe(true);
}, 3000);

it("reconnect state preserves observed streaming phase and production timestamps", async () => {
  const f = await fixture();
  const stream = createAssistantMessageEventStream();
  cleanups.push(async () => stream.end(f.message([], "aborted")));
  f.native.agent.streamFunction = () => stream;
  expect(await f.command("prompt", { workId: "phase", message: "stream" })).toMatchObject({ success: true });
  const started = await f.waitFor(event => event.type === "agent_start");
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: "preparing", isThinking: false,
    activitySince: started.emittedAt, lastActivityAt: started.emittedAt } } });
  const partial = f.message([{ type: "thinking", thinking: "reason" }], "stop");
  stream.push({ type: "start", partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "reason", partial });
  const reasoning = await f.waitFor(event => (event.assistantMessageEvent as any)?.type === "thinking_delta");
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: "thinking", isThinking: true, lastActivityAt: reasoning.emittedAt } } });
  const answer = f.message([{ type: "text", text: "answer" }], "stop");
  stream.push({ type: "text_delta", contentIndex: 0, delta: "answer", partial: answer });
  const text = await f.waitFor(event => (event.assistantMessageEvent as any)?.type === "text_delta");
  const first = await f.command("get_state");
  expect(first).toMatchObject({ data: { live: { activity: "responding", isThinking: false, activitySince: text.emittedAt, lastActivityAt: text.emittedAt } } });
  expect((await f.command("get_state")).data).toEqual(first.data);
  stream.push({ type: "done", reason: "stop", message: answer });
  stream.end();
  await f.waitFor(event => event.type === "agent_settled");
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: undefined, activitySince: undefined, isThinking: false, tools: [] } } });
}, 3000);

async function httpProviderFixture(extension = "") {
  const arrivals: { response: ServerResponse; body: any }[] = [];
  const waiters = new Set<() => void>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    arrivals.push({ response, body: JSON.parse(Buffer.concat(chunks).toString()) });
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const f = await fixture(undefined, `export default pi => {
    pi.registerProvider("phase-fixture", { baseUrl: "http://127.0.0.1:${port}/v1", api: "openai-completions", apiKey: "not-a-credential",
      models: [{ id: "phase-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 128 }] });
    ${extension}
  };`);
  f.native.agent.state.model = f.native.modelRuntime.getModel("phase-fixture", "phase-model")!;
  f.native.agent.streamFunction = f.providerStream;
  f.native.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, provider: { maxRetries: 0 } }, cacheWarming: "off" });
  const request = (index: number): Promise<typeof arrivals[number]> => new Promise(resolve => {
    const notify = () => { if (arrivals[index]) { waiters.delete(notify); resolve(arrivals[index]!); } };
    waiters.add(notify); notify();
  });
  const finish = (response: ServerResponse, delta: object, finishReason = "stop") => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "phase", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
  };
  return { ...f, arrivals, request, finish };
}

it("reports the actual outbound provider boundary and retains it on reconnect until content", async () => {
  const f = await httpProviderFixture();
  await f.command("prompt", { workId: "http-phase", message: "real request" });
  const { response, body } = await f.request(0);
  expect(body.model).toBe("phase-model");
  const requestEvent = f.events.find(event => event.type === "model_request_start")!;
  expect(requestEvent).toMatchObject({ provider: "phase-fixture", modelId: "phase-model", sessionId: f.native.sessionId, emittedAt: expect.any(Number) });
  const state = await f.command("get_state");
  expect(state).toMatchObject({ data: { live: { activity: "waiting_for_model", activitySince: requestEvent.emittedAt, lastActivityAt: requestEvent.emittedAt } } });
  expect((await f.command("get_state")).data).toEqual(state.data);
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write('data: {"id":"phase","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
  await f.waitFor(event => event.type === "message_start" && (event.message as any)?.role === "assistant");
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: "waiting_for_model", activitySince: requestEvent.emittedAt } } });
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  response.write('data: {"id":"phase","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\n\n');
  const start = await f.waitFor(event => (event.assistantMessageEvent as any)?.type === "text_start");
  const text = await f.waitFor(event => (event.assistantMessageEvent as any)?.type === "text_delta");
  expect(text.emittedAt).toBeGreaterThan(start.emittedAt as number);
  const responding = await f.command("get_state");
  expect(responding).toMatchObject({ data: { live: { activity: "responding", activitySince: start.emittedAt, lastActivityAt: text.emittedAt } } });
  expect((await f.command("get_state")).data).toEqual(responding.data);
  response.end('data: {"id":"phase","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  await f.waitFor(event => event.type === "agent_settled");
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: undefined, activitySince: undefined } } });
}, 5000);

it("starts a fresh observed request after tools and after a native provider retry", async () => {
  const f = await httpProviderFixture(`pi.registerTool({ name: "phase_tool", label: "Phase", description: "Phase test",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }) });`);
  await f.command("prompt", { workId: "tools-and-retry", message: "use tool" });
  f.finish((await f.request(0)).response, { tool_calls: [{ index: 0, id: "phase-call", type: "function", function: { name: "phase_tool", arguments: "{}" } }] }, "tool_calls");
  const next = await f.request(1);
  expect(f.events.filter(event => event.type === "model_request_start")).toHaveLength(2);
  const end = f.events.findIndex(event => event.type === "tool_execution_end");
  expect(f.events.findIndex((event, index) => index > end && event.type === "model_request_start")).toBeGreaterThan(end);
  expect(next.body.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/^\[Model delivery: [^\n]+\]\n\s*tool result$/) });
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: "waiting_for_model", tools: [] } } });
  next.response.writeHead(503, { "content-type": "application/json" });
  next.response.end(JSON.stringify({ error: { message: "Service unavailable", type: "server_error" } }));
  const retried = await f.request(2);
  expect(f.events.some(event => event.type === "auto_retry_start")).toBe(true);
  expect(f.events.filter(event => event.type === "model_request_start")).toHaveLength(3);
  const newest = f.events.filter(event => event.type === "model_request_start").at(-1)!;
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: "waiting_for_model", activitySince: newest.emittedAt } } });
  f.finish(retried.response, { content: "done" });
  await f.waitFor(event => event.type === "agent_settled");
}, 5000);

it("rebinds the provider observer to runtime replacement and clears an aborted request", async () => {
  const f = await httpProviderFixture();
  const originalId = f.native.sessionId;
  await f.command("new_session");
  const replacement = captured.session!;
  expect(replacement.sessionId).not.toBe(originalId);
  replacement.agent.state.model = replacement.modelRuntime.getModel("phase-fixture", "phase-model")!;
  replacement.settingsManager.applyOverrides({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" });
  await f.command("prompt", { workId: "replacement", message: "new runtime" });
  await f.request(0);
  expect(f.events.filter(event => event.type === "model_request_start")).toMatchObject([{ sessionId: replacement.sessionId }]);
  expect(await f.command("get_state")).toMatchObject({ data: { live: { activity: "waiting_for_model" } } });
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, live: { activity: undefined, activitySince: undefined, tools: [] } } });
}, 5000);

it("does not report rejected admission or another session's provider requests", async () => {
  const rejected = await httpProviderFixture(`pi.on("before_provider_request", () => { throw new Error("fixture-admission-refused"); });`);
  rejected.native.settingsManager.applyOverrides({ retry: { enabled: false } });
  await rejected.command("prompt", { workId: "reject", message: "rejected" });
  await rejected.waitFor(event => event.type === "agent_settled");
  expect(rejected.arrivals).toHaveLength(0);
  expect(rejected.events.some(event => event.type === "model_request_start")).toBe(false);
  expect(await rejected.command("get_state")).toMatchObject({ data: { live: { activity: undefined } } });
  const other = await httpProviderFixture();
  await other.command("prompt", { workId: "other", message: "another session" });
  other.finish((await other.request(0)).response, { content: "done" });
  await other.waitFor(event => event.type === "agent_settled");
  expect(rejected.events.some(event => event.type === "model_request_start")).toBe(false);
  const nested = other.native.modelRuntime.completeSimple(other.native.model!, { messages: [{ role: "user", content: "nested", timestamp: Date.now() }] });
  other.finish((await other.request(1)).response, { content: "nested done" });
  await nested;
  expect(other.events.filter(event => event.type === "model_request_start")).toHaveLength(1);
}, 5000);

it("sandbox exposes exactly four tools without instructions, discovered extensions, or host shell RPC", async () => {
  const f = await fixture(undefined, `export default pi => { throw new Error("must not load sandbox extensions"); };`, {}, true, true);
  expect(f.native.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
  expect(await f.command("prompt", { workId: "sandbox-context", message: "hello" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  const context = (await f.command("get_context")).data as { systemPrompt: string; tools: { name: string; description: string }[] };
  expect(context.systemPrompt).toMatch(/^\[Model delivery:[^\n]*\]\n$/);
  expect(context.tools.map(tool => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
  expect(context.tools.every(tool => tool.description.includes("Confined test implementation."))).toBe(true);
  expect(await f.command("bash", { command: "id" })).toMatchObject({ success: false });
  expect(await f.command("switch_session", { sessionPath: "/etc/passwd" })).toMatchObject({ success: false });
}, 3000);

it("reads native tool results without duplicating messages or emitting context snapshots", async () => {
  const f = await fixture(undefined, `export default pi => {
    pi.registerTool({ name: "fixture_result", label: "Fixture", description: "Fixture result",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "tool output" }], details: {} }) });
  }`);
  const call = f.message([{ type: "toolCall", id: "result", name: "fixture_result", arguments: {} }], "toolUse");
  call.usage = { ...call.usage, input: 10_000, output: 20, totalTokens: 10_020 };
  const answer = f.message([{ type: "text", text: "done" }], "stop");
  answer.usage = { ...answer.usage, input: 11_000, output: 30, totalTokens: 11_030 };
  let requests = 0;
  let nextRequestUsage: ReturnType<AgentSession["getContextUsage"]>;
  f.native.agent.streamFunction = () => {
    if (requests++ === 0) return f.reply(call);
    nextRequestUsage = f.native.getContextUsage();
    return f.reply(answer);
  };
  expect(await f.command("prompt", { workId: "tool", message: "use tool" })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled");
  const user = { role: "user", content: [{ type: "text", text: "use tool" }] };
  const result = { role: "toolResult", toolCallId: "result", toolName: "fixture_result", isError: false,
    content: [{ type: "text", text: "tool output" }] };
  expect(requests).toBe(2);
  expect(f.events.some(event => event.type === "context_update")).toBe(false);
  const context = (await f.command("get_context")).data as any;
  expect(f.native.messages.filter((message: any) => message.role !== "system")).toMatchObject([user, call, result, answer]);
  const projected = context.messages.filter((message: any) => message.role !== "system");
  expect(projected.map((message: any) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(projected[2]).toMatchObject({ toolCallId: "result", toolName: "fixture_result", isError: false });
  expect(projected[2].content.at(-1)).toEqual({ type: "text", text: "tool output" });
  expect(projected[3]).toEqual(answer);
  expect(nextRequestUsage?.tokens).toBeGreaterThanOrEqual(10_020);
  expect(context.contextUsage.tokens).toBe(11_030);
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
  expect(await f.command("set_speed", { speed: "ultrafast" })).toMatchObject({ success: true, data: { speed: "ultrafast" } });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "ultrafast" });
  const sol = nativeModels.find(model => model.provider === "openai-codex" && model.id === "gpt-6.1-sol")!;
  vi.spyOn(f.native.modelRuntime, "getModels").mockReturnValue([...f.native.modelRuntime.getModels(), sol]);
  f.native.agent.state.model = sol;
  expect(await f.command("set_speed", { speed: "ultrafast" })).toMatchObject({ success: true, data: { speed: "ultrafast" } });
  expect(await providerPayload()).toMatchObject({ request: "fixture", service_tier: "ultrafast" });
  f.native.agent.state.model = f.native.modelRuntime.getModel("openai-codex", "gpt-6-luna")!;
  expect(await f.command("set_speed", { speed: "ultrafast" })).toMatchObject({ success: false, error: "Ultrafast speed requires OpenAI Codex Astra or Sol" });
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

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=" };
function cancellableReply(f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  signal?.addEventListener("abort", () => {
    stream.push({ type: "error", reason: "aborted", error: f.message([], "aborted") });
    stream.end();
  }, { once: true });
  return stream;
}

it.each(["steer", "follow_up"])("retains accepted unlanded %s for exact redelivery after abort and reopen", async delivery => {
  const f = await fixture(), started = deferred();
  f.native.agent.streamFunction = (_model, _context, options) => {
    started.resolve();
    const stream = cancellableReply(f, options?.signal);
    const partial = f.message([{ type: "thinking", thinking: "reason" }], "stop");
    stream.push({ type: "start", partial });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "reason", partial });
    return stream;
  };
  expect(await f.command("prompt", { workId: "root", message: "root" })).toMatchObject({ success: true });
  await started.promise;
  await f.waitFor(event => (event.assistantMessageEvent as any)?.type === "thinking_delta");
  const original = { workId: "waiting", message: "  exact original\ninput  ", images: [image] };
  expect(await f.command(delivery, original)).toMatchObject({ success: true });
  expect(await f.command("get_state")).toMatchObject({ data: {
    acceptedWorkIds: ["root", "waiting"], landedWorkIds: ["root"], completedWorkIds: [],
    live: { activity: "thinking", isThinking: true },
  } });
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([
    { outcome: "cancelled", workIds: ["root"], deferredWorkIds: ["waiting"] },
  ]);
  expect(await f.command("get_state")).toMatchObject({ data: {
    deferredWorkIds: ["waiting"], live: { activity: undefined, activitySince: undefined, isThinking: false, tools: [] },
  } });
  const path = f.native.sessionFile!;
  expect(readFileSync(path, "utf8")).toContain('"customType":"thread_deferred"');
  await f.reopen();
  expect(await f.command("get_state")).toMatchObject({ data: {
    acceptedWorkIds: ["root"], landedWorkIds: ["root"], completedWorkIds: ["root"], deferredWorkIds: ["waiting"],
    live: { activity: undefined, isThinking: false, tools: [] },
  } });
  f.native.settingsManager.applyOverrides({ images: { autoResize: false } });
  const requests: unknown[] = [];
  f.native.agent.streamFunction = (_model, context) => { requests.push(context.messages); return f.reply(f.message([{ type: "text", text: "redelivered" }], "stop")); };
  expect(await f.command("prompt", { ...original, resume: true, message: "must not replace original", images: [] })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[]).includes("waiting"));
  expect(requests).toHaveLength(1);
  const users = f.native.messages.filter(message => message.role === "user");
  expect(users).toHaveLength(2);
  expect(users.at(-1)).toMatchObject({ content: [{ type: "text", text: original.message }, image] });
  expect(f.native.messages.some(message => message.role === "custom" && message.customType === "thread_recovery")).toBe(false);
  expect(await f.command("get_state")).toMatchObject({ data: { completedWorkIds: ["root", "waiting"], landedWorkIds: ["root", "waiting"], deferredWorkIds: [] } });
  expect(await f.command("prompt", original)).toMatchObject({ data: { alreadyAccepted: true, completed: true } });
  expect(requests).toHaveLength(1);
}, 3000);

it("cancels a landed steer without replay, including identical input text and extension transformations", async () => {
  const f = await fixture(undefined, `export default pi => pi.on("input", event => ({ action: "transform", text: "transformed: " + event.text }));`);
  const first = createAssistantMessageEventStream(), started = deferred(), second = deferred();
  let requests = 0;
  f.native.agent.streamFunction = (_model, _context, options) => {
    if (++requests === 1) { started.resolve(); return first; }
    second.resolve();
    return cancellableReply(f, options?.signal);
  };
  expect(await f.command("prompt", { workId: "root", message: "identical" })).toMatchObject({ success: true });
  await started.promise;
  expect(await f.command("steer", { workId: "landed", message: "identical" })).toMatchObject({ success: true });
  first.push({ type: "done", reason: "stop", message: f.message([{ type: "text", text: "first" }], "stop") });
  first.end();
  await second.promise;
  expect(await f.command("get_state")).toMatchObject({ data: { landedWorkIds: ["root", "landed"] } });
  expect(f.events.filter(event => event.type === "message_start" && (event.message as { role?: string })?.role === "user").map(event => event.inputWorkId)).toEqual(["root", "landed"]);
  expect(await f.command("abort")).toMatchObject({ success: true });
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([{ outcome: "cancelled", workIds: ["root", "landed"], deferredWorkIds: [] }]);
  await f.reopen();
  const stream = vi.fn(f.native.agent.streamFunction);
  f.native.agent.streamFunction = stream;
  expect(await f.command("get_state")).toMatchObject({ data: { landedWorkIds: ["root", "landed"], completedWorkIds: ["root", "landed"] } });
  expect(await f.command("steer", { workId: "landed", message: "identical", resume: true })).toMatchObject({ data: { alreadyAccepted: true, completed: true } });
  expect(stream).not.toHaveBeenCalled();
  expect(f.native.messages.filter(message => message.role === "user")).toHaveLength(2);
}, 3000);

it("repairs historical cancellation receipts without replaying landed native user history", async () => {
  const f = await fixture();
  const manager = f.native.sessionManager;
  manager.appendCustomEntry("thread_input", { workId: "old-root", message: "root", delivery: "prompt" });
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "root" }], timestamp: 1 });
  manager.appendCustomEntry("thread_input", { workId: "old-landed", message: "landed", delivery: "steer" });
  manager.appendMessage({ role: "user", content: "landed", timestamp: 2 });
  manager.appendCustomEntry("thread_input", { workId: "old-waiting", message: "waiting", images: [image], delivery: "steer" });
  manager.appendCustomEntry("thread_settled", { workIds: ["old-root", "old-landed", "old-waiting"], outcome: "cancelled", assistantEntryId: null });
  await f.reopen();
  expect(await f.command("get_state")).toMatchObject({ data: {
    acceptedWorkIds: ["old-root", "old-landed"], landedWorkIds: ["old-root", "old-landed"], completedWorkIds: ["old-root", "old-landed"], deferredWorkIds: ["old-waiting"],
  } });
  expect(await f.command("steer", { workId: "old-landed", message: "do not replay" })).toMatchObject({ data: { alreadyAccepted: true, completed: true } });
  f.native.settingsManager.applyOverrides({ images: { autoResize: false } });
  expect(await f.command("prompt", { workId: "old-waiting", message: "wrong", images: [], resume: true })).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[]).includes("old-waiting"));
  expect(f.native.messages.filter(message => message.role === "user").at(-1)).toMatchObject({ content: [{ type: "text", text: "waiting" }, image] });
  expect(await f.command("get_state")).toMatchObject({ data: { deferredWorkIds: [], completedWorkIds: ["old-root", "old-landed", "old-waiting"] } });
  const persisted = SessionManager.open(f.native.sessionFile!).getBranch();
  expect(persisted.filter(entry => entry.type === "custom" && entry.customType === "thread_input")).toHaveLength(3);
}, 3000);

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
  expect(requests.at(-1)?.slice(-3)).toEqual([1, 2, 3].map(number => expect.stringMatching(new RegExp(`^\\[Model delivery: [^\\n]+\\]\\nsteer ${number}$`))));
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
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, pendingMessageCount: 0, landedWorkIds: ["root", "window"] } });
  expect(f.events.filter(event => event.type === "message_start" && (event.message as { role?: string })?.role === "user").map(event => event.inputWorkId)).toEqual(["root", "window"]);
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

it("continues model work after Bash yields while retaining shell custody until completion", async () => {
  const f = await fixture();
  let calls = 0;
  f.native.agent.streamFunction = () => f.reply(calls++ === 0
    ? f.message([{ type: "toolCall", id: "async-shell", name: "bash", arguments: { command: "sleep .6; printf finished", timeout: 2, yield_time_ms: 10 } }], "toolUse")
    : f.message([{ type: "text", text: "Other useful work completed" }], "stop"));
  await f.command("prompt", { workId: "yielding", message: "start and continue" });
  await f.waitFor(event => event.type === "message_end" && (event.message as any)?.role === "assistant" && JSON.stringify((event.message as any).content).includes("Other useful work completed"));
  expect(calls).toBe(2);
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: true, localTools: 1 } });
  expect(f.events.some(event => event.type === "agent_settled")).toBe(false);
  await f.waitFor(event => event.type === "agent_settled" && (event.workIds as string[])?.includes("yielding"));
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, localTools: 0 } });
  const receipt = f.native.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "thread_shell_session_v1").at(-1)!;
  expect(receipt).toMatchObject({ data: { status: "completed", exit_code: 0 } });
}, 3000);

it("preserves Bash authorization hooks before any asynchronous launch", async () => {
  const guard = join(process.cwd(), "../runtime/extensions/bash-timeout-guard/index.mjs");
  const f = await fixture(undefined, `import guard from ${JSON.stringify(guard)}; export default guard;`);
  let calls = 0;
  f.native.agent.streamFunction = () => f.reply(calls++ === 0
    ? f.message([{ type: "toolCall", id: "refused-shell", name: "bash", arguments: { command: "sleep .4 &", timeout: 2, yield_time_ms: 0 } }], "toolUse")
    : f.message([{ type: "text", text: "refusal handled" }], "stop"));
  await f.command("prompt", { workId: "refused", message: "guarded launch" });
  await f.waitFor(event => event.type === "agent_settled");
  expect(f.native.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "thread_shell_session_v1")).toBe(false);
  expect(f.native.messages.find(message => message.role === "toolResult")).toMatchObject({ isError: true });
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
  expect(f.events.filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: [], deferredWorkIds: ["dialog"], outcome: "cancelled" }]);
  expect(await f.command("get_state")).toMatchObject({ data: { isStreaming: false, completedWorkIds: [], deferredWorkIds: ["dialog"] } });
}, 3000);
