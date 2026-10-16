import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../src/core/gateway-transport.js";
import { admissionFor, callerResolver, threadCapability } from "../src/threads/caller.js";
import { ThreadService } from "../src/threads/service.js";
import { threadHttp } from "../src/threads/http.js";
import { threadTools } from "../src/threads/pi-tools.js";

test("actual native peer read/send uses own-UID gateway and original capability, identities and role ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-peer-gateway-")), socketPath = join(root, "core.sock"), capability = threadCapability(join(root, "capability"));
  const owner = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, capability, openSession: async () => { throw new Error("No native/model work in gateway proof"); } });
  const resolver = callerResolver({ capability });
  const observed: { token: string | null; deadline: string | null; url: string }[] = [];
  const gateway = createGatewayServer({ gatewayId: "native-synthetic", purpose: "core-ingress", peerUid: process.getuid!(), principalId: "alice", scopeIds: ["declared:alice"], routeCeiling: [{ method: "POST", kind: "prefix", path: "/v1/scopes/declared:alice/thread-owner/" }] }, async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    observed.push({ token: headers.get("x-pi-thread-token"), deadline: headers.get("x-pi-thread-deadline"), url: request.url! });
    const result = await threadHttp(owner, new Request(`http://synthetic${request.url}`, { method: request.method, headers, body: Buffer.concat(chunks) }), "/v1/scopes/declared%3Aalice/thread-owner", admissionFor(resolver, { headers }));
    response.writeHead(result?.status ?? 404, { "content-type": "application/json" }); response.end(result ? await result.text() : "{}");
  });
  await new Promise<void>(resolve => gateway.server.listen(socketPath, resolve));
  try {
    const sender = await owner.spawn({ id: "sender", title: "Sender", requestId: "create-sender", cwd: root }); if (!sender.ok) throw new Error(sender.error.message);
    const leaf = await owner.spawn({ id: "leaf", title: "Leaf", requestId: "create-leaf", parentId: sender.value.id, cwd: root, createdBy: { kind: "thread", threadId: sender.value.id } }); if (!leaf.ok) throw new Error(leaf.error.message);
    const recipient = await owner.spawn({ id: "recipient", title: "Recipient", requestId: "create-recipient", cwd: root }); if (!recipient.ok) throw new Error(recipient.error.message);
    writeFileSync(recipient.value.sessionFile, [JSON.stringify({ type: "session", version: 3, id: "recipient", timestamp: new Date().toISOString(), cwd: root }), JSON.stringify({ type: "message", id: "original-peer-message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Original peer history" }], timestamp: Date.now() } })].join("\n") + "\n");
    const token = capability.issue("leaf");
    const env = { PI_CORE_URL: "http://synthetic-core.test:19181", PI_CORE_GATEWAY_SOCKET: socketPath, PI_CORE_GATEWAY_UID: String(process.getuid!()), PI_THREAD_API_URL: "http://unreachable-old-callback.test/v1/scopes/declared%3Aalice/thread-owner", PI_THREAD_TOKEN: token };
    const tools = threadTools({ threadId: "leaf", cwd: root, sessionFile: leaf.value.sessionFile, args: [], env });
    const execute = async (name: string, id: string, input: unknown) => tools.find(tool => tool.name === name)!.execute(id, input as never, undefined, undefined, {} as never);
    expect((await execute("thread_list", "list-proof", {})).details).toMatchObject({ ok: true });
    const read = await execute("thread_read", "read-proof", { threadId: "recipient" }); expect(read.details).toMatchObject({ ok: true }); expect(JSON.stringify(read.details)).toContain("Original peer history");
    const input = { threadId: "recipient", text: "Original native send bytes" };
    expect((await execute("thread_send", "original-tool-send", input)).details).toMatchObject({ ok: true, value: { id: "leaf:original-tool-send" } });
    expect((await execute("thread_send", "original-tool-send", input)).details).toMatchObject({ ok: true, value: { id: "leaf:original-tool-send" } });
    expect(owner.pending("recipient").map(message => message.id)).toEqual(["leaf:original-tool-send"]);
    const refused = await execute("thread_spawn", "role-refused", { message: "Cannot create a child of kenatia", cwd: root }); expect(refused.details).toMatchObject({ ok: false }); expect(owner.get("leaf")?.role).toBe("kenatia");
    expect(observed.every(call => call.token === token && Number(call.deadline) > 0)).toBe(true);
    const bad = threadTools({ threadId: "leaf", cwd: root, sessionFile: leaf.value.sessionFile, args: [], env: { ...env, PI_THREAD_TOKEN: "invalid-synthetic-capability" } });
    expect((await bad.find(tool => tool.name === "thread_send")!.execute("bad-call", input, undefined, undefined, {} as never)).details).toMatchObject({ ok: false });
    expect(owner.pending("recipient")).toHaveLength(1);
  } finally { await gateway.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
