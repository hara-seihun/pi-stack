import { afterEach, expect, test } from "bun:test";
import { createGatewayServer } from "../src/core/gateway-transport.js";
import { type GatewayBinding } from "../src/core/gateway.js";
import { type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [], servers: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = new URL("../src/cli.ts", import.meta.url).pathname;
async function fixture(closeAfterIntake = false) {
  const root = mkdtempSync(join(tmpdir(), "cli-gateway-")); roots.push(root);
  const socketPath = join(root, "core.sock"), calls: { path: string; body: unknown; headers: IncomingHttpHeaders; uid: number }[] = [];
  const binding: GatewayBinding = { gatewayId: "synthetic-alice", purpose: "core-ingress", peerUid: process.getuid!(), principalId: "alice", scopeIds: ["declared:alice"], routeCeiling: [{ method: "POST", kind: "prefix", path: "/v1/scopes/declared:alice/thread-owner/" }] };
  const gateway = createGatewayServer(binding, async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url!, body, headers: request.headers, uid: binding.peerUid });
    if (closeAfterIntake) { request.socket.destroy(); return; }
    const allowed = request.url!.startsWith("/v1/scopes/declared%3Aalice/thread-owner/");
    response.writeHead(allowed ? 200 : 403, { "content-type": "application/json" });
    response.end(JSON.stringify(allowed ? { ok: true, value: request.url!.endsWith("/list") ? { threads: [], nextCursor: null } : { id: body.requestId } } : { ok: false, error: { code: "unavailable", message: "Request exceeds the verified gateway route ceiling" } }));
  }); servers.push(gateway); await new Promise<void>(resolve => gateway.server.listen(socketPath, resolve));
  const env: Record<string, string> = { HOME: root, PATH: "/usr/bin:/bin", PI_CORE_URL: "http://synthetic-core.test:19181", PI_CORE_SCOPE_ID: "declared:alice", PI_CORE_GATEWAY_SOCKET: socketPath, PI_CORE_GATEWAY_UID: String(process.getuid!()) };
  const cli = async (args: string[], changes: Record<string, string | undefined> = {}, selected = entry) => {
    const configured = { ...env, ...changes }; for (const key of Object.keys(configured)) if (configured[key] === undefined) delete configured[key];
    const child = Bun.spawn([process.execPath, selected, ...args], { env: configured, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr, receipt: stdout.trim() ? JSON.parse(stdout) : null };
  };
  return { env, calls, cli };
}

test("actual outside-thread CLI uses its declared account scope and own-UID Unix gateway, not a stale callback or bearer", async () => {
  const f = await fixture();
  const result = await f.cli(["list", "--limit", "2"], { PI_THREAD_API_URL: "http://unrelated.test/v1/scopes/stale/thread-owner" });
  expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.receipt).toMatchObject({ ok: true });
  expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ path: "/v1/scopes/declared%3Aalice/thread-owner/list", body: { limit: 2 }, uid: process.getuid!() });
  expect(f.calls[0]!.headers).not.toHaveProperty("authorization"); expect(f.calls[0]!.headers).not.toHaveProperty("x-pi-thread-token");
  const sent = await f.cli(["send", "synthetic-recipient", "--prompt", "Original café bytes", "--request-id", "original-outside-id"]);
  expect(sent.code).toBe(0); expect(sent.receipt).toMatchObject({ ok: true, value: { id: "original-outside-id" } });
  expect(f.calls[1]).toMatchObject({ path: "/v1/scopes/declared%3Aalice/thread-owner/send", body: { requestId: "original-outside-id", threadId: "synthetic-recipient", text: "Original café bytes", delivery: "pending" } });
});

test("CLI preserves original native sender capability and request identity across the supported gateway", async () => {
  const f = await fixture();
  const result = await f.cli(["send", "synthetic-recipient", "--prompt", "Native original", "--request-id", "sender:original-tool", "--source", "explicit"], { PI_THREAD_API_URL: "http://old-callback.test/v1/scopes/declared%3Aalice/thread-owner", PI_THREAD_ID: "sender", PI_THREAD_TOKEN: "synthetic-thread-capability" });
  expect(result.code).toBe(0); expect(f.calls[0]).toMatchObject({ headers: { "x-pi-thread-token": "synthetic-thread-capability" }, body: { requestId: "sender:original-tool", senderId: "sender", source: "explicit", text: "Native original" } });
  expect(f.calls[0]!.headers).not.toHaveProperty("authorization");
});

test("CLI refuses wrong server UID and wrong account scope without selecting another route", async () => {
  const f = await fixture();
  const peer = await f.cli(["list"], { PI_CORE_GATEWAY_UID: String(process.getuid!() + 1) });
  expect(peer.code).toBe(1); expect(peer.receipt).toMatchObject({ ok: false, error: { message: expect.stringContaining("transport-unconfirmed") } }); expect(f.calls).toHaveLength(0);
  const account = await f.cli(["list"], { PI_CORE_SCOPE_ID: "another:account" });
  expect(account.code).toBe(1); expect(account.receipt).toMatchObject({ ok: false, error: { message: "Request exceeds the verified gateway route ceiling" } });
  expect(f.calls).toHaveLength(0);
});

test("unset gateway/account configuration and a bearer binding are explicit errors with zero HTTP intake", async () => {
  const f = await fixture();
  for (const key of ["PI_CORE_SCOPE_ID", "PI_CORE_URL", "PI_CORE_GATEWAY_SOCKET", "PI_CORE_GATEWAY_UID"]) {
    const result = await f.cli(["list"], { [key]: undefined }); expect(result.code).toBe(1);
    expect(result.receipt?.ok === false || result.stderr.includes(key)).toBe(true);
  }
  const bearer = await f.cli(["list"], { PI_CORE_TOKEN_FILE: "/unused-synthetic-token" });
  expect(bearer.code).toBe(1); expect(bearer.receipt).toMatchObject({ ok: false, error: { message: expect.stringContaining("no bearer fallback") } });
  expect(f.calls).toHaveLength(0);
});

test("a lost send receipt returns the original uncertain identity without retrying intake", async () => {
  const f = await fixture(true);
  const result = await f.cli(["send", "synthetic-recipient", "--prompt", "Original uncertain bytes", "--request-id", "original-unconfirmed-send"]);
  expect(result.code).toBe(1);
  expect(result.receipt).toMatchObject({ ok: false, error: { requestId: "original-unconfirmed-send", retryable: false, message: expect.stringContaining("transport-unconfirmed") } });
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.body).toMatchObject({ requestId: "original-unconfirmed-send", text: "Original uncertain bytes" });
});
