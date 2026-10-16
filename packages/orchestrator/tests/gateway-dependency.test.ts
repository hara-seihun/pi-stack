import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createServer as httpServer } from "node:http";
import { createServer as netServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as transport from "../src/core/gateway-transport.js";
import { GatewayPeerError, unixGatewayFetch } from "../src/core/gateway-fetch.js";
import { prepareCallbackMessage } from "../src/core/service.js";
import { ThreadService } from "../src/threads/service.js";

const roots: string[] = [], servers: (Server & { closeAllConnections?: () => void })[] = [];
afterEach(async () => { mock.restore(); for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), "gateway-dependency-")); roots.push(root); return join(root, "callback.sock"); }
async function listen(server: Server, socketPath: string) { servers.push(server); await new Promise<void>(resolve => server.listen(socketPath, resolve)); }

test("actual missing callback becomes retryable preparation, then a late verified callback prepares the unchanged request", async () => {
  const socketPath = path(), peer = { socketPath, peerUid: process.getuid!() };
  const service = new ThreadService({ databasePath: join(roots.at(-1)!, "threads.sqlite"), sessionsDir: roots.at(-1)!, capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("Fixture never opens native work"); } });
  const spawned = await service.spawn({ requestId: "synthetic-original", cwd: roots.at(-1)!, message: "Unchanged accepted bytes" }); if (!spawned.ok) throw new Error(spawned.error.message);
  const thread = spawned.value, message = service.pending(thread.id)[0]!;
  const callback = (input: string, init: RequestInit) => unixGatewayFetch(peer, input, init);
  try {
    expect(await prepareCallbackMessage(callback, thread, message)).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true, message: expect.stringContaining("ENOENT") } });
    let received: unknown;
    const server = httpServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); received = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, value: { text: message.text } })); });
    await listen(server, socketPath);
    expect(await prepareCallbackMessage(callback, thread, message)).toEqual({ ok: true, value: { text: "Unchanged accepted bytes" } });
    expect(received).toMatchObject({ thread: { id: thread.id }, message: { id: "synthetic-original", text: "Unchanged accepted bytes" } });
  } finally { await service.close(); }
});

test("peer helper failure retains its typed cause instead of alleging a UID mismatch", async () => {
  const socketPath = path(); const server = netServer(); await listen(server, socketPath);
  spyOn(transport, "kernelPeer").mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Synthetic peer helper timed out" } });
  try { await unixGatewayFetch({ socketPath, peerUid: process.getuid!() }, "http://callback/"); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(GatewayPeerError); expect(error).toMatchObject({ code: "peer-verification-unavailable", verificationError: { code: "unavailable", message: "Synthetic peer helper timed out" } }); }
});

test("actual wrong UID remains refused and a close during delayed verification is identified separately", async () => {
  const socketPath = path(); await listen(netServer(), socketPath);
  const verified = spyOn(transport, "kernelPeer").mockResolvedValue({ ok: true, value: { pid: process.pid, uid: process.getuid!() + 1, gid: process.getgid!() } });
  await expect(unixGatewayFetch({ socketPath, peerUid: process.getuid!() }, "http://callback/")).rejects.toMatchObject({ code: "peer-mismatch" });
  verified.mockImplementation(async socket => { socket.destroy(); await new Promise<void>(resolve => setImmediate(resolve)); return { ok: true, value: { pid: process.pid, uid: process.getuid!(), gid: process.getgid!() } }; });
  await expect(unixGatewayFetch({ socketPath, peerUid: process.getuid!() }, "http://callback/")).rejects.toMatchObject({ code: "transport-closed" });
});

test("callback outage is recoverable but malformed retry metadata and payloads never enter durable preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "preparation-receipt-")); roots.push(root);
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("No native work in receipt fixture"); } });
  const spawned = await service.spawn({ requestId: "typed-receipt-original", cwd: root, message: "Exact bytes" }); if (!spawned.ok) throw new Error(spawned.error.message);
  const message = service.pending(spawned.value.id)[0]!;
  try {
    expect(await prepareCallbackMessage(async () => Response.json({ ok: false, error: { code: "unavailable", message: "Callback not ready" } }, { status: 503 }), spawned.value, message)).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    for (const receipt of [{ ok: false, error: { code: "unavailable", message: "Malformed retry", retryAt: "tomorrow" } }, { ok: false, error: { code: "unknown", message: "Unknown state" } }, { ok: true, value: { text: 3 } }]) {
      expect(await prepareCallbackMessage(async () => Response.json(receipt), spawned.value, message)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  } finally { await service.close(); }
});
