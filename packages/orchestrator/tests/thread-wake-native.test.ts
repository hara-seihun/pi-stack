import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ThreadService } from "../src/threads/service.js";
import { openPiSession } from "../src/threads/pi-session.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { admissionFor, callerResolver, threadCapability } from "../src/threads/caller.js";
import { WatchList } from "../src/threads/watch-list.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Result, Thread } from "../src/threads/contracts.js";

const native = vi.hoisted(() => ({ prepare: undefined as ((session: AgentSession) => void) | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async original => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, createAgentSessionFromServices: async (...args: Parameters<typeof sdk.createAgentSessionFromServices>) => {
    const result = await sdk.createAgentSessionFromServices(...args); native.prepare?.(result.session); return result;
  } };
});
const unwrap = <T>(value: Result<T>): T => { if (!value.ok) throw new Error(value.error.message); return value.value; };
const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { const deadline = performance.now() + 3000; while (performance.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Native lifecycle did not reach boundary"); }

it.each(["refused", "accepted", "clear", "ordinary"] as const)("real retained legacy-tool %s ends only through the correct native boundary and settles once", async mode => {
  const root = mkdtempSync(join(tmpdir(), "wait-legacy-native-"));
  let modelCalls = 0;
  const owner = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"),
    environment: () => ({ PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" }),
    openSession: (options, output, exit) => openPiSession({ ...options, args: [] }, output, exit),
  });
  native.prepare = session => {
    session.agent.state.model = session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    session.agent.streamFunction = () => {
      modelCalls++;
      const wait = session.agent.state.tools.find(tool => tool.name === "thread_wait")!;
      wait.parameters = Type.Union([
        Type.Object({ action: Type.Literal("set"), reason: Type.String(), threadIds: Type.Optional(Type.Array(Type.String())) }),
        Type.Object({ action: Type.Literal("clear") }),
      ]);
      const call = modelCalls === 1 && mode !== "ordinary";
      const arguments_: Record<string, string | string[]> = mode === "accepted" ? { action: "set", reason: "actual child", threadIds: ["dependency"] }
        : mode === "clear" ? { action: "clear" } : { action: "set", reason: "finished, available" };
      const model = session.agent.state.model;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: call ? [{ type: "toolCall", id: "legacy-call", name: "thread_wait", arguments: arguments_ }] : [{ type: "text", text: "Ordinary final result" }],
        stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); return stream;
    };
  };
  try {
    unwrap(await owner.spawn({ requestId: "parent", id: "parent", cwd: root }));
    const self = unwrap(await owner.spawn({ requestId: "self", id: "self", ...(mode === "accepted" ? {} : { parentId: "parent", ephemeral: true }), cwd: root, message: "work", settings: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "off" } }));
    if (mode === "accepted") unwrap(await owner.spawn({ requestId: "dependency", id: "dependency", parentId: "self", cwd: root }));
    unwrap(await owner.control({ action: "stop", threadId: "parent", descendants: false }));
    unwrap(await owner.start());
    await until(() => !!owner.latestSettlement("self"));
    const settlement = owner.latestSettlement("self")!;
    expect(settlement).toMatchObject({ outcome: "complete" });
    expect(modelCalls).toBe(mode === "accepted" || mode === "ordinary" ? 1 : 2);
    expect(owner.pending("parent")).toHaveLength(mode === "accepted" ? 0 : 1);
    if (mode === "accepted") {
      expect(owner.get("self")?.waitingOnAgents).toMatchObject({ kind: "agents", threadIds: ["dependency"] });
      expect(owner.get("self")?.metadata?.archived).not.toBe(true);
    } else {
      expect(owner.get("self")?.waitingOnAgents).toBeUndefined();
      expect(owner.get("self")?.metadata?.archived).toBe(true);
      expect(readFileSync(self.sessionFile, "utf8")).toContain("Ordinary final result");
    }
    if (mode === "refused") expect(readFileSync(self.sessionFile, "utf8")).toContain("no waiting status was recorded");
    owner.reconcile(); await boundary();
    expect(owner.latestSettlement("self")).toEqual(settlement); expect(owner.pending("parent")).toHaveLength(mode === "accepted" ? 0 : 1);
  } finally {
    native.prepare = undefined; await owner.detach(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("real native end-turn, same-thread restart wake and shared browser/Android status cross authenticated HTTP", async () => {
  const { projectThreadActivity } = await import("../../../apps/remote/server/live-projection.ts" as string);
  const { threadStatus } = await import("../../../apps/remote/web/src/features/status/thread-status.ts" as string);
  const { StatusPill } = await import("../../../apps/remote/web/src/features/status/StatusPill.tsx" as string);
  vi.stubGlobal("React", React);
  const root = mkdtempSync(join(tmpdir(), "wake-native-"));
  const capability = threadCapability(join(root, "key")), foreign = threadCapability(join(root, "foreign-key"));
  const resolver = callerResolver({ capability });
  const transitions: Record<string, unknown>[] = [], rendered: Record<string, string> = {};
  let owner: ThreadService, now = Date.now(), modelCalls = 0, origin = "";
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const statusCss = readFileSync(new URL("../../../apps/remote/web/src/features/status/status.css", import.meta.url), "utf8");
  const statusDocument = (thread: Thread) => {
    const status = threadStatus({ state: thread.state, held: thread.held, waitingOnAgents: thread.waitingOnAgents, ...projectThreadActivity(thread.state, undefined, thread.executionActivity, thread.metadata, thread.held), idleUnread: false, archivedAt: thread.metadata?.archived ? "archived" : null });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Thread wake lifecycle proof</title><style>body{font:18px system-ui;margin:32px}code{display:block;margin-top:24px;white-space:pre-wrap}${statusCss}</style></head><body>${renderToStaticMarkup(React.createElement(StatusPill, { status }))}<code>${JSON.stringify({ threadId: thread.id, waitingOnAgents: thread.waitingOnAgents, wakeSchedule: thread.wakeSchedule }).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code></body></html>`;
  };
  const server = createServer(async (request, response) => {
    try {
    if (request.url === "/ui") { response.setHeader("content-type", "text/html"); response.end(statusDocument(owner.get("self")!)); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    const req = new Request(`${origin}${request.url}`, { method: request.method, headers, body });
    const result = (await threadHttp(owner, req, "/v1/threads", admissionFor(resolver, { headers })))!;
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = createThreadClient(`${origin}/v1/threads`, fetch, { token: capability.issue("self"), timeoutMs: 3000 });
  const createOwner = () => new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), capability,
    environment: () => ({ PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_THREAD_API_URL: `${origin}/v1/threads` }),
    openSession: (options, output, exit) => openPiSession({ ...options, threads: undefined, args: [] }, output, exit),
  });
  const observe = async (name: string) => {
    const thread = unwrap(await client.list({ id: "self" })).threads[0]!;
    transitions.push({ name, thread, modelCalls });
    rendered[name] = await (await fetch(`${origin}/ui`)).text(); return thread;
  };
  native.prepare = session => {
    session.agent.state.model = session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    session.agent.streamFunction = () => {
      modelCalls++;
      const model = session.agent.state.model;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: now,
        content: modelCalls === 1 ? [{ type: "toolCall", id: "wait-call", name: "thread_wait", arguments: { action: "set", kind: "job", jobId: "synthetic-job", reason: "Await synthetic durable job" } }] : [{ type: "text", text: "Wake received in original conversation" }],
        stopReason: modelCalls === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: modelCalls === 1 ? "toolUse" : "stop", message }); stream.end(); return stream;
    };
  };
  owner = createOwner();
  const watch = new WatchList({ databasePath: join(root, "threads.sqlite"), threads: owner, placement: () => ({ ok: true, value: { cwd: root } }), intervalMs: 14400000, onError: () => {} });
  owner.setWatchList(watch);
  try {
    const created = unwrap(await owner.spawn({ requestId: "self", id: "self", cwd: root, settings: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "off" } }));
    unwrap(await client.wakeSchedule({ action: "set", threadId: "self", requestId: "timer", reason: "Recovery check", cadenceMs: 60000, nextDueAt: now + 60000 }));
    unwrap(await owner.start()); unwrap(await owner.send({ requestId: "first-turn", threadId: "self", text: "Wait for the durable job" }));
    await until(() => owner.get("self")?.state === "idle" && !!owner.get("self")?.waitingOnAgents).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(owner.get("self"))}; calls=${modelCalls}`); });
    const waiting = await observe("waiting"); expect(waiting.sessionFile).toBe(created.sessionFile); expect(rendered.waiting).toContain("Waiting for job"); expect(modelCalls).toBe(1);
    owner.reconcile(); unwrap(await watch.tick(now)); await boundary(); expect(modelCalls).toBe(1); expect(unwrap(await watch.watch({ threadId: "self", action: "list" }))).toEqual({ items: [] });
    // Native history and the wake survive replacing the scheduler/controller connection.
    unwrap(await owner.detach()); owner = createOwner(); now += 60001; unwrap(await owner.start());
    await until(() => modelCalls === 2 && owner.get("self")?.state === "idle");
    const woke = await observe("woke"); expect(woke.id).toBe("self"); expect(woke.sessionFile).toBe(created.sessionFile); expect(woke.waitingOnAgents).toBeUndefined();
    expect(woke.wakeSchedule).toMatchObject({ cadenceMs: 60000, lastDueAt: now - 1, lastDeliveredAt: now, nextDueAt: now + 60000 });
    expect(woke.wakeSchedule?.lastLandedAt).toBeDefined(); expect(unwrap(await client.list()).threads).toHaveLength(1);
    expect(rendered.woke).toContain("Idle"); expect(readFileSync(created.sessionFile, "utf8")).toContain("Wake received in original conversation");
    owner.reconcile(); await boundary(); expect(modelCalls).toBe(2);
    unwrap(await owner.control({ action: "stop", threadId: "self", descendants: false })); now += 120000; owner.reconcile(); await boundary();
    expect((await observe("stopped")).wakeSchedule?.deferredReason).toBe("stopped"); expect(modelCalls).toBe(2); expect(rendered.stopped).toContain("Stopped");
    unwrap(await owner.control({ action: "update", threadId: "self", archived: true })); owner.reconcile(); await boundary();
    expect((await observe("archived")).wakeSchedule?.deferredReason).toBe("archived"); expect(rendered.archived).toContain("Archived"); expect(modelCalls).toBe(2);
    const denied = createThreadClient(`${origin}/v1/threads`, fetch, { token: foreign.issue("self"), timeoutMs: 3000 }); expect((await denied.wakeSchedule({ action: "list", threadId: "self" })).ok).toBe(false);
    unwrap(await client.wakeSchedule({ action: "cancel", threadId: "self", requestId: "cancel" })); expect((await observe("cancelled")).wakeSchedule).toBeUndefined();
    unwrap(await owner.control({ action: "restore", threadId: "self", descendants: false, resume: true })); owner.reconcile(); await boundary(); expect(modelCalls).toBe(2);
    const proofRoot = process.env.PI_THREAD_WAKE_PROOF_DIR;
    if (proofRoot) { mkdirSync(resolve(proofRoot), { recursive: true }); writeFileSync(join(proofRoot, "native-http-lifecycle.json"), JSON.stringify({ proof: "ThreadService + real native Pi + authenticated loopback HTTP + shared StatusPill server render", watchIntervalMs: 14400000, modelCalls, transitions }, null, 2)); for (const [name, html] of Object.entries(rendered)) writeFileSync(join(proofRoot, `${name}.html`), html); }
  } finally {
    native.prepare = undefined; await watch.close(); await owner.detach(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
  }
}, 15000);
