import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openPiSession } from "../src/cores/pi.js";
import { seedPiSession } from "../src/cores/pi-transfer.js";
import type { CoreCommand, CoreOutput, CoreSessionOptions } from "../src/cores/contracts.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pi-native-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

it("imports portable history without replaying user requests or foreign tool calls", () => {
  const cwd = directory();
  const file = join(cwd, "native.jsonl");
  const messages = [
    { role: "user", content: "Do not replay this request" },
    { role: "assistant", content: [{ type: "text", text: "Prior answer" }, { type: "toolCall", id: "foreign-call", name: "bash", arguments: { command: "exit 99" } }] },
    { role: "toolResult", toolCallId: "foreign-call", content: "historical result" },
  ];
  seedPiSession(file, cwd, { version: 1, sourceCore: "codex", messages, agents: [{ id: "foreign-child", parentId: null, name: "Previous worker", state: "idle" }] });
  const manager = SessionManager.open(file);
  const context = manager.buildSessionContext();
  expect(context.messages).toHaveLength(3);
  expect(context.messages[0]).toMatchObject(messages[0]);
  expect(context.messages[1]).toMatchObject({ role: "custom", customType: "core_transfer_message", content: JSON.stringify(messages[1]) });
  expect(manager.getEntries()[0]).toMatchObject({ type: "custom", customType: "core_transfer", data: { sourceCore: "codex", agents: [{ id: "foreign-child" }] } });
  expect(readFileSync(file, "utf8")).toContain("Prior answer");
});

it("retains SDK discovery, core tools, shared RPC commands and durable session replacement", async () => {
  const cwd = directory();
  writeFileSync(join(cwd, "AGENTS.md"), "fixture context supplied by the project");
  writeFileSync(join(cwd, "extension.mjs"), `export default function(pi) {
    pi.registerTool({name:"fixture_resource",label:"Fixture",description:"Fixture tool",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
    pi.registerCommand("fixture_command",{description:"Fixture command",handler:async()=>{}});
  }`);
  const output: CoreOutput[] = [];
  let exits = 0;
  const options: CoreSessionOptions = { cwd, args: ["--name", "Fixture session", "--extension", join(cwd, "extension.mjs")],
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1" }, sessionId: "native-root", stateDir: join(cwd, "state"),
    transfer: { version: 1, sourceCore: "pi", messages: [{ role: "user", content: "Historical user request", timestamp: 1 }], agents: [] },
  };
  const core = await openPiSession(options, event => output.push(event), () => exits++);
  cleanups.push(() => core.close());
  const request = async (command: CoreCommand) => {
    const id = `${command.type}-${output.length}`;
    await core.command({ ...command, id });
    return [...output].reverse().find(event => event.type === "response" && event.id === id)!;
  };
  const state = await request({ type: "get_state" });
  expect(state).toMatchObject({ success: true, data: { sessionName: "Fixture session", messageCount: 1, core: "pi", coreBusy: false } });
  const original = (state.data as { sessionId: string; sessionFile: string });
  const context = await request({ type: "get_core_context" });
  expect((context.data as { systemPrompt: string }).systemPrompt).toContain("fixture context supplied by the project");
  const names = (context.data as { tools: { name: string }[] }).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "fixture_resource", "core_delegate", "core_read", "core_list", "core_control"]));
  expect(await request({ type: "get_commands" })).toMatchObject({ success: true, data: { commands: expect.arrayContaining([expect.objectContaining({ name: "fixture_command" })]) } });
  expect(await request({ type: "prompt", message: "/fixture_command" })).toMatchObject({ command: "prompt", success: true });
  expect(await request({ type: "steer", message: "steering" })).toMatchObject({ success: true });
  expect(await request({ type: "follow_up", message: "followup" })).toMatchObject({ success: true });
  expect(await request({ type: "clear_queue" })).toMatchObject({ success: true, data: { steering: ["steering"], followUp: ["followup"] } });
  const replacement = await request({ type: "new_session" });
  expect(replacement, JSON.stringify(replacement)).toMatchObject({ success: true });
  const next = (await request({ type: "get_state" })).data as { sessionId: string; sessionFile: string };
  expect(next.sessionId).not.toBe(original.sessionId);
  expect(SessionManager.open(next.sessionFile).getSessionId()).toBe(next.sessionId);
  expect(await request({ type: "switch_session", sessionPath: original.sessionFile })).toMatchObject({ success: true });
  expect((await request({ type: "get_messages" })).data).toMatchObject({ messages: [{ role: "user", content: "Historical user request" }] });
  await core.close();
  expect(exits).toBe(1);
  const reopened = await openPiSession(options, event => output.push(event), () => exits++);
  await reopened.command({ type: "get_messages", id: "reopened" });
  expect(output.at(-1)).toMatchObject({ id: "reopened", data: { messages: [{ role: "user", content: "Historical user request" }] } });
  await reopened.close();
  expect(exits).toBe(2);
});
