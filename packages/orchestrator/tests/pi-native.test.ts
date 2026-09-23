import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { openPiSession } from "../src/threads/pi-session.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
import type { PiCommand, PiEvent, PiSessionOptions } from "../src/threads/contracts.js";

const captured = vi.hoisted(() => ({ session: undefined as AgentSession | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, createAgentSessionFromServices: async (...args: Parameters<typeof sdk.createAgentSessionFromServices>) => {
    const result = await sdk.createAgentSessionFromServices(...args);
    captured.session = result.session;
    return result;
  } };
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pi-native-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

it("does not inherit another thread's restore flag, but still refuses lost required history", async () => {
  const cwd = directory();
  const options: PiSessionOptions = { cwd, args: [], env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1" }, threadId: "fresh", sessionFile: join(cwd, "fresh.jsonl") };
  vi.stubEnv("PI_THREAD_REQUIRE_SESSION", "1");
  try {
    const session = await openPiSession(JSON.parse(JSON.stringify(options)), () => {}, () => {});
    try { expect(existsSync(options.sessionFile)).toBe(true); }
    finally { await session.close(); }
    const missing = join(cwd, "missing.jsonl");
    await expect(openPiSession({ ...options, threadId: "lost", sessionFile: missing, env: { ...options.env, PI_THREAD_REQUIRE_SESSION: "1" } }, () => {}, () => {})).rejects.toThrow("Native Pi session is missing");
    expect(existsSync(missing)).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

it("retains native history, resources, thread tools and RPC session replacement", async () => {
  const cwd = directory();
  writeFileSync(join(cwd, "AGENTS.md"), "fixture context supplied by the project");
  writeFileSync(join(cwd, "extension.mjs"), `export default function(pi) {
    pi.registerTool({name:"fixture_resource",label:"Fixture",description:"Fixture tool",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
    pi.registerCommand("fixture_command",{description:"Fixture command",handler:async()=>{}});
  }`);
  const output: PiEvent[] = [];
  let exits = 0;
  const options: PiSessionOptions = { cwd, args: ["--extension", join(cwd, "extension.mjs")],
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1" }, threadId: "native-thread", sessionFile: join(cwd, "native.jsonl") };
  seedPiSession(options.sessionFile, cwd);
  const history = SessionManager.open(options.sessionFile);
  history.appendMessage({ role: "user", content: "Historical user request", timestamp: 1 });
  const session = await openPiSession(options, event => output.push(event), () => exits++);
  cleanups.push(() => session.close());
  const request = async (command: PiCommand) => {
    const id = `${command.type}-${output.length}`;
    await session.command({ ...command, id });
    for (let count = 0; count < 100; count++) {
      const response = output.find(event => event.type === "response" && event.id === id);
      if (response) return response;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error(`No response: ${command.type}`);
  };
  expect(await request({ type: "get_state" })).toMatchObject({ success: true, data: { messageCount: 1, acceptedWorkIds: [], completedWorkIds: [] } });
  const context = await request({ type: "get_context" });
  expect((context.data as { systemPrompt: string }).systemPrompt).toContain("fixture context supplied by the project");
  const names = (context.data as { tools: { name: string }[] }).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "fixture_resource", "thread_await", "thread_spawn", "thread_read", "thread_list", "thread_send", "thread_control"]));
  expect(names.some(name => name.startsWith("core_"))).toBe(false);
  expect(names.filter(name => name.startsWith("thread_")).sort()).toEqual(["thread_await", "thread_control", "thread_list", "thread_read", "thread_send", "thread_spawn"]);
  expect(await request({ type: "prompt", workId: "handled", message: "/fixture_command" })).toMatchObject({ success: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(readFileSync(options.sessionFile, "utf8")).toContain('"workId":"handled"');
  expect(await request({ type: "get_state" })).toMatchObject({ data: { acceptedWorkIds: ["handled"], completedWorkIds: ["handled"], lastAssistantMessage: null } });
  const before = output.filter(event => event.type === "agent_settled").length;
  expect(await request({ type: "prompt", workId: "handled", resume: true, message: "Do not execute twice" })).toMatchObject({ data: { alreadyAccepted: true, completed: true } });
  expect(output.filter(event => event.type === "agent_settled")).toHaveLength(before);
  expect(await request({ type: "steer", workId: "queued", message: "steering" })).toMatchObject({ success: true });
  expect(await request({ type: "clear_queue" })).toMatchObject({ success: true, data: { steering: ["steering"], followUp: [] } });
  expect(await request({ type: "abort" })).toMatchObject({ success: true });
  expect(await request({ type: "new_session" })).toMatchObject({ success: true });
  const next = (await request({ type: "get_state" })).data as { sessionId: string; sessionFile: string };
  expect(next.sessionFile).not.toBe(options.sessionFile);
  expect(SessionManager.open(next.sessionFile).getSessionId()).toBe(next.sessionId);
  expect(output).toContainEqual(expect.objectContaining({ type: "session_changed", sessionFile: next.sessionFile }));
  expect(await request({ type: "switch_session", sessionPath: options.sessionFile })).toMatchObject({ success: true });
  expect((await request({ type: "get_messages" })).data).toMatchObject({ messages: [{ role: "user", content: "Historical user request" }] });
  await session.close();
  expect(exits).toBe(1);
  const reopened = await openPiSession(options, event => output.push(event), () => exits++);
  await reopened.command({ type: "get_state", id: "reopened" });
  expect(output.at(-1)).toMatchObject({ id: "reopened", data: { acceptedWorkIds: ["handled", "queued"], completedWorkIds: ["handled", "queued"] } });
  await reopened.close();
  expect(exits).toBe(2);
});

it("acknowledges compaction admission before its durable terminal result and replays that result", async () => {
  const cwd = directory(), events: PiEvent[] = [];
  let settled!: (event: PiEvent) => void;
  const completion = new Promise<PiEvent>(resolve => { settled = resolve; });
  const options: PiSessionOptions = { cwd, args: [], env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1" }, threadId: "compact-thread", sessionFile: join(cwd, "native.jsonl") };
  const session = await openPiSession(options, event => { events.push(event); if (event.type === "command_settled") settled(event); }, () => {});
  try {
    const command = { type: "compact", id: "compact-once" };
    await session.command(command);
    expect(events.find(event => event.type === "response" && event.id === command.id)).toMatchObject({ success: true, data: { accepted: true } });
    await completion;
    const before = events.filter(event => event.type === "command_settled").length;
    await session.command(command);
    expect(events.at(-1)).toMatchObject({ type: "response", id: command.id, success: false });
    expect(events.filter(event => event.type === "command_settled")).toHaveLength(before);
    expect(readFileSync(options.sessionFile, "utf8")).toContain("thread_command_result");
  } finally { await session.close(); }
});

it("adopts a completed fork from its source receipt after losing the replacement event", async () => {
  const cwd = directory(), events: PiEvent[] = [];
  const options: PiSessionOptions = { cwd, args: [], env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1" }, threadId: "fork-thread", sessionFile: join(cwd, "source.jsonl") };
  seedPiSession(options.sessionFile, cwd);
  const history = SessionManager.open(options.sessionFile);
  const entryId = history.appendMessage({ role: "user", content: "Fork point", timestamp: 1 });
  const command = { type: "fork", id: "fork-once", entryId };
  const first = await openPiSession(options, event => events.push(event), () => {});
  await first.command(command);
  expect(events.find(event => event.id === "fork-once")).toMatchObject({ success: true });
  const target = events.find(event => event.type === "session_changed")!.sessionFile;
  await first.close();
  const reopened = await openPiSession(options, event => events.push(event), () => {});
  try {
    await reopened.command(command);
    await reopened.command({ type: "get_state", id: "adopted-state" });
    expect(events.at(-1)).toMatchObject({ id: "adopted-state", data: { sessionFile: target } });
    expect(events.filter(event => event.id === "fork-once")).toHaveLength(2);
    expect(events.filter(event => event.id === "fork-once").every(event => event.success)).toBe(true);
  } finally { await reopened.close(); }
});

it("gives a raw session no tools, no resources and an empty system prompt", async () => {
  const cwd = directory();
  writeFileSync(join(cwd, "AGENTS.md"), "fixture context supplied by the project");
  writeFileSync(join(cwd, "extension.mjs"), `export default function(pi) {
    pi.registerTool({name:"fixture_resource",label:"Fixture",description:"Fixture tool",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
  }`);
  const output: PiEvent[] = [];
  const options: PiSessionOptions = { cwd, args: ["--raw", "--extension", join(cwd, "extension.mjs")],
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1", PI_REMOTE_SESSION_ID: "raw-thread", PI_REMOTE_SERVER_URL: "http://127.0.0.1:1",
      PI_ORCHESTRATOR_CONFIG: join(cwd, "config.json"), PI_ORCHESTRATOR_LEDGER: join(cwd, "ledger.sqlite3"), PI_ORCHESTRATOR_AUTH: join(cwd, "auth.json"),
      PI_MODEL_BROKER_URL: undefined, PI_ORCHESTRATOR_ASSIGNED: "0", PI_SUBAGENT_MODEL: undefined },
    threadId: "raw-thread", sessionFile: join(cwd, "raw.jsonl") };
  let settled!: (event: PiEvent) => void;
  const completion = new Promise<PiEvent>(resolve => { settled = resolve; });
  const session = await openPiSession(options, event => { output.push(event); if (event.type === "agent_settled") settled(event); }, () => {});
  cleanups.push(async () => { await session.command({ type: "abort" }); await session.close(); });
  const native = captured.session!;
  native.agent.state.model = native.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
  // PI_OFFLINE only disables startup networking, not auth preflight or provider calls.
  vi.spyOn(native.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  const stream = vi.fn<typeof native.agent.streamFunction>(() => { throw new Error("fixture provider failure"); });
  native.agent.streamFunction = stream;
  const request = async (command: PiCommand) => {
    const id = `${command.type}-${output.length}`;
    await session.command({ ...command, id });
    for (let count = 0; count < 100; count++) {
      const response = output.find(event => event.type === "response" && event.id === id);
      if (response) return response;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error(`No response: ${command.type}`);
  };
  const context = (await request({ type: "get_context" })).data as { systemPrompt: string; tools: { name: string }[] };
  expect(context.tools).toEqual([]);
  expect(context.systemPrompt).toBe("");
  const accepted = await request({ type: "prompt", workId: "hello", message: "hello" });
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ success: true });
  expect(await completion).toMatchObject({ workIds: ["hello"], outcome: "failed", lastAssistantMessage: { errorMessage: "fixture provider failure" } });
  expect(stream).toHaveBeenCalledOnce();
  expect(stream.mock.calls[0][1]).toEqual({ messages: [
    { role: "system", content: "", timestamp: expect.any(Number) },
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: expect.any(Number) },
  ] });
  const update = output.find(event => event.type === "context_update") as { contextOwner: string; context: { systemPrompt: string; tools: unknown[]; messages: { role: string; content: unknown }[] } } | undefined;
  expect(update).toBeDefined();
  expect(update!.contextOwner).toBe("runner");
  expect(update!.context.systemPrompt).toBe("");
  expect(update!.context.tools).toEqual([]);
  expect(update!.context.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: expect.any(Number) }]);
  await expect(openPiSession({ ...options, threadId: "raw-isolated", sessionFile: join(cwd, "raw-isolated.jsonl"), args: ["--raw", "--orchestrator-context", JSON.stringify({ tools: [] })] }, () => {}, () => {}))
    .rejects.toThrow("Raw Pi sessions cannot carry an isolated application context");
}, 3000);
