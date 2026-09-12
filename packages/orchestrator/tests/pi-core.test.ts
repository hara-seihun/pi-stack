import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiCoreSession } from "../src/cores/pi.js";
import type { CoreCommand, CoreOutput, CoreSessionOptions } from "../src/cores/contracts.js";
import type { OpenPiNative, PiNative, PiNode, PiSnapshot, PiToolsHost } from "../src/cores/pi-types.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

class Fixture implements PiNative {
  commands: CoreCommand[] = [];
  injections: { kind: string; data: Record<string, unknown> }[] = [];
  closed = 0;
  state: PiSnapshot;
  constructor(readonly node: PiNode, readonly tools: PiToolsHost, readonly output: (event: CoreOutput) => void) {
    this.state = { nativeSessionId: `native-${node.id}`, sessionFile: node.sessionFile,
      cwd: node.cwd, model: node.model, provider: node.provider, messages: [], entries: [] };
  }
  snapshot() { return this.state; }
  async command(command: CoreCommand) {
    this.commands.push(command);
    if (command.type === "prompt") this.output({ type: "agent_start" });
    if (command.type === "abort") this.output({ type: "agent_settled" });
    this.output({ type: "response", id: command.id, command: command.type, success: true,
      ...(command.type === "get_state" ? { data: { isStreaming: false, pendingMessageCount: 0, sessionFile: this.state.sessionFile } } : {}) });
  }
  async inject(kind: string, data: Record<string, unknown>) {
    this.injections.push({ kind, data });
    this.output({ type: "agent_start" });
    this.state.entries.push({ type: "custom_message", customType: kind, details: data });
    this.output({ type: "message_end", message: { role: "custom", customType: kind, details: data } });
  }
  finish(text: string) {
    this.state.messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
    this.output({ type: "agent_end" });
    this.output({ type: "agent_settled" });
  }
  async close() { this.closed++; }
}

async function setup(existing?: string, configure?: (fixture: Fixture) => void) {
  const directory = existing ?? mkdtempSync(join(tmpdir(), "pi-core-"));
  if (!existing) cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const fixtures = new Map<string, Fixture>();
  const output: CoreOutput[] = [];
  let exits = 0;
  const options: CoreSessionOptions = { cwd: directory, args: ["--provider", "fixture", "--model", "root", "--thinking", "low"],
    env: {}, sessionId: "root", stateDir: directory };
  const open: OpenPiNative = async (_options, node, tools, emit) => {
    const fixture = new Fixture(node, tools, emit);
    fixtures.set(node.id, fixture);
    configure?.(fixture);
    return fixture;
  };
  const core = await new PiCoreSession(options, event => output.push(event), () => exits++, open).open();
  cleanups.push(() => core.close());
  return { core, directory, fixtures, output, options, exits: () => exits };
}
const childId = (receipt: unknown) => (receipt as { agent: { id: string } }).agent.id;

describe("Pi-owned delegation", () => {
  it("keeps root wire commands and waits for the complete child tree before settling", async () => {
    const { core, fixtures, output } = await setup();
    await core.command({ type: "prompt", id: "root-prompt", message: "work" });
    expect(output).toContainEqual({ type: "response", id: "root-prompt", command: "prompt", success: true });
    const first = childId(await core.delegate("root", "delegate-1", { task: "bounded work" }));
    await turn();
    const second = childId(await core.delegate(first, "delegate-2", { task: "independent part" }));
    await turn();
    fixtures.get("root")!.finish("Waiting for children");
    fixtures.get(first)!.finish("Waiting for my child");
    await turn();
    expect(output.filter(event => event.type === "agent_settled")).toHaveLength(0);
    await core.command({ type: "get_state", id: "waiting-on-tree" });
    expect(output.at(-1)).toMatchObject({ id: "waiting-on-tree", data: {
      isStreaming: true, nativeIsStreaming: false, pendingMessageCount: 2, coreBusy: true, treeComplete: false,
      nativeSessionId: "native-root",
      sessionFile: fixtures.get("root")!.state.sessionFile,
    } });
    fixtures.get(second)!.finish("grandchild result");
    await turn();
    expect(fixtures.get(first)!.injections[0]).toMatchObject({ kind: "core_child_result", data: { agentId: second, result: "grandchild result" } });
    expect(fixtures.get("root")!.injections).toHaveLength(0);
    fixtures.get(first)!.finish("integrated child result");
    await turn();
    expect(fixtures.get("root")!.injections[0]).toMatchObject({ kind: "core_child_result", data: { result: "integrated child result" } });
    fixtures.get("root")!.finish("all done");
    await turn();
    expect(output.filter(event => event.type === "agent_settled")).toHaveLength(1);
    expect(core.list().every(agent => agent.state === "idle")).toBe(true);
    await core.command({ type: "get_state", id: "idle-tree" });
    expect(output.at(-1)).toMatchObject({ id: "idle-tree", data: { isStreaming: false, pendingMessageCount: 0, coreBusy: false,
      treeComplete: true, messageCount: 2, lastAssistantMessage: { role: "assistant", content: [{ type: "text", text: "all done" }] } } });
    expect(output.some(event => event.type === "core_child_event" && event.agentId === second)).toBe(true);
  });

  it("deduplicates tool retries and reuses settled native children", async () => {
    const { core, fixtures } = await setup();
    const child = childId(await core.delegate("root", "request", { task: "first" }));
    expect(childId(await core.delegate("root", "request", { task: "first" }))).toBe(child);
    await turn();
    expect(fixtures.get(child)!.commands.filter(command => command.type === "prompt")).toHaveLength(1);
    fixtures.get(child)!.finish("first result");
    await turn();
    fixtures.get("root")!.finish("integrated");
    await turn();
    expect(childId(await core.delegate("root", "second", { task: "second" }))).toBe(child);
    await turn();
    expect(fixtures.get(child)!.commands.filter(command => command.type === "prompt")).toHaveLength(2);
  });

  it("aborts descendants, clears queues, and closes every native session once", async () => {
    const { core, fixtures, exits } = await setup();
    const child = childId(await core.delegate("root", "request", { task: "work" }));
    await turn();
    const grandchild = childId(await core.delegate(child, "request", { task: "part" }));
    await turn();
    await core.command({ type: "abort", id: "stop" });
    await turn();
    expect(core.list().map(agent => agent.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    for (const id of ["root", child, grandchild]) expect(fixtures.get(id)!.commands.map(command => command.type)).toContain("clear_queue");
    expect(fixtures.get("root")!.injections).toHaveLength(0);
    await Promise.all([core.close(), core.close()]);
    for (const fixture of fixtures.values()) expect(fixture.closed).toBe(1);
    expect(exits()).toBe(1);
  });

  it("recovers durable child identities and resumes interrupted native work without re-delegating", async () => {
    const first = await setup();
    const child = childId(await first.core.delegate("root", "request", { task: "work" }));
    await turn();
    const state = readFileSync(join(first.directory, "pi-tree.json"), "utf8");
    await first.core.close();
    writeFileSync(join(first.directory, "pi-tree.json"), state);
    const recovered = await setup(first.directory);
    await turn();
    expect(recovered.core.list().find(agent => agent.id === child)?.nativeSessionId).toBe(`native-${child}`);
    expect(recovered.fixtures.get(child)!.commands).toHaveLength(0);
    expect(recovered.fixtures.get(child)!.injections).toEqual([{ kind: "core_recovery", data: { agentId: child, workId: "request", task: "work", status: "interrupted" } }]);
    recovered.fixtures.get(child)!.finish("recovered result");
    await turn();
    expect(recovered.fixtures.get("root")!.injections).toHaveLength(1);
  });

  it.each([false, true])("recovers the result outbox across a receipt boundary, received=%s", async received => {
    const first = await setup();
    await first.core.command({ type: "prompt", message: "parent work" });
    const child = childId(await first.core.delegate("root", "work-id", { task: "child work" }));
    await turn();
    first.fixtures.get(child)!.finish("durable child result");
    await turn();
    const file = join(first.directory, "pi-tree.json");
    const state = readFileSync(file, "utf8");
    await first.core.close();
    writeFileSync(file, state);
    const reopened = await setup(first.directory, fixture => {
      if (fixture.node.id === "root" && received) fixture.state.entries.push({ type: "custom_message", customType: "core_child_result", details: { workId: "work-id" } });
    });
    await turn();
    expect(reopened.fixtures.get("root")!.injections).toHaveLength(1);
    expect(reopened.fixtures.get("root")!.injections[0].kind).toBe(received ? "core_recovery" : "core_child_result");
    expect(reopened.fixtures.has(child)).toBe(false);
  });

  it("reports a rejected native control command instead of acknowledging success", async () => {
    const { core, fixtures, output } = await setup();
    const child = childId(await core.delegate("root", "request", { task: "work" }));
    await turn();
    fixtures.get(child)!.command = async command => {
      fixtures.get(child)!.output({ type: "response", id: command.id, command: command.type, success: false, error: "fixture rejected control" });
    };
    await core.command({ type: "core_agent_command", id: "control", agentId: child, action: "steer", message: "adjust" });
    expect(output.at(-1)).toMatchObject({ id: "control", success: false, error: "fixture rejected control" });
  });

  it("exposes the Remote inspection/control wire and rejects ancestor control", async () => {
    const { core, fixtures, output } = await setup();
    const child = childId(await core.delegate("root", "request", { task: "work" }));
    await turn();
    await core.command({ type: "core_agents", id: "list" });
    expect(output.at(-1)).toMatchObject({ command: "core_agents", success: true, data: { agents: [{ id: "root" }, { id: child }] } });
    await core.command({ type: "core_agent_command", id: "control", agentId: child, action: "steer", message: "adjust" });
    expect(fixtures.get(child)!.commands.at(-1)).toMatchObject({ type: "steer", message: "adjust" });
    expect(output.at(-1)).toMatchObject({ command: "core_agent_command", success: true });
    await core.command({ type: "core_agent_read", agentId: child });
    expect(output.at(-1)).toMatchObject({ success: true, data: { agent: { id: child }, messages: [], state: { isStreaming: true } } });
    await expect(core.read(child, -1)).rejects.toThrow("Invalid Pi read page");
    await expect(core.control("root", { type: "abort" }, child)).rejects.toThrow("only its descendants");
  });
});
