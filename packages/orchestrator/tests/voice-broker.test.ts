import { afterEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { forwardVoiceRequest } from "../src/voice-broker.js";
import type { BrokerTransport } from "../src/model-broker.js";

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); } });

async function listener(principal: string, transport: BrokerTransport) {
  const server = createServer((req, res) => void forwardVoiceRequest(principal, req, res, new AbortController().signal, transport));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/voice`;
}

test("Voice status, creation, heartbeat and close use the listener owner, never caller credentials", async () => {
  const sessions = new Map<string, string>();
  const calls: string[] = [];
  const transport: BrokerTransport = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://127.0.0.1:8796");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    expect(init?.redirect).toBe("error");
    calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === "/status") return Response.json({ enabled: true, releaseCommit: "fixture" });
    const body = JSON.parse(String(init?.body));
    if (url.pathname === "/sessions") {
      sessions.set("rtc_123", body.owner);
      return Response.json({ session: { id: "rtc_123" } }, { status: 201 });
    }
    return Response.json({ ok: sessions.get("rtc_123") === body.owner }, { status: sessions.get("rtc_123") === body.owner ? 200 : 404 });
  };
  const alice = await listener("alice", transport);
  const bob = await listener("bob", transport);
  expect(await (await fetch(`${alice}/status`)).json()).toEqual({ enabled: true, releaseCommit: "fixture" });
  const send = (base: string, method: string, path: string) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", authorization: "Bearer caller", cookie: "caller" },
    body: JSON.stringify({ owner: "broker:alice", threadId: "same-thread", sdp: "sdp", instructions: "hello", seconds: 1 }),
  });
  expect((await send(alice, "POST", "/sessions")).status).toBe(201);
  expect(sessions.get("rtc_123")).toBe("broker:alice");
  for (const method of ["PATCH", "DELETE"]) {
    expect((await send(bob, method, "/sessions/rtc_123")).status).toBe(404);
    expect((await send(alice, method, "/sessions/rtc_123")).status).toBe(200);
  }
  const before = calls.length;
  for (const path of ["/sessions/rtc_123?owner=alice", "/sessions/rtc%2F123", "/admin"]) expect((await send(alice, "DELETE", path)).status).toBe(404);
  expect((await fetch(`${alice}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
  expect(calls).toHaveLength(before);
});

test("Voice upstream failure stays visible", async () => {
  const base = await listener("alice", async () => { throw new Error("refused"); });
  const response = await fetch(`${base}/status`);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "The PiStack Voice API service is unavailable" });
});
