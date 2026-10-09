import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createMessageDeliveryProjection, deliveryPrefix, installMessageDelivery, MESSAGE_DELIVERY_RECEIPT, previewMessageDelivery } from "../src/threads/message-delivery.js";
import { writePersonSetting } from "../src/person-settings.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function data(zone: string) {
  const path = mkdtempSync(join(tmpdir(), "message-delivery-")); directories.push(path);
  expect(writePersonSetting(path, "person.timezone", { zone, source: "configured" })).toMatchObject({ ok: true });
  return path;
}
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function text(message: AgentMessage) {
  if (!("content" in message)) throw new Error("Missing content");
  return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("");
}
it("distinguishes both sides of DST folds and exact non-hour offsets", () => {
  expect(value(deliveryPrefix(Date.parse("2026-11-01T05:30:00.123Z"), { state: "configured", zone: "America/New_York" }))).toContain("2026-11-01 01:30:00.123 -04:00 (America/New_York)");
  expect(value(deliveryPrefix(Date.parse("2026-11-01T06:30:00.123Z"), { state: "configured", zone: "America/New_York" }))).toContain("2026-11-01 01:30:00.123 -05:00 (America/New_York)");
  expect(value(deliveryPrefix(Date.parse("2026-01-01T00:00:00Z"), { state: "configured", zone: "Asia/Kathmandu" }))).toContain("05:45:00.000 +05:45");
  expect(deliveryPrefix(1, { state: "configured", zone: "Not/AZone" })).toMatchObject({ ok: false, error: { code: "invalid" } });
});
it("timestamps queued/human/collaborator/scheduled/system/tool messages at delivery, retaining original receipt identity and raw history", () => {
  const manager = SessionManager.inMemory();
  const incoming: Parameters<SessionManager["appendMessage"]>[0][] = [
    { role: "system", content: "system event", sections: { prompt: "trusted" }, timestamp: 1 },
    { role: "user", content: "human queued", timestamp: 2 },
    { role: "user", content: '<agent_message>{"receipt":"unchanged"}</agent_message>', timestamp: 3 },
    { role: "custom", customType: "scheduled", content: "wake", display: true, timestamp: 4 },
    { role: "toolResult", toolCallId: "immutable-call", toolName: "read", isError: false, content: [{ type: "text", text: "tool data" }], timestamp: 5 },
  ];
  const ids = incoming.map(message => manager.appendMessage(message));
  const before = JSON.stringify(manager.getBranch());
  const project = createMessageDeliveryProjection(manager, { PI_REMOTE_DATA: data("Europe/London") }, () => Date.parse("2026-10-08T21:15:16.789Z"));
  const projected = value(project(incoming));
  for (const message of projected) {
    expect(text(message)).toMatch(/^\[Model delivery: 2026-10-08 22:15:16.789 \+01:00 \(Europe\/London\)\]\n/);
    expect(message.timestamp).toBeLessThan(10);
  }
  expect(projected[4]).toMatchObject({ toolCallId: "immutable-call", isError: false });
  expect(JSON.stringify(manager.getBranch().filter(entry => entry.type !== "custom"))).toBe(before);
  const metadata = manager.getBranch().at(-1);
  expect(metadata).toMatchObject({ type: "custom", customType: MESSAGE_DELIVERY_RECEIPT });
  const encoded = JSON.stringify(metadata);
  expect(encoded).not.toContain("human queued"); expect(encoded).not.toContain("tool data");
  ids.forEach(id => expect(encoded).toContain(`entry:${id}`));
  expect(encoded).toContain('"originalTimestamp":2'); expect(encoded).toContain('"source":"configured"');
});
it("reconstructs delivery once on resume, respects new timezone for new messages and never doubles prefixes", () => {
  const manager = SessionManager.inMemory(), path = data("America/New_York");
  const message: AgentMessage = { role: "user", content: "original", timestamp: 1 };
  manager.appendMessage(message);
  const first = value(createMessageDeliveryProjection(manager, { PI_REMOTE_DATA: path }, () => 1000)([message]));
  writePersonSetting(path, "person.timezone", { zone: "Asia/Tokyo", source: "configured" });
  const newer: AgentMessage = { role: "user", content: "new", timestamp: 2 }; manager.appendMessage(newer);
  const resumed = createMessageDeliveryProjection(manager, { PI_REMOTE_DATA: path }, () => 5000);
  const next = value(resumed([message, newer]));
  expect(text(next[0])).toBe(text(first[0])); expect(text(next[1])).toContain("Asia/Tokyo");
  expect(value(resumed(next)).map(text)).toEqual(next.map(text));
  expect(manager.getBranch().filter(entry => entry.type === "custom")).toHaveLength(2);
});
it("preview replays only real delivery stamps without clock/metadata writes or affecting concurrent real delivery", async () => {
  const manager = SessionManager.inMemory();
  const delivered: AgentMessage = { role: "user", content: "already sent", timestamp: 1 };
  const pending: AgentMessage = { role: "user", content: "not yet sent", timestamp: 2 };
  manager.appendMessage(delivered);
  const project = createMessageDeliveryProjection(manager, { PI_MODEL_DELIVERY_TIMEZONE: "null" }, () => 1000);
  const original = value(project([delivered]));
  manager.appendMessage(pending);
  const before = JSON.stringify(manager.getBranch()), leaf = manager.getLeafId();
  const previewProject = createMessageDeliveryProjection(manager, {}, () => { throw new Error("Inspection must not sample delivery time"); });
  let resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  const preview = previewMessageDelivery(async () => {
    const projected = value(previewProject([delivered, pending]));
    expect(text(projected[0])).toBe(text(original[0]));
    expect(projected[1]).toBe(pending);
    expect(JSON.stringify(manager.getBranch())).toBe(before);
    expect(manager.getLeafId()).toBe(leaf);
    await pause;
  });
  const actual = value(project([pending]));
  expect(text(actual[0])).toMatch(/^\[Model delivery:/);
  expect(manager.getBranch().filter(entry => entry.type === "custom")).toHaveLength(2);
  resume(); await preview;
});
it("unknown zones are labeled honestly and invalid/unavailable settings refuse delivery without storing a receipt", () => {
  const manager = SessionManager.inMemory();
  const message: AgentMessage = { role: "user", content: "input", timestamp: 1 }; manager.appendMessage(message);
  expect(text(value(createMessageDeliveryProjection(manager, { TZ: "Europe/London", PI_MODEL_DELIVERY_TIMEZONE: "null" }, () => 1000)([message]))[0])).toContain("UTC +00:00; timezone-unconfigured");
  const path = data("Europe/London"); writeFileSync(join(path, "settings.json"), "corrupt");
  const initial = manager.getBranch().length;
  expect(createMessageDeliveryProjection(manager, { PI_PERSON_SETTINGS_DATA: path }, () => 2000)([message])).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(manager.getBranch()).toHaveLength(initial);
});
it("common final adapter prefixes converted compaction/custom/bash before native labels and installs only once", async () => {
  const manager = SessionManager.inMemory();
  const messages: AgentMessage[] = [
    { role: "system", content: "approved callee boundary", timestamp: 1 },
    { role: "compactionSummary", summary: "retained raw summary", tokensBefore: 100, timestamp: 2 },
    { role: "custom", customType: "event", content: "EXTERNAL callee", display: false, timestamp: 3 },
    { role: "bashExecution", command: "printf x", output: "x", cancelled: false, truncated: false, exitCode: 0, timestamp: 4 },
  ];
  let conversions = 0;
  const session = { sessionManager: manager, agent: { convertToLlm: (input: AgentMessage[]) => { conversions++; return convertToLlm(input); } } } as unknown as Pick<AgentSession, "agent" | "sessionManager">;
  installMessageDelivery(session, { PI_MODEL_DELIVERY_TIMEZONE: "null" }); installMessageDelivery(session, { PI_MODEL_DELIVERY_TIMEZONE: "null" });
  const result = await session.agent.convertToLlm(messages);
  expect(conversions).toBe(1);
  for (const message of result) expect(text(message)).toMatch(/^\[Model delivery:/);
  expect(text(result[0])).toContain("approved callee boundary");
  expect(text(result[2])).toContain("EXTERNAL callee");
  expect(messages[1]).toMatchObject({ summary: "retained raw summary" });
});
it("native checkpoint substitution survives final delivery projection across resume and converted content", async () => {
  const runtimeDirectory = "../../runtime/extensions/codex-compaction/";
  const { checkpointContext } = await import(runtimeDirectory + "index.mjs");
  const { replaceMarker } = await import(runtimeDirectory + "native.mjs");
  const { buildSessionContext } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "retained input", timestamp: 1 });
  const encrypted = { type: "compaction", encrypted_content: "fixture-checkpoint" };
  const id = manager.appendCompaction("native summary", first, 100, {
    kind: "openai-codex-native-compaction", version: 2,
    modelKey: "openai-codex-responses:gpt-6.1-sol", replacementHistory: [encrypted],
  });
  manager.appendMessage({ role: "user", content: "new queued input", timestamp: 2 });
  const context = value<{ messages: AgentMessage[] }>(checkpointContext(buildSessionContext(manager.getBranch()).messages,
    manager.getBranch(), { api: "openai-codex-responses", id: "gpt-6.1-sol" }));
  const marker = `Pi Codex checkpoint ${id}`;
  for (const arrayContent of [false, true]) {
    const messages = convertToLlm(context.messages).map(message => message.role === "user" && message.content === marker && arrayContent
      ? { ...message, content: [{ type: "text" as const, text: marker }] } : message);
    const projected = value(createMessageDeliveryProjection(manager, { PI_MODEL_DELIVERY_TIMEZONE: "null" }, () => 1000)(messages));
    expect(text(projected[0])).toBe(marker);
    expect(text(projected.at(-1)!)).toMatch(/^\[Model delivery:/);
    const payload = { input: projected.map(message => ({ role: message.role,
      content: [{ type: "input_text", text: text(message) }] })) };
    const rewritten = value<{ input: unknown[] }>(replaceMarker(payload, marker, [encrypted]));
    expect(rewritten.input[0]).toEqual(encrypted);
    expect(rewritten.input.at(-1)).toMatchObject({ content: [{ text: expect.stringContaining("new queued input") }] });
  }
  const receipts = manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === MESSAGE_DELIVERY_RECEIPT);
  expect(JSON.stringify(receipts)).not.toContain(`entry:${id}:user`);
  const lookalike: AgentMessage = { role: "user", content: marker, timestamp: 123 };
  expect(text(value(createMessageDeliveryProjection(manager, { PI_MODEL_DELIVERY_TIMEZONE: "null" })([lookalike]))[0])).toMatch(/^\[Model delivery:/);
});
it("actual SDK sends current live/queued prefixes but never persists transformed history or changes receipts", async () => {
  const root = data("Europe/London");
  writeFileSync(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fixture-only" } }));
  const manager = SessionManager.inMemory(root);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader,
    sessionManager: manager, model: modelRuntime.getModel("anthropic", "claude-opus-4-6"), tools: [] });
  const requests: AgentMessage[][] = [];
  let firstSeen!: () => void, finishFirst!: () => void;
  const started = new Promise<void>(resolve => { firstSeen = resolve; });
  const finish = new Promise<void>(resolve => { finishFirst = resolve; });
  session.agent.streamFunction = async (model, context) => {
    requests.push(context.messages);
    const stream = createAssistantMessageEventStream();
    const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }], api: model.api,
      provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (requests.length === 1) { firstSeen(); await finish; }
    stream.push({ type: "done", reason: "stop", message: assistant }); stream.end();
    return stream;
  };
  installMessageDelivery(session, { PI_PERSON_SETTINGS_DATA: root });
  try {
    const running = session.prompt("initial raw human");
    await Promise.race([started, running.then(() => { throw new Error(`SDK settled before fake model: ${JSON.stringify(session.messages.at(-1))}`); })]);
    const firstDeliveredAt = Date.now();
    session.steer('<agent_message>{"id":"durable-collaborator-receipt"}</agent_message>');
    finishFirst(); await running;
    expect(requests.length).toBe(2);
    expect(text(requests[0][0])).toMatch(/^\[Model delivery:/);
    const users = requests[1].filter(message => message.role === "user");
    expect(text(users[0])).toBe(text(requests[0].find(message => message.role === "user")!));
    expect(text(users[1])).toMatch(/^\[Model delivery:/);
    expect(text(users[1])).toContain('"id":"durable-collaborator-receipt"');
    const receiptEntries = manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === MESSAGE_DELIVERY_RECEIPT);
    expect(receiptEntries).toHaveLength(2);
    expect((receiptEntries[1] as any).data.receipts[0].deliveredAt).toBeGreaterThanOrEqual(firstDeliveredAt);
    expect(JSON.stringify(manager.getBranch().filter(entry => entry.type === "message"))).not.toContain("Model delivery:");
    expect(session.messages.filter(message => message.role === "user")).toHaveLength(2);
  } finally { session.dispose(); }
}, 5000);
