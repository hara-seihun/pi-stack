import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextMirror from "./context-mirror";
import { applyContextSplice, messageFinalizationKey, sha256 } from "./sync";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>;

const captures: Array<{
  capturedAt: number;
  context: Record<string, unknown>;
  replacement?: string;
  finalizesMessage?: string;
}> = [];
let document = "";
const requests: Array<{ method: string; bytes: number }> = [];
let failNextCapture = false;
let supersedeNextCapture = false;
let supersedingCaptureTime = 0;
let captureStarted: (() => void) | undefined;
let blockedCapture: Promise<void> | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const encoded = await request.text();
    requests.push({ method: request.method, bytes: Buffer.byteLength(encoded) });
    const body = JSON.parse(encoded);
    if (request.method === "PATCH") {
      if (sha256(document) !== body.splice.targetHash) {
        if (sha256(document) !== body.splice.baseHash) return new Response("Context base changed", { status: 409 });
        document = applyContextSplice(document, body.splice);
      }
    } else document = JSON.stringify(body.context);
    captures.push({
      capturedAt: body.capturedAt,
      context: JSON.parse(document),
      replacement: body.replacement,
      finalizesMessage: body.finalizesMessage,
    });
    if (supersedeNextCapture) {
      supersedeNextCapture = false;
      document = JSON.stringify({ systemPrompt: "Newer capture", tools: [], messages: [] });
      supersedingCaptureTime = body.capturedAt + 60_000;
      return Response.json({ ok: true, capturedAt: supersedingCaptureTime, hash: sha256(document) });
    }
    if (failNextCapture) {
      failNextCapture = false;
      captureStarted?.();
      await blockedCapture;
      return Response.json({ ok: true, hash: "wrong acknowledgement" });
    }
    return Response.json({ ok: true, hash: sha256(document) });
  },
});
const previousSessionId = process.env.PI_REMOTE_SESSION_ID;
const previousServer = process.env.PI_REMOTE_SERVER_URL;
const previousOwner = process.env.PI_REMOTE_CONTEXT_OWNER_PID;

beforeAll(() => {
  process.env.PI_REMOTE_SESSION_ID = "00000000-0000-0000-0000-000000000001";
  process.env.PI_REMOTE_SERVER_URL = server.url.origin;
  delete process.env.PI_REMOTE_CONTEXT_OWNER_PID;
});

afterAll(() => {
  if (previousSessionId === undefined) delete process.env.PI_REMOTE_SESSION_ID;
  else process.env.PI_REMOTE_SESSION_ID = previousSessionId;
  if (previousServer === undefined) delete process.env.PI_REMOTE_SERVER_URL;
  else process.env.PI_REMOTE_SERVER_URL = previousServer;
  if (previousOwner === undefined) delete process.env.PI_REMOTE_CONTEXT_OWNER_PID;
  else process.env.PI_REMOTE_CONTEXT_OWNER_PID = previousOwner;
  server.stop(true);
});

function assistant(text: string, stopReason = "pending") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 2,
  };
}

describe("context mirror", () => {
  test("diagnostic and nested sessions cannot overwrite the parent thread", async () => {
    captures.length = 0;
    const handlers = new Map<string, Handler>();
    const pi = {
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { throw new Error("unowned session inspected tools"); },
    } as unknown as ExtensionAPI;
    contextMirror(pi);
    for (const mode of ["print", "json", "tui"]) {
      const context = { mode, sessionManager: { getBranch: () => [] } };
      await handlers.get("session_start")?.({}, context);
      await handlers.get("context")?.({ messages: [] }, context);
      await handlers.get("message_end")?.({ message: assistant("diagnostic output", "stop") }, context);
      await handlers.get("session_shutdown")?.({}, context);
    }
    expect(captures).toHaveLength(0);
    expect(process.env.PI_REMOTE_CONTEXT_OWNER_PID).toBeUndefined();

    process.env.PI_REMOTE_CONTEXT_OWNER_PID = String(process.pid + 1);
    try {
      handlers.clear();
      contextMirror(pi);
      expect([...handlers.keys()]).toEqual(["before_agent_start"]);
    } finally {
      delete process.env.PI_REMOTE_CONTEXT_OWNER_PID;
    }
  });

  test("publishes Pi's generic context only at durable message boundaries", async () => {
    captures.length = 0;
    document = "";
    const handlers = new Map<string, Handler>();
    const pi = {
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return ["read"]; },
      getAllTools() {
        return [
          { name: "read", description: "Read a file", parameters: { type: "object" }, sourceInfo: {} },
          { name: "write", description: "Write a file", parameters: { type: "object" }, sourceInfo: {} },
        ];
      },
    } as unknown as ExtensionAPI;
    contextMirror(pi);

    const contextHandler = handlers.get("context");
    const endHandler = handlers.get("message_end");
    expect(contextHandler).toBeDefined();
    expect(handlers.get("message_update")).toBeUndefined();
    expect(endHandler).toBeDefined();

    await contextHandler?.({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
    }, { mode: "rpc", getSystemPrompt: () => "System with AGENTS.md" });
    expect(process.env.PI_REMOTE_CONTEXT_OWNER_PID).toBe(String(process.pid));
    expect(captures.at(-1)?.context).toMatchObject({
      systemPrompt: "System with AGENTS.md",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });

    const captureCount = captures.length;
    await endHandler?.({ type: "message_end", message: assistant("Finished", "stop") }, {});
    expect(captures).toHaveLength(captureCount + 1);
    const messages = captures.at(-1)?.context.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.at(-1)?.content[0].text).toBe("Finished");
    expect(captures.at(-1)?.finalizesMessage).toBe(messageFinalizationKey(assistant("Finished", "stop")));
  });

  test("mirrors canonical identity while only the model sees the address label", async () => {
    captures.length = 0;
    document = "";
    const handlers = new Map<string, Handler>();
    contextMirror({
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return []; },
      getAllTools() { return []; },
    } as unknown as ExtensionAPI);
    const message = { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.parse("2026-09-23T11:59:59.000Z") };
    const branch = [{ type: "message", id: "native-user", parentId: null, timestamp: "2026-09-23T12:00:00.000Z", message }];
    const ctx = { mode: "rpc", getSystemPrompt: () => "System", sessionManager: { getBranch: () => branch } };
    const result = await handlers.get("context")?.({ messages: [message] }, ctx) as { messages: any[] };
    expect(result.messages[0].content[0].text).toContain('Message ID: "pi/00000000-0000-0000-0000-000000000001/native-user"');
    expect(result.messages[0].content[0].text).toContain("system time: 2026-09-23T11:59:59.000Z");
    const mirrored = (captures.at(-1)?.context.messages as any[])[0];
    expect(mirrored.content[0].text).toBe("Hello");
    expect(mirrored.identity.id).toBe("pi/00000000-0000-0000-0000-000000000001/native-user");
    expect(message.content[0].text).toBe("Hello");
  });

  test("assigns the assistant native entry ID after Pi persists the finalized response", async () => {
    captures.length = 0;
    document = "";
    const handlers = new Map<string, Handler>();
    contextMirror({
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return []; },
      getAllTools() { return []; },
    } as unknown as ExtensionAPI);
    const branch: any[] = [{ type: "message", id: "user-entry", parentId: null, timestamp: "2026-09-23T12:00:00.000Z", message: { role: "user", content: "Hello", timestamp: 111 } }];
    const ctx = { mode: "rpc", getSystemPrompt: () => "System", sessionManager: { getBranch: () => branch } };
    await handlers.get("context")?.({ messages: [branch[0].message] }, ctx);
    const answer = assistant("Done", "stop");
    await handlers.get("message_end")?.({ message: answer }, ctx);
    expect((captures.at(-1)?.context.messages as any[]).at(-1).identity).toBeUndefined();
    branch.push({ type: "message", id: "assistant-entry", parentId: "user-entry", timestamp: "2026-09-23T12:00:01.000Z", message: answer });
    await handlers.get("turn_end")?.({}, ctx);
    expect((captures.at(-1)?.context.messages as any[]).at(-1).identity.id).toBe("pi/00000000-0000-0000-0000-000000000001/assistant-entry");
    expect((captures.at(-1)?.context.messages as any[]).at(-1).content[0].text).toBe("Done");
  });

  test("sends small boundary patches, skips unchanged captures, and replaces a lost base", async () => {
    captures.length = 0;
    requests.length = 0;
    document = "";
    const handlers = new Map<string, Handler>();
    contextMirror({
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return []; },
      getAllTools() { return []; },
    } as unknown as ExtensionAPI);
    const context = { mode: "rpc", getSystemPrompt: () => "System" };
    const event = { messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(2 * 1024 * 1024) }], timestamp: 1 }] };
    await handlers.get("context")?.(event, context);
    expect(requests[0].method).toBe("PUT");
    await handlers.get("context")?.(event, context);
    expect(requests).toHaveLength(1);
    await handlers.get("message_end")?.({ message: assistant("An incremental answer", "stop") }, context);
    expect(requests[1].method).toBe("PATCH");
    expect(requests[1].bytes).toBeLessThan(1024);
    expect(captures.at(-1)?.finalizesMessage).toBe(messageFinalizationKey(assistant("An incremental answer", "stop")));

    document = "";
    await handlers.get("message_end")?.({ message: assistant("After the server lost its base", "stop") }, context);
    expect(requests.slice(-2).map((request) => request.method)).toEqual(["PATCH", "PUT"]);
    expect(JSON.parse(document).messages.at(-1).content[0].text).toBe("After the server lost its base");
  });

  test("retries an unacknowledged final capture instead of losing it", async () => {
    captures.length = 0;
    document = "";
    failNextCapture = true;
    let started!: () => void;
    let releaseCapture!: () => void;
    const firstCaptureStarted = new Promise<void>((resolve) => { started = resolve; });
    blockedCapture = new Promise<void>((resolve) => { releaseCapture = resolve; });
    captureStarted = started;
    const handlers = new Map<string, Handler>();
    const pi = {
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return []; },
      getAllTools() { return []; },
    } as unknown as ExtensionAPI;
    contextMirror(pi);

    const publishing = handlers.get("context")?.({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "must survive" }], timestamp: 1 }],
    }, { mode: "rpc", getSystemPrompt: () => "System" }) as Promise<void>;
    await firstCaptureStarted;
    releaseCapture();
    await publishing;

    expect(captures.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(captures.at(-1)?.context)).toContain("must survive");
    captureStarted = undefined;
    blockedCapture = undefined;
  });

  test("a newer acknowledged capture supersedes pending work without retrying or rolling it back", async () => {
    captures.length = 0;
    requests.length = 0;
    document = "";
    const handlers = new Map<string, Handler>();
    contextMirror({
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return []; },
      getAllTools() { return []; },
    } as unknown as ExtensionAPI);
    const ctx = { mode: "rpc", getSystemPrompt: () => "System" };
    const event = { messages: [{ role: "user", content: "Existing history", timestamp: 1 }] };
    await handlers.get("context")?.(event, ctx);
    supersedeNextCapture = true;
    await handlers.get("message_end")?.({ message: assistant("Superseded", "stop") }, ctx);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(document).systemPrompt).toBe("Newer capture");
    await handlers.get("context")?.({ messages: [{ role: "user", content: "Next boundary", timestamp: 2 }] }, ctx);
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)?.method).toBe("PUT");
    expect(captures.at(-1)!.capturedAt).toBeGreaterThan(supersedingCaptureTime);
    expect(JSON.parse(document).messages[0].content).toBe("Next boundary");
  });

  test("replaces the visible document as soon as Pi commits a compaction", async () => {
    captures.length = 0;
    document = "";
    const handlers = new Map<string, Handler>();
    const pi = {
      on(type: string, handler: Handler) { handlers.set(type, handler); },
      getActiveTools() { return []; },
      getAllTools() { return []; },
    } as unknown as ExtensionAPI;
    contextMirror(pi);

    const extensionContext = {
      mode: "rpc",
      getSystemPrompt: () => "Current system prompt",
      sessionManager: {
        getBranch: () => [
          {
            type: "message", id: "old", parentId: null, timestamp: "2026-08-27T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text: "deleted secret" }], timestamp: 1 },
          },
          {
            type: "compaction", id: "compact", parentId: "old", timestamp: "2026-08-27T00:01:00.000Z",
            summary: "Only this summary remains", firstKeptEntryId: "none", tokensBefore: 1_000,
          },
        ],
      },
    };
    await handlers.get("context")?.({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "deleted secret" }], timestamp: 1 }],
    }, extensionContext);
    expect(JSON.stringify(captures.at(-1)?.context)).toContain("deleted secret");

    await handlers.get("session_compact")?.({ type: "session_compact" }, extensionContext);
    const replacement = captures.at(-1);
    expect(replacement?.replacement).toBe("compaction");
    expect(JSON.stringify(replacement?.context)).toContain("Only this summary remains");
    expect(JSON.stringify(replacement?.context)).not.toContain("deleted secret");

    await handlers.get("context")?.({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "deleted secret" }], timestamp: 1 }],
    }, extensionContext);
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, extensionContext);
    expect(JSON.stringify(captures.at(-1)?.context)).toContain("Only this summary remains");
    expect(JSON.stringify(captures.at(-1)?.context)).not.toContain("deleted secret");
  });
});
