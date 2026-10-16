import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, unixGatewayFetch, webRequest, writeResponse, type GatewayBinding } from "pi-orchestrator/core-gateway";
import { coreCallbackRoutes, handleCoreCallback } from "./core-callbacks";

const config = { scopeId: "person:one", principalId: "registered-person", coreUid: process.getuid!() };
const binding: GatewayBinding = { gatewayId: "remote-person:one", purpose: "remote-callback", peerUid: config.coreUid, principalId: config.principalId, scopeIds: [config.scopeId], routeCeiling: coreCallbackRoutes() };
const callbacks = {
  prepare: async (input: unknown) => Response.json({ ok: true, value: input }),
  relay: async (operation: string, input: unknown) => Response.json({ ok: true, value: { operation, input } }),
};

test("ordinary HTTP cannot promote headers or bearer into callback authority", async () => {
  const request = new Request("http://remote/v1/core/prepare-message", { method: "POST", headers: { authorization: "Bearer old-service-secret", "x-pi-person": config.principalId, "x-pi-core-gateway": "remote-person:one" }, body: "{}" });
  expect((await handleCoreCallback(request, config, callbacks)).status).toBe(403);
});

test("kernel callback preserves exact envelopes and accepts only the declared scope, principal, purpose and operations", async () => {
  async function withGateway(selected: GatewayBinding, check: (path: string) => Promise<void>, handlers = callbacks) {
    const directory = mkdtempSync(join(tmpdir(), "remote-callback-test-")), path = join(directory, "callback.sock");
    const transport = createGatewayServer(selected, (incoming, outgoing) => {
      const request = webRequest(incoming, "http://remote", new AbortController().signal, "stream");
      void handleCoreCallback(request, config, handlers).then(response => writeResponse(response, outgoing));
    });
    try {
      await new Promise<void>(done => transport.server.listen(path, done));
      await check(path);
    } finally { await transport.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  const input = { input: { threadId: "retained", requestId: "original-receipt", selectedSuggestionIds: ["original-suggestion"] }, environmentId: "existing-host" };
  const post = (socketPath: string, route: string, value: unknown = input, headers: Record<string, string> = {}) => unixGatewayFetch({ socketPath, peerUid: config.coreUid }, `http://remote${route}`, { method: "POST", headers: { "content-type": "application/json", "x-pi-person": "forged-root", ...headers }, body: JSON.stringify(value) });
  await withGateway(binding, async path => {
    expect(await (await post(path, "/v1/core/manager-relay/managerQuestionCustody")).json()).toEqual({ ok: true, value: { operation: "managerQuestionCustody", input } });
    const prepared = { thread: { id: "retained" }, message: { threadId: "retained", id: "same-message", text: "exact text" } };
    expect(await (await post(path, "/v1/core/prepare-message", prepared)).json()).toEqual({ ok: true, value: prepared });
    expect((await post(path, "/v1/core/manager-relay/spawn")).status).toBe(403);
    await expect(unixGatewayFetch({ socketPath: path, peerUid: config.coreUid + 1 }, "http://remote/v1/core/prepare-message", { method: "POST", body: "{}" })).rejects.toThrow();
  });
  let source: string | null = null;
  const shared = { "x-pi-core-callback-source": "fleet:one", "x-pi-core-callback-target": config.scopeId, "x-pi-core-callback-principal": config.principalId };
  await withGateway(binding, async path => {
    const prepared = { thread: { id: "retained-fleet" }, message: { threadId: "retained-fleet", id: "same-message", text: "same text" } };
    expect(await (await post(path, "/v1/core/prepare-message", prepared, shared)).json()).toEqual({ ok: true, value: prepared });
    expect(source).toBe("fleet:one");
    for (const wrong of [{ ...shared, "x-pi-core-callback-principal": "another-person" }, { ...shared, "x-pi-core-callback-target": "another-scope" }, { "x-pi-core-callback-source": "fleet:one" }]) {
      expect((await post(path, "/v1/core/prepare-message", prepared, wrong)).status).toBe(403);
    }
  }, { ...callbacks, prepare: async (input: unknown, sourceScopeId?: string) => { source = sourceScopeId ?? null; return callbacks.prepare(input); } });
  for (const invalid of [{ ...binding, purpose: "core-ingress" as const }, { ...binding, principalId: "another-person" }, { ...binding, scopeIds: ["another-scope"] }]) {
    await withGateway(invalid, async path => { expect((await post(path, "/v1/core/prepare-message")).status).toBe(403); });
  }
});
