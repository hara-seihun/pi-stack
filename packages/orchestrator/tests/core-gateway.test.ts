import { request as httpRequest } from "node:http";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createGatewayServer, recoverGatewaySocket } from "../src/core/gateway-transport.js";
import { unixGatewayFetch } from "../src/core/gateway-fetch.js";
import { assertGatewayRequest, gatewayAuthority, intersectGatewayAuthority, parseGatewayConfig, type GatewayBinding } from "../src/core/gateway.js";
import { webRequest } from "../src/core/http.js";
const binding: GatewayBinding = { gatewayId: "alice-gateway", purpose: "core-ingress", peerUid: process.getuid!(), principalId: "alice", scopeIds: ["alice"], routeCeiling: [{ method: "GET", kind: "exact", path: "/v1/scopes/alice/projection" }, { method: "POST", kind: "prefix", path: "/v1/scopes/alice/thread-owner/" }] };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function unix(path: string, route: string, headers: Record<string, string> = {}): Promise<{ status: number; value: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: path, path: route, headers, agent: false }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, value: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject); request.end();
  });
}
async function serve(selected: GatewayBinding, handler: Parameters<typeof createGatewayServer>[1]) {
  const directory = mkdtempSync(join(tmpdir(), "core-gateway-")), path = join(directory, "peer.sock");
  const transport = createGatewayServer(selected, handler);
  await new Promise<void>(done => transport.server.listen(path, done));
  cleanup.push(async () => { await transport.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...transport, path };
}
test("gateway configuration cannot invent principals, scopes, route authority or a TCP peer", () => {
  const principals = [{ kind: "person" as const, id: "alice", person: "alice" }], scopes = [{ id: "alice", principalId: "alice" }];
  const transport = { kind: "unix", socketDir: "/run/pi-stack/gateways" };
  expect(parseGatewayConfig(transport, [binding], principals, scopes).ok).toBe(true);
  expect(parseGatewayConfig(undefined, [], principals, scopes).ok).toBe(false);
  expect(parseGatewayConfig(transport, [{ ...binding, principalId: "forged" }], principals, scopes).ok).toBe(false);
  expect(parseGatewayConfig(transport, [{ ...binding, scopeIds: ["bob"] }], principals, scopes).ok).toBe(false);
  expect(parseGatewayConfig(transport, [{ ...binding, routeCeiling: [{ method: "POST", kind: "prefix", path: "/v1/" }] }], principals, scopes).ok).toBe(false);
});
test("real SO_PEERCRED admits configured peer, ignores forged identity headers, and transfers unread/stream context", async () => {
  const running = await serve(binding, (req, res) => {
    const unread = webRequest(req, "http://core.local", new AbortController().signal, "unread");
    const stream = webRequest(req, "http://core.local", new AbortController().signal, "stream");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ principal: gatewayAuthority(stream)?.principalId, same: gatewayAuthority(stream) === gatewayAuthority(unread) }));
  });
  expect(await unix(running.path, "/v1/scopes/alice/projection", { "x-pi-person": "bob", "x-pi-principal": "root" })).toEqual({ status: 200, value: { principal: "alice", same: true } });
  expect((await unix(running.path, "/v1/scopes/bob/projection")).status).toBe(403);
  expect((await unix(running.path, "/v1/providers/control")).status).toBe(403);
  const untrusted = await serve({ ...binding, peerUid: binding.peerUid + 1 }, (_req, res) => { res.end("should-not-enter"); });
  await expect(unix(untrusted.path, "/v1/scopes/alice/projection")).rejects.toThrow();
});
test("native thread capability can only narrow its gateway principal and scope ceiling", () => {
  expect(intersectGatewayAuthority(binding, { principalId: "alice", scopeIds: ["alice", "bob"] })).toEqual({ ok: true, value: { principalId: "alice", scopeIds: ["alice"] } });
  expect(intersectGatewayAuthority(binding, { principalId: "bob", scopeIds: ["alice"] }).ok).toBe(false);
  expect(intersectGatewayAuthority(binding, { principalId: "alice", scopeIds: ["bob"] }).ok).toBe(false);
  expect(assertGatewayRequest(binding, new Request("http://core.local/v1/scopes/alice/projection", { method: "POST" })).ok).toBe(false);
});
test("Unix gateway drain waits for accepted HTTP work without admitting a new identity", async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(done => { entered = done; }), accepted = new Promise<void>(done => { finish = done; });
  const running = await serve(binding, (_req, res) => { entered(); void accepted.then(() => res.end(JSON.stringify({ accepted: true }))); });
  const work = unix(running.path, "/v1/scopes/alice/projection"); await started;
  let drained = false; const close = running.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  finish(); expect((await work).value).toEqual({ accepted: true }); await close; expect(drained).toBe(true);
});

test("Unix fetch verifies server peer before sending a streamed request and preserves response streaming", async () => {
  let calls = 0;
  const running = await serve(binding, (req, res) => {
    calls++; let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.write('{"echo":'); res.end(JSON.stringify(body) + '}'); });
  });
  const peer = { socketPath: running.path, peerUid: process.getuid!() };
  const response = await unixGatewayFetch(peer, "http://core.local/v1/scopes/alice/thread-owner/prompt", { method: "POST", body: "original-input" });
  expect(await response.json()).toEqual({ echo: "original-input" });
  await expect(unixGatewayFetch({ ...peer, peerUid: peer.peerUid + 1 }, "http://core.local/v1/scopes/alice/thread-owner/prompt", { method: "POST", body: "must-not-send" })).rejects.toThrow("configured kernel peer");
  expect(calls).toBe(1);
});
test("stale socket removal needs affirmative refusal and preserves live sockets", async () => {
  const running = await serve(binding, (_req, res) => res.end('{}'));
  chmodSync(running.path, 0o600);
  const identity = statSync(running.path).ino;
  await expect(recoverGatewaySocket(running.path, process.getuid!())).rejects.toThrow("still live");
  expect(statSync(running.path).ino).toBe(identity);
  const directory = mkdtempSync(join(tmpdir(), "stale-gateway-")), path = join(directory, "stale.sock");
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync("/usr/bin/python3", ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", path], { timeout: 1000 });
  expect(child.status).toBe(0); chmodSync(path, 0o600);
  await recoverGatewaySocket(path, process.getuid!()); expect(existsSync(path)).toBe(false);
});
