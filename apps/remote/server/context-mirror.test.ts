import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextMirror from "./context-mirror";
import { applyContextSplice, sha256 } from "./sync";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>;

const captures: Array<{ capturedAt: number; context: Record<string, unknown>; replacement?: string }> = [];
let document = "";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as any;
    if (request.method === "PATCH") document = applyContextSplice(document, body.splice);
    else document = JSON.stringify(body.context);
    captures.push({ capturedAt: body.capturedAt, context: JSON.parse(document), replacement: body.replacement });
    return Response.json({ ok: true, hash: sha256(document) });
  },
});
const previousSessionId = process.env.PI_REMOTE_SESSION_ID;
const previousServer = process.env.PI_REMOTE_SERVER_URL;

beforeAll(() => {
  process.env.PI_REMOTE_SESSION_ID = "00000000-0000-0000-0000-000000000001";
  process.env.PI_REMOTE_SERVER_URL = server.url.origin;
});

afterAll(() => {
  if (previousSessionId === undefined) delete process.env.PI_REMOTE_SESSION_ID;
  else process.env.PI_REMOTE_SESSION_ID = previousSessionId;
  if (previousServer === undefined) delete process.env.PI_REMOTE_SERVER_URL;
  else process.env.PI_REMOTE_SERVER_URL = previousServer;
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
  test("publishes Pi's final generic context and updates the streaming assistant in place", async () => {
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
    const updateHandler = handlers.get("message_update");
    const endHandler = handlers.get("message_end");
    expect(contextHandler).toBeDefined();
    expect(updateHandler).toBeDefined();
    expect(endHandler).toBeDefined();

    await contextHandler?.({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
    }, { getSystemPrompt: () => "System with AGENTS.md" });
    expect(captures.at(-1)?.context).toMatchObject({
      systemPrompt: "System with AGENTS.md",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });

    await updateHandler?.({ type: "message_update", message: assistant("Working") }, {});
    await Bun.sleep(1_050);
    expect((captures.at(-1)?.context.messages as Array<{ content: Array<{ text: string }> }>).at(-1)?.content[0].text).toBe("Working");

    await endHandler?.({ type: "message_end", message: assistant("Finished", "stop") }, {});
    const messages = captures.at(-1)?.context.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.at(-1)?.content[0].text).toBe("Finished");
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
