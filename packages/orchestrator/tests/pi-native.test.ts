import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openPiSession } from "../src/threads/pi-session.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
import type { PiCommand, PiEvent, PiSessionOptions } from "../src/threads/contracts.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pi-native-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

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
  expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "fixture_resource", "thread_spawn", "thread_read", "thread_list", "thread_send", "thread_control"]));
  expect(names.some(name => name.startsWith("core_"))).toBe(false);
  expect(names.filter(name => name.startsWith("thread_")).sort()).toEqual(["thread_control", "thread_list", "thread_read", "thread_send", "thread_spawn"]);
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
