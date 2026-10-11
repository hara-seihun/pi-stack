import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gatewayRequest, gatewayRequestStdin } from "../src/core/gateway-request.js";

const env = { PI_CORE_URL: "http://core.test:2470", PI_CORE_GATEWAY_SOCKET: "/run/pi-stack/gateways/original.sock", PI_CORE_GATEWAY_UID: "0", PI_THREAD_TOKEN: "sender" };
test("canonical gateway CLI preserves kernel peer, caller identity, immutable IDs and every HTTP result", async () => {
  const body = { requestId: "original-request", threadId: "original-thread", text: "Original café text", settings: { model: "astra", thinkingLevel: "low", speed: "ultrafast" } };
  for (const status of [200, 400, 401, 403, 404, 409, 503]) {
    const expected = { ok: false, error: { code: "unavailable" } };
    const receipt = await gatewayRequest({ method: "POST", route: "/v1/scopes/original%2Fscope/thread-owner/send", body }, env, async (peer, url, init) => {
      expect(peer).toEqual({ socketPath: env.PI_CORE_GATEWAY_SOCKET, peerUid: 0 });
      expect(String(url)).toBe("http://core.test:2470/v1/scopes/original%2Fscope/thread-owner/send");
      expect(init?.headers).toEqual({ "content-type": "application/json", "x-pi-thread-token": "sender" });
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return Response.json(expected, { status });
    });
    expect(receipt).toEqual({ ok: true, value: { status, body: expected } });
  }
});
test("gateway request never invents authentication, routes or peer identity", async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({}); };
  const input = { method: "GET", route: "/v1/providers/owners/original/v1/status" };
  for (const changed of [{ PI_CORE_GATEWAY_UID: undefined }, { PI_CORE_GATEWAY_UID: "-1" }, { PI_CORE_GATEWAY_SOCKET: "relative" }, { PI_CORE_TOKEN_FILE: "/unused" }, { PI_CORE_URL: "http://user:secret@core.test" }]) expect(await gatewayRequest(input, { ...env, ...changed }, transport)).toMatchObject({ ok: false, error: { code: "configuration" } });
  for (const changed of [{ method: "PATCH" }, { route: "//outside.test/v1/status" }, { route: "/v1/../outside" }, { body: {} }, { headers: { authorization: "Bearer invented" } }, { headers: { "x-pi-thread-token": "another-sender" } }, { extra: true }]) expect(await gatewayRequest({ ...input, ...changed }, env, transport)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
  expect(calls).toBe(0);
  expect(await gatewayRequest(input, env, async () => { throw new Error("peer mismatch"); })).toMatchObject({ ok: false, error: { code: "transport-unconfirmed" } });
  expect(await gatewayRequest(input, env, async () => new Response("not JSON"))).toMatchObject({ ok: false, error: { code: "transport-unconfirmed" } });
});
test("CLI executes through selected-release symlinks and imports stay silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gateway-cli-"));
  try {
    const entry = join(root, "gateway.mjs"), selected = join(root, "selected.mjs");
    const build = await Bun.build({ entrypoints: [new URL("../src/core/gateway-request.ts", import.meta.url).pathname],
      target: "node", format: "esm", outdir: root, naming: "gateway.mjs" });
    expect(build.success).toBe(true);
    symlinkSync(entry, selected);
    for (const runtime of [process.execPath, "/usr/bin/node"]) {
      for (const path of [entry, selected]) {
        const result = Bun.spawnSync([runtime, path], { stdin: Buffer.from("not JSON"), env: {}, timeout: 5000 });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, error: { code: "invalid-request" } });
      }
      const imported = Bun.spawnSync([runtime, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(selected).href)})`],
        { stdin: Buffer.from("not JSON"), env: {}, timeout: 5000 });
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout.toString()).toBe("");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI stdin is finite and typed, without interpreting a malformed input as an empty request", async () => {
  async function* stream(text: string) { yield Buffer.from(text); }
  expect(await gatewayRequestStdin(stream("not JSON"), env)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
  expect(await gatewayRequestStdin(stream("x".repeat(1024 * 1024 + 1)), env)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
});
