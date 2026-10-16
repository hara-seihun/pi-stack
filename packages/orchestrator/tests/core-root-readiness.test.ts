import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rootModule from "../src/core/root.js";
import { serveCore } from "../src/core/main.js";
import type { CoreConfig } from "../src/core/contracts.js";

const roots: string[] = [];
afterEach(() => { mock.restore(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
test("Core's initial readiness does not await unrelated retained Root delivery", async () => {
  const path = mkdtempSync(join(tmpdir(), "core-root-readiness-")); roots.push(path);
  let complete!: (value: { errors: number }) => void, entered = false;
  const delivery = new Promise<{ errors: number }>(resolve => { complete = resolve; });
  spyOn(rootModule, "createCoreRootIntegration").mockResolvedValue({ ok: true, value: { fetch: async () => new Response("synthetic"), reconcile: () => { entered = true; return delivery; }, drain: async () => {}, close: async () => {} } });
  const config: CoreConfig = { version: 1, host: "127.0.0.1", port: 20000 + Math.floor(Math.random() * 30000), statePath: join(path, "core.sqlite"), releaseCommit: "a".repeat(40), principals: [{ kind: "service", id: "synthetic" }], credentials: [], scopes: [], policy: { revision: 1, grants: [], consents: [] }, broker: { kind: "disabled" }, root: { kind: "disabled" }, memory: { kind: "disabled" }, images: { kind: "disabled" }, duties: { kind: "disabled" }, callbacks: { kind: "none" }, gatewayTransport: { kind: "none" }, gatewayBindings: [] };
  const started = await serveCore(config); if (!started.ok) throw new Error(started.error.message);
  try {
    const health = await fetch(`${started.value.service.url}/v1/health`);
    expect(entered).toBe(true); expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ready: true, degraded: true, reconciliation: { provider: "disabled", duties: "ready", root: { state: "pending" } } });
    complete({ errors: 1 }); await new Promise<void>(resolve => setImmediate(resolve));
    const observed = await fetch(`${started.value.service.url}/v1/health`);
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ reconciliation: { root: { state: "delivery-degraded", retainedDeliveryErrors: 1 } } });
  } finally { complete({ errors: 1 }); expect((await started.value.close()).ok).toBe(true); }
});
