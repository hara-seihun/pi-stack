import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiInputBatch } from "../src/threads/pi-input-batch.js";
import { PiExecution } from "../src/threads/pi-execution.js";
import { inputReceipts } from "../src/threads/pi-input-receipts.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
const roots: string[] = [], managers: SessionManager[] = [];
afterEach(() => { vi.restoreAllMocks(); managers.splice(0).forEach(manager => manager.dispose()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(manager?: SessionManager) {
  const root = mkdtempSync(join(tmpdir(), "pi-inbox-")); roots.push(root);
  if (!manager) { const file = join(root, "session.jsonl"); seedPiSession(file, root); manager = SessionManager.open(file); }
  managers.push(manager);
  const agent = new Agent({ streamFn: () => { throw new Error("Fixture has no provider"); } });
  const listeners: ((event: any) => unknown)[] = [];
  agent.subscribe = listener => { listeners.push(listener as any); return () => {}; };
  const publicListeners: ((event: any) => unknown)[] = [];
  const queue: any[] = [], output: any[] = [];
  let streaming = false;
  const session = { agent, sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
    get isStreaming() { return streaming; }, get isIdle() { return !streaming; }, get isBashRunning() { return false; }, get messages() { return agent.state.messages; },
    subscribe: (listener: any) => { publicListeners.push(listener); return () => {}; },
    sendCustomMessage: async (message: any) => { queue.push({ ...message, role: "custom", timestamp: Date.now() }); streaming = true; },
  } as unknown as AgentSession;
  listeners.push(event => { if (event.type === "message_end") {
    if (event.message.role === "custom") manager!.appendCustomMessageEntry(event.message.customType, event.message.content, true, event.message.details);
    else manager!.appendMessage(event.message);
  } });
  const execution = new PiExecution(); execution.bind(session);
  const inbox = new PiInputBatch(session, execution, event => output.push(event), () => {});
  const emit = async (event: any) => { for (const listener of listeners) await listener(event); };
  const assistant = { role: "assistant", content: [{ type: "text", text: "complete output" }], timestamp: Date.now() };
  const settled = async () => { streaming = false; for (const listener of publicListeners) await listener({ type: "agent_settled" }); };
  return { inbox, execution, session, queue, output, emit, settled, idle: () => { streaming = false; }, assistant, manager };
}

it("prompt acceptance waits for its committed landing and native settlement", async () => {
  const f = fixture();
  let finished = false;
  const prompt = f.inbox.acceptAndWait({ workId: "print", message: "synthetic print input" }).then(result => { finished = true; return result; });
  await Promise.resolve();
  expect(finished).toBe(false);
  await f.settled();
  expect(finished).toBe(false);
  await f.emit({ type: "message_end", message: f.queue.shift() });
  await f.emit({ type: "message_end", message: f.assistant });
  expect(finished).toBe(false);
  await f.settled();
  expect(await prompt).toEqual({ ok: true });
  f.inbox.close();
});

it("retains every streaming arrival until output finalization, then queues one ordered batch", async () => {
  const f = fixture();
  f.inbox.accept([{ workId: "initial", message: "start" }]); await Promise.resolve();
  await f.emit({ type: "message_end", message: f.queue.shift() });
  await f.emit({ type: "message_start", message: f.assistant });
  f.inbox.accept([{ workId: "human", message: "user input", inputOrigin: "human" }, { workId: "agent", message: "agent input", inputOrigin: "machine" }]);
  await Promise.resolve();
  expect(f.queue).toEqual([]);
  await f.emit({ type: "message_end", message: f.assistant });
  expect(f.queue).toHaveLength(1);
  expect(f.queue[0].details.workIds).toEqual(["human", "agent"]);
  expect(f.manager!.getEntries().filter(entry => entry.type === "custom" && entry.customType === "thread_input_batch_accepted")).toHaveLength(2);
  await f.emit({ type: "message_end", message: f.queue.shift() });
  expect(inputReceipts(f.manager!.getBranch()).landedWorkIds).toEqual(["initial", "human", "agent"]);
});

it("lands input arriving during request preparation in that request, not a later turn", async () => {
  const f = fixture();
  f.inbox.accept([{ workId: "initial", message: "start" }]); await Promise.resolve();
  await f.emit({ type: "message_end", message: f.queue.shift() });
  await f.emit({ type: "turn_start" });
  f.inbox.accept([{ workId: "late", message: "arrived during preparation" }]);
  const update = await f.session.agent.prepareRequest!({ context: { messages: [], tools: [] }, model: {} as any, thinkingLevel: "off" }, undefined);
  expect(update?.context?.messages.at(-1)).toMatchObject({ role: "custom", details: { workIds: ["late"] } });
  expect(f.queue).toEqual([]);
  expect(inputReceipts(f.manager!.getBranch()).landedWorkIds).toContain("late");
});

it("identity conflict rejects the entire new batch without partially accepting other IDs", () => {
  const f = fixture();
  f.inbox.accept([{ workId: "existing", message: "original" }]);
  expect(f.inbox.accept([{ workId: "new", message: "new bytes" }, { workId: "existing", message: "changed" }])).toMatchObject({ ok: false });
  expect(inputReceipts(f.manager!.getBranch()).acceptedWorkIds).toEqual(["existing"]);
  f.inbox.close();
});

it.each(["preparing", "native-live", "queued", "execution-active", "tools-active", "blocked", "bash-active", "admission-in-flight"] as const)("keeps the steering marker while native absence is not proven: %s", async state => {
  const f = fixture();
  f.inbox.accept([{ workId: "root", message: "initial" }]); await Promise.resolve();
  await f.emit({ type: "message_end", message: f.queue.shift() });
  await f.emit({ type: "message_start", message: f.assistant });
  let release!: () => void;
  if (state === "admission-in-flight") vi.spyOn(f.session, "sendCustomMessage").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  f.inbox.accept([{ workId: "terminal", message: "existing terminal receipt" }]);
  await f.emit({ type: "message_end", message: f.assistant });
  f.queue.splice(0);
  if (state === "native-live") vi.spyOn(f.session.agent.state, "isStreaming", "get").mockReturnValue(true);
  if (state === "queued") { f.session.agent.steer({ role: "user", content: "owned queued input", timestamp: 0 }); vi.spyOn(f.session.agent, "continue").mockResolvedValue(); }
  if (state === "execution-active") vi.spyOn(f.execution, "active", "get").mockReturnValue(true);
  if (state === "tools-active") vi.spyOn(f.execution, "activeTools", "get").mockReturnValue(1);
  if (state === "blocked") vi.spyOn(f.execution, "blocked", "get").mockReturnValue(true);
  if (state === "bash-active") vi.spyOn(f.session, "isBashRunning", "get").mockReturnValue(true);
  if (state === "preparing") { await f.emit({ type: "turn_start" }); f.idle(); }
  else await f.settled();
  f.inbox.reconcileIdleAdmission(); await Promise.resolve();
  expect(f.queue).toEqual([]);
  expect(f.inbox.awaitingAdmission).toBe(true);
  expect(inputReceipts(f.manager!.getBranch()).acceptedWorkIds).toEqual(["root", "terminal"]);
  expect(inputReceipts(f.manager!.getBranch()).landedWorkIds).toEqual(["root"]);
  f.inbox.close(); release?.();
});

it("v2 landing receipts require the following committed user content, including transformed prompts", () => {
  const accepted = { type: "custom", customType: "thread_input", data: { workId: "old", message: "/template", receiptVersion: 2 } };
  const claimed = { type: "custom", customType: "thread_landed", data: { workId: "old" } };
  expect(inputReceipts([accepted, claimed]).landedWorkIds).toEqual([]);
  expect(inputReceipts([accepted, claimed, { type: "message", message: { role: "user", content: "Expanded template content" } }]).landedWorkIds).toEqual(["old"]);
});

it("a batch command ID cannot be reused to admit different inputs", () => {
  const f = fixture();
  expect(f.inbox.accept([{ workId: "first", message: "original" }], { commandId: "command", batchId: "batch" })).toEqual({ ok: true });
  expect(f.inbox.accept([{ workId: "first", message: "original" }, { workId: "new", message: "new" }], { commandId: "command", batchId: "batch" })).toMatchObject({ ok: false });
  expect(inputReceipts(f.manager!.getBranch()).acceptedWorkIds).toEqual(["first"]);
  f.inbox.close();
});

it("a committed landing with a missed notification retires pending custody without redelivery", async () => {
  const f = fixture();
  f.inbox.accept([{ workId: "landed", message: "original" }]); await Promise.resolve();
  const message = f.queue.shift();
  f.manager!.appendCustomMessageEntry(message.customType, message.content, true, message.details);
  await f.settled();
  f.inbox.reconcileIdleAdmission(); await Promise.resolve();
  expect(f.queue).toEqual([]);
  expect(f.inbox.awaitingAdmission).toBe(false);
  expect(inputReceipts(f.manager!.getBranch()).landedWorkIds).toEqual(["landed"]);
  expect(f.manager!.getBranch().filter(entry => entry.type === "custom" && entry.customType === "thread_input_batch_accepted")).toHaveLength(1);
  f.inbox.close();
});

it("reconciles landed IDs from committed custom content, not a separate landing receipt", () => {
  const f = fixture(); f.inbox.accept([{ workId: "landed", message: "original" }]); f.inbox.close();
  f.manager!.appendCustomMessageEntry("thread_input_batch", "original", true, { batchId: "cutoff", workIds: ["landed"] });
  f.manager!.dispose();
  const recovered = fixture(SessionManager.open(f.session.sessionFile!));
  expect(recovered.inbox.awaitingAdmission).toBe(false);
  recovered.inbox.close();
});
