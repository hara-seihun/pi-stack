import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingService } from "./messaging/service";
import { ActionStore } from "kenan-memory/actions";
import type { MessagingPlugin } from "./messaging/plugin";
import { parseSignalArgs, runSignalCli, type SignalFetch } from "./signal-cli";
import { callerResolver, threadCapability } from "../../../packages/orchestrator/src/threads/caller";
import { externalActionCaller, externalActionsEndpoint } from "./external-actions";

test("send/react require a chosen stable request ID; parser never invents one", () => {
  for (const args of [["send", "chat", "hello"], ["react", "message", "👍"], ["send", "chat", "hello", "--request-id", "bad/id"], ["read", "chat", "--request-id", "id"], ["read", "chat", "--limit", "101"], ["call", "chat"], ["list", "--user", "bob"]]) expect(parseSignalArgs(args).ok).toBe(false);
  expect(parseSignalArgs(["send", "chat", "-", "--request-id", "durable-id", "--reply-to", "messaging/original", "--attachment", "file"], () => "hello")).toEqual({ ok: true, value: { path: "/v1/agent-signal/conversations/chat/messages", method: "POST", requestId: "durable-id", json: { requestId: "durable-id", text: "hello", attachmentIds: ["file"], replyTo: "messaging/original" } } });
});

test("purpose keys survive the CLI boundary independently of request IDs", () => {
  expect(parseSignalArgs(["send", "chat", "hello", "--request-id", "new-id", "--intent-key", "appointment"])).toMatchObject({ ok: true, value: { json: { intentKey: "appointment" } } });
  expect(parseSignalArgs(["react", "message", "👍", "--request-id", "new-id", "--intent-key", "acknowledge"])).toMatchObject({ ok: true, value: { json: { intentKey: "acknowledge" } } });
});

test("ambiguous transport preserves ID, makes one request, and does not retry", async () => {
  const output: any[] = []; let calls = 0; const observed: { token: string | null } = { token: null };
  const request: SignalFetch = async (_url, init) => { calls++; observed.token = new Headers(init?.headers).get("x-pi-thread-token"); throw new Error("connection lost"); };
  const exit = await runSignalCli(["send", "chat", "hello", "--request-id", "chosen"], { out: v => output.push(v), error: text => output.push(text), help: text => output.push(text) }, request, { PI_REMOTE_SERVER_URL: "http://127.0.0.1:9999", PI_THREAD_TOKEN: "own-capability" });
  expect(exit).toBe(1); expect(calls).toBe(1); expect(observed.token).toBe("own-capability");
  expect(output[0]).toMatchObject({ error: "unconfirmed", requestId: "chosen" });
});

test("CLI send uses the actual durable transport contract and reuses uncertain receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-cli-test-")); let sends = 0;
  const plugin: MessagingPlugin = {
    icon: "signal", capabilities: { attachments: true, groups: true },
    async start(context) { context.status("ready", "ready"); return { ok: true, value: undefined }; },
    async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
    async send(_conversation, message) { sends++; expect(message.text).toBe("hello"); expect(message.attachments).toEqual([]); return { ok: false, error: { code: "unknown", message: "May have delivered" } }; },
    async close() {},
  };
  const actions = new ActionStore(join(root, ".kenan-actions"), "fixture-alice");
  const service = new MessagingService(root, [{ id: "signal", plugin: "signal", label: "Signal" }], async () => plugin, undefined, undefined, { begin: () => null, finish: () => ({ ok: true }) }, actions);
  try {
    await service.start(); const conversation = await service.open("signal", "+15551234567");
    const request: SignalFetch = async (url, init) => await service.handle(new Request(url, init)) ?? new Response(null, { status: 404 });
    const output: any[] = []; const io = { out: (v: unknown) => output.push(v), error: (v: string) => output.push(v), help: (v: string) => output.push(v) };
    const args = ["send", conversation.id, "hello", "--request-id", "chosen"];
    expect(await runSignalCli(args, io, request, {})).toBe(0);
    expect(await runSignalCli(args, io, request, {})).toBe(0);
    expect(sends).toBe(1);
    expect(output[1].message.status).toBe("unknown");
    expect(service.history(conversation.id).messages).toHaveLength(1);
  } finally { await service.close(); actions.close(); rmSync(root, { recursive: true, force: true }); }
});

test("tool origin cannot select a network account, and 202 is not reported as delivery", async () => {
  const output: any[] = []; let calls = 0;
  const request: SignalFetch = async () => { calls++; return Response.json({ message: { status: "sending" } }, { status: 202 }); };
  const io = { out: (v: unknown) => output.push(v), error: (v: string) => output.push(v), help: (v: string) => output.push(v) };
  expect(await runSignalCli(["list"], io, request, { PI_REMOTE_SERVER_URL: "https://remote.example/" })).toBe(1);
  expect(calls).toBe(0);
  expect(await runSignalCli(["send", "chat", "hello", "--request-id", "chosen"], io, request, {})).toBe(0);
  expect(output[1]).toMatchObject({ message: { status: "sending" }, accepted: true, requestId: "chosen" });
});

test("router CLI carries verified worker ownership through Signal delivery and purpose resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-cli-owner-"));
  let sends = 0;
  const plugin: MessagingPlugin = {
    icon: "signal", capabilities: { attachments: true, groups: true },
    async start(context) { context.status("ready", "ready"); return { ok: true, value: undefined }; },
    async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
    async send() { sends++; return { ok: true, value: { externalId: `synthetic-${sends}`, timestamp: Date.now() } }; },
    async close() {},
  };
  const actions = new ActionStore(join(root, ".kenan-actions"), "fixture-alice");
  const service = new MessagingService(root, [{ id: "signal", plugin: "signal", label: "Signal" }], async () => plugin, undefined, undefined, { begin: () => null, finish: () => ({ ok: true }) }, actions);
  const capability = threadCapability(join(root, "capability"));
  const resolver = callerResolver({ capability });
  try {
    await service.start();
    const conversation = await service.open("signal", "+15551234567");
    const request: SignalFetch = async (url, init) => {
      const req = new Request(url, init);
      const caller = resolver.resolve({ headers: req.headers });
      if ("error" in caller || caller.kind !== "thread") return Response.json({ error: "forbidden" }, { status: 403 });
      return await service.handle(req, caller.threadId) ?? new Response(null, { status: 404 });
    };
    const io = { out: (_v: unknown) => {}, error: (_v: string) => {}, help: (_v: string) => {} };
    const args = ["send", conversation.id, "hello", "--request-id", "owned-send"];
    expect(await runSignalCli(args, io, request, { PI_REMOTE_ROUTER_PORT: "8788", PI_THREAD_TOKEN: capability.issue("worker") })).toBe(0);
    const sent = await service.send(conversation.id, { requestId: "owned-send", text: "hello", attachmentIds: [] });
    expect(sent.status).toBe("sent");
    expect(await runSignalCli(args, io, request, { PI_REMOTE_ROUTER_PORT: "8788", PI_THREAD_TOKEN: capability.issue("other-worker") })).toBe(0);
    expect(sends).toBe(1);
    const action = actions.inspect(sent.actionId!);
    if (!action.ok) throw new Error(action.message);
    expect(action.value.submittingThreadId).toBe("worker");
    const req = new Request("http://127.0.0.1/v1/external-actions", { method: "POST", headers: { "x-pi-thread-token": capability.issue("worker") }, body: JSON.stringify({ operation: "reconcile", input: {
      id: action.value.id, expectedRevision: action.value.revision, decision: "resolve-purpose", actor: "forged-operator", evidence: { kind: "operator-observation", reference: "synthetic-conversation", detail: "Synthetic purpose complete" },
    } }) });
    const response = await externalActionsEndpoint(req, actions, externalActionCaller(resolver.resolve({ headers: req.headers }), 1001, "manager", false));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, value: { state: "succeeded", resolved: true } });
    expect(await runSignalCli(["send", conversation.id, "next", "--request-id", "owned-next"], io, request, { PI_THREAD_TOKEN: capability.issue("worker") })).toBe(0);
    expect(sends).toBe(2);
    expect(await runSignalCli(args, io, request, { PI_THREAD_TOKEN: "forged-worker" })).toBe(1);
    expect(sends).toBe(2);
  } finally { await service.close(); actions.close(); rmSync(root, { recursive: true, force: true }); }
});
