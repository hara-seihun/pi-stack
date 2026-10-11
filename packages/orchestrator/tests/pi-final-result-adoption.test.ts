import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { openPiSession, piEnvironmentScope } from "../src/threads/pi-session.js";
import { adoptResidentFinalResultRecovery, nativeMethodHash, type ResidentFinalResultTarget } from "../src/threads/pi-final-result-adoption.js";
import type { PiEvent, PiSession } from "../src/threads/contracts.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";

const captured = vi.hoisted(() => ({ session: undefined as any, inbox: undefined as any, execution: undefined as any,
  output: undefined as any, settle: undefined as any }));
vi.mock("../src/threads/pi-input-batch.js", async importOriginal => {
  const module = await importOriginal<typeof import("../src/threads/pi-input-batch.js")>();
  return { ...module, PiInputBatch: class extends module.PiInputBatch {
    constructor(...args: ConstructorParameters<typeof module.PiInputBatch>) {
      super(...args); [captured.session, captured.execution, captured.output] = args; captured.inbox = this;
    }
  } };
});
vi.mock("../src/threads/pi-execution.js", async importOriginal => {
  const module = await importOriginal<typeof import("../src/threads/pi-execution.js")>();
  return { ...module, PiExecution: class extends module.PiExecution {
    constructor(...args: ConstructorParameters<typeof module.PiExecution>) { super(...args); captured.settle = args[0]; }
  } };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture(id: string) {
  const cwd = mkdtempSync(join(tmpdir(), "final-result-adoption-")), events: PiEvent[] = [], waiters = new Set<() => void>();
  const env = { PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_OFFLINE: "1", PI_MODEL_DELIVERY_TIMEZONE: "null", PI_THREAD_ROLE: "kena", PI_THREAD_MANAGER: "0", PI_SESSION_FILE: join(cwd, "native.jsonl"), PI_SESSION_WRITER_DIRECTORY: cwd, PI_SESSION_WRITER_SCOPE: `test:${id}` };
  const sink = { publish(event: PiEvent) { events.push(event); for (const notify of waiters) notify(); } };
  const adapter = await openPiSession({ cwd, args: [], env, threadId: id, sessionFile: join(cwd, "native.jsonl") }, event => sink.publish(event), () => {});
  const native = captured.session, inbox = captured.inbox, execution = captured.execution, output = captured.output, settle = captured.settle;
  const model = native.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
  native.agent.state.model = model; vi.spyOn(native.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, stopReason,
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const reply = (result: AssistantMessage) => { const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: result.stopReason as "stop" | "toolUse", message: result }); stream.end(); return stream; };
  native.agent.streamFunction = () => reply(message([], "stop"));
  const original = adapter.command;
  const predecessor: PiSession["command"] = async command => {
    if (command.type === "recover_final_result") { output({ type: "response", id: command.id, command: command.type, success: false, error: "Unknown command" }); return; }
    return original.call(adapter, command);
  };
  adapter.command = predecessor;
  const runtime = { session: native };
  const target: ResidentFinalResultTarget = { threadId: id, adapter, sink, runtime, inbox, execution, environmentScope: piEnvironmentScope, env, output, settle,
    expected: { command: predecessor, publish: sink.publish, resume: inbox.resume, session: native,
      sessionId: native.sessionManager.getHeader().id, sessionFile: native.sessionManager.getSessionFile()! } };
  const approved = { command: [nativeMethodHash(predecessor)], publish: [nativeMethodHash(sink.publish)], resume: [nativeMethodHash(inbox.resume)] };
  const waitFor = (predicate: (event: PiEvent) => boolean): Promise<PiEvent> => new Promise(resolve => {
    const notify = () => { const event = events.find(predicate); if (event) { waiters.delete(notify); resolve(event); } };
    waiters.add(notify); notify();
  });
  let sequence = 0;
  const command = async (type: string, fields = {}) => { const id = `command:${++sequence}`; await adapter.command({ type, id, ...fields }); return waitFor(event => event.type === "response" && event.id === id); };
  cleanups.push(async () => { await adapter.command({ type: "abort", id: "cleanup" }); await adapter.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, adapter, native, target, approved, events, waitFor, command, message, reply };
}

it("adopts a live native adapter without replacing its session, work, tools or original effect", async () => {
  const f = await fixture("retained-native"), final = createAssistantMessageEventStream(), effect = join(f.cwd, "effect.txt");
  let calls = 0;
  f.native.agent.streamFunction = () => {
    calls++;
    if (calls === 2) return final;
    return f.reply(f.message(calls === 1 ? [{ type: "toolCall", id: "original-effect", name: "bash", arguments: { command: `printf x >> ${effect}`, timeout: 1 } }]
      : [{ type: "text", text: "Finished" }], calls === 1 ? "toolUse" : "stop"));
  };
  await f.command("input_batch", { batchId: "original-batch", inputs: [{ workId: "original-work", message: "Work" }] });
  await f.waitFor(event => event.type === "message_end" && (event.message as any)?.role === "toolResult");
  const manager = f.native.sessionManager, before = readFileSync(manager.getSessionFile(), "utf8"), close = f.adapter.close;
  expect(adoptResidentFinalResultRecovery([f.target], f.approved)).toMatchObject({ ok: true });
  expect(readFileSync(manager.getSessionFile(), "utf8")).toBe(before);
  expect(f.target.runtime.session).toBe(f.native); expect(f.native.sessionManager).toBe(manager); expect(f.adapter.close).toBe(close);
  expect(f.target.inbox.resume).toBe(f.target.expected.resume);
  expect(await f.command("recover_final_result", { workIds: ["original-work"] })).toMatchObject({ success: false });
  expect(manager.getBranch().some((entry: any) => entry.customType === "thread_final_result_recovery")).toBe(false);
  final.push({ type: "done", reason: "stop", message: f.message([], "stop") }); final.end();
  await f.waitFor(event => event.type === "agent_settled");
  const recovery = await f.command("recover_final_result", { workIds: ["original-work"] });
  expect(recovery).toMatchObject({ success: true });
  await f.waitFor(event => event.type === "agent_settled" && (event.lastAssistantMessage as any)?.content?.[0]?.text === "Finished");
  expect(calls).toBe(3); expect(readFileSync(effect, "utf8")).toBe("x");
  expect(await f.command("get_state")).toMatchObject({ data: { finalResultRecoveryProtocol: "final-result-recovery-v1", completedWorkIds: ["original-work"], finalResultRecoveryAdoption: { state: "covered" } } });
  expect(manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "thread_input_batch_accepted")).toHaveLength(1);
  await f.adapter.command({ type: "recover_final_result", id: String(recovery.id), workIds: ["original-work"] });
  expect(f.events.at(-1)).toMatchObject({ success: true, data: { alreadyAccepted: true } });
  expect(await f.command("recover_final_result", { workIds: ["original-work"] })).toMatchObject({ success: false, error: expect.stringContaining("already attempted") });
  expect(calls).toBe(3);
  expect(f.target.inbox.resume).toBe(f.target.expected.resume);
}, 5000);

it("preflights the entire cohort before changing any resident and preserves idempotent adoption", async () => {
  const a = await fixture("first"), b = await fixture("second");
  const invalid = { ...b.target, expected: { ...b.target.expected, sessionId: "wrong" } };
  expect(adoptResidentFinalResultRecovery([a.target, invalid], a.approved)).toMatchObject({ ok: false });
  expect(a.adapter.command).toBe(a.target.expected.command); expect(a.target.sink.publish).toBe(a.target.expected.publish);
  expect(adoptResidentFinalResultRecovery([a.target, { ...b.target, inbox: undefined } as any], a.approved)).toMatchObject({ ok: false, error: { code: "resident-contract-invalid" } });
  expect(a.adapter.command).toBe(a.target.expected.command);
  expect(adoptResidentFinalResultRecovery([a.target, b.target], { ...a.approved, resume: [] })).toMatchObject({ ok: false, error: { code: "resident-source-conflict" } });
  expect(a.adapter.command).toBe(a.target.expected.command);
  expect(adoptResidentFinalResultRecovery([a.target, b.target], a.approved)).toMatchObject({ ok: true });
  const command = a.adapter.command;
  expect(adoptResidentFinalResultRecovery([a.target, b.target], a.approved)).toMatchObject({ ok: true }); expect(a.adapter.command).toBe(command);
}, 5000);

it.each(["new_session", "switch_session", "fork"])("persists %s replacement receipts and revokes stale resident coverage", async type => {
  const f = await fixture(`replacement-${type}`);
  f.native.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Fork point" }], timestamp: Date.now() });
  await f.command("input_batch", { batchId: "before-replace", inputs: [{ workId: "original-work", message: "Work" }] });
  await f.waitFor(event => event.type === "agent_settled");
  const sourcePath = f.native.sessionManager.getSessionFile(), switchPath = join(f.cwd, "switch.jsonl");
  seedPiSession(switchPath, f.cwd);
  const entry = f.native.sessionManager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user");
  const fields = type === "switch_session" ? { sessionPath: switchPath } : type === "fork" ? { entryId: entry.id } : {};
  expect(adoptResidentFinalResultRecovery([f.target], f.approved)).toMatchObject({ ok: true });
  const replacement = await f.command(type, fields);
  expect(replacement).toMatchObject({ success: true });
  f.target.runtime.session = captured.session;
  const records = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const path of [sourcePath, captured.session.sessionManager.getSessionFile()]) {
    expect(records(path).some(entry => entry.customType === "thread_command_result" && entry.data.id === replacement.id && entry.data.response.success === true)).toBe(true);
  }
  await f.adapter.command({ type, id: String(replacement.id), ...fields });
  expect(f.events.at(-1)).toMatchObject({ success: true });
  const before = readFileSync(captured.session.sessionManager.getSessionFile(), "utf8");
  expect(await f.command("get_state")).toMatchObject({ data: { finalResultRecoveryAdoption: { state: "unsupported" } } });
  expect((await f.command("get_state")).data).not.toHaveProperty("finalResultRecoveryProtocol");
  expect(await f.command("recover_final_result", { workIds: ["original-work"] })).toMatchObject({ success: false, error: expect.stringContaining("not adopted") });
  expect(readFileSync(captured.session.sessionManager.getSessionFile(), "utf8")).toBe(before);
}, 5000);
