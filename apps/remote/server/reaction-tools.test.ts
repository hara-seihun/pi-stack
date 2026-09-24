import { afterAll, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReactionTools } from "./reaction-tools";

const received: unknown[] = [];
let status = 200;
const server = Bun.serve({ port: 0, async fetch(request) {
  received.push({ path: new URL(request.url).pathname, body: await request.json() });
  return Response.json(status === 200
    ? { ok: true, reactions: [{ emoji: "✅", sender: { id: "assistant" }, timestamp: 42 }] }
    : { ok: false, error: { code: "NOT_FOUND", message: "Message was not found" } }, { status });
} });
const previousSession = process.env.PI_REMOTE_SESSION_ID;
const previousServer = process.env.PI_REMOTE_SERVER_URL;
afterAll(() => {
  if (previousSession === undefined) delete process.env.PI_REMOTE_SESSION_ID;
  else process.env.PI_REMOTE_SESSION_ID = previousSession;
  if (previousServer === undefined) delete process.env.PI_REMOTE_SERVER_URL;
  else process.env.PI_REMOTE_SERVER_URL = previousServer;
  server.stop(true);
});

test("message_react returns server receipts and actionable errors", async () => {
  process.env.PI_REMOTE_SESSION_ID = "thread-1";
  process.env.PI_REMOTE_SERVER_URL = server.url.origin;
  const tools: any[] = [];
  registerReactionTools({ registerTool(tool: unknown) { tools.push(tool); } } as ExtensionAPI);
  expect(tools.map(tool => tool.name)).toEqual(["message_react"]);
  const success = await tools[0].execute("call", { messageId: "pi/thread-1/native-id", emoji: "✅" });
  expect(success.details).toMatchObject({ ok: true, reactions: [{ emoji: "✅" }] });
  expect(received[0]).toEqual({ path: "/v1/sessions/thread-1/reactions", body: { messageId: "pi/thread-1/native-id", emoji: "✅" } });
  status = 404;
  const failure = await tools[0].execute("call", { messageId: "pi/thread-1/missing", emoji: "✅", remove: true });
  expect(failure.details).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Message was not found" } });
  expect(failure.content[0].text).toContain("NOT_FOUND");
});
