import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createCallbackServer, drainCallbackServers, parseCoreCallbackConfig, validateCallbackReceipt, verifyCallbackDetachment, type CallbackListener, type CallbackPlugins } from "../src/core/callback-transports.js";

const servers: Server[] = [];
afterEach(async () => { await drainCallbackServers(servers.splice(0)); });
const listener: CallbackListener = { id: "old-root", subsystem: "root", host: "127.0.0.1", port: 18120, previousOwner: "root-unit-generation-1", detachmentReceiptPath: "/run/pi-stack/root-callback.json" };
async function serve(boundary: CallbackListener, plugins: CallbackPlugins) {
  const server = createCallbackServer(boundary, plugins); servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
test("callback descriptors are explicit and cannot share canonical or retained ports", () => {
  const canonical = { host: "127.0.0.1", port: 19181 };
  expect(parseCoreCallbackConfig(undefined, canonical).ok).toBe(false);
  expect(parseCoreCallbackConfig({ kind: "none" }, canonical).ok).toBe(true);
  expect(parseCoreCallbackConfig({ kind: "retained", listeners: [listener] }, canonical).ok).toBe(true);
  expect(parseCoreCallbackConfig({ kind: "retained", listeners: [listener, { ...listener, id: "duplicate" }] }, canonical).ok).toBe(false);
  expect(parseCoreCallbackConfig({ kind: "retained", listeners: [{ ...listener, port: canonical.port }] }, canonical).ok).toBe(false);
  expect(verifyCallbackDetachment(listener).ok).toBe(false);
  const receipt = { version: 1, state: "detached", listenerId: listener.id, subsystem: listener.subsystem, host: listener.host, port: listener.port, previousOwner: { identity: listener.previousOwner, detachedAt: "2026-10-10T21:00:00Z" } };
  expect(validateCallbackReceipt(listener, receipt).ok).toBe(true);
  expect(validateCallbackReceipt(listener, { ...receipt, state: "active" }).ok).toBe(false);
  expect(validateCallbackReceipt(listener, { ...receipt, port: listener.port + 1 }).ok).toBe(false);
  expect(validateCallbackReceipt(listener, { ...receipt, previousOwner: { ...receipt.previousOwner, identity: "other" } }).ok).toBe(false);
});
test("old ports expose only their original subsystem and pass auth and health through unchanged", async () => {
  const calls: string[] = [];
  const plugins: CallbackPlugins = {
    root: { fetch: async request => { calls.push(`root:${new URL(request.url).pathname}`); return Response.json({ service: "kenan-root", releaseProtocol: 3, token: request.headers.get("x-pi-kenan-admin") }); } },
    memory: { request: (req, res) => { calls.push(`memory:${req.url}`); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ service: "kenan-memory", token: req.headers.authorization })); } },
  };
  const root = await serve(listener, plugins), memory = await serve({ ...listener, subsystem: "memory" }, plugins);
  const health = await fetch(root.url + "/v1/health").then(response => response.json());
  expect(health).toMatchObject({ service: "kenan-root", releaseProtocol: 3 });
  expect(await fetch(root.url + "/v1/admin/root-sessions", { headers: { "x-pi-kenan-admin": "exact-old-token" } }).then(response => response.json())).toMatchObject({ token: "exact-old-token" });
  expect(await fetch(memory.url + "/v1/memory", { headers: { authorization: "Bearer original-memory" } }).then(response => response.json())).toMatchObject({ service: "kenan-memory", token: "Bearer original-memory" });
  for (const path of ["/v1/memory", "/v1/root/admit", "/v1/threads", "/v1/providers"]) expect((await fetch(root.url + path)).status).toBe(404);
  for (const path of ["/v1/ask", "/v1/admin/root-sessions", "/v1/threads", "/v1/providers"]) expect((await fetch(memory.url + path)).status).toBe(404);
  expect(calls).toHaveLength(3);
});
test("transport shutdown stops accepting but waits for an accepted canonical request", async () => {
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const accepted = new Promise<void>(done => { finish = done; });
  const running = await serve(listener, { root: { fetch: async () => { entered(); await accepted; return Response.json({ accepted: "original" }); } }, memory: null });
  const request = fetch(running.url + "/v1/ask"); await started;
  let drained = false;
  const closing = drainCallbackServers([running.server]).then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(running.server.listening).toBe(false);
  finish(); expect(await request.then(response => response.json())).toEqual({ accepted: "original" });
  await closing; expect(drained).toBe(true);
});
