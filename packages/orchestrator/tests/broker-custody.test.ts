import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { CompletionService } from "../src/completion.js";
import { createModelBroker, type BrokerTransport } from "../src/model-broker.js";
import { ModelAvailabilityStore } from "../src/threads/model-availability.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "broker-custody-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const store = Store.open(join(root, "current.sqlite3")), retained = Store.open(join(root, "retained.sqlite3"));
  cleanups.push(async () => { store.close(); retained.close(); });
  const config = { ledgerPath: store.path, authPath: join(root, "auth.json"), listeners: ["kenan", "other"].map(principal => ({ principal, port: 0, accounts: ["account"], models: ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol"], maxInFlight: 8 })) };
  const availability = new ModelAvailabilityStore(join(root, "policy.json"));
  const open = (transport: BrokerTransport = fetch) => {
    const broker = createModelBroker(config, availability, transport, { store, completionOwners: [{ id: "fleet", store: retained }] });
    cleanups.push(() => broker.close());
    return broker;
  };
  return { root, store, retained, open };
}

const explicit = { model: "luna", prompt: "exact original", thinkingLevel: "low", speed: "standard" } as const;

test("adopts a retained ledger's existing attempt without renaming or replaying it, surviving broker replacement", async () => {
  const f = fixture(), service = new CompletionService(f.retained, f.root);
  const admitted = service.submit("legacy", explicit);
  expect(admitted.ok).toBe(true); if (!admitted.ok) return;
  const runId = admitted.value.runId;
  const saved = JSON.parse(f.retained.control("completion:legacy")!);
  delete saved.input.thinkingLevel; delete saved.input.speed; delete saved.record.settings;
  f.retained.setControl("completion:legacy", JSON.stringify(saved));
  f.retained.upsertAccount({ id: "account", provider: "openai-codex" });
  f.retained.assignRun(runId, { accountId: "account", provider: "openai-codex", model: "gpt-6-luna", unit: `completion:${runId}`, releasePath: "/accepted-release" });
  expect(service.claim(runId, "accepted-attempt").ok).toBe(true);
  const broker = f.open();
  expect(broker.adoptCompletion("kenan", "public-id", "legacy", "fleet")).toMatchObject({ ok: true, value: { requestId: "public-id", runId, state: "running" } });
  const [port, otherPort] = await broker.listen(), url = `http://127.0.0.1:${port}/v1/completions/public-id`;
  expect(await (await fetch(url)).json()).toMatchObject({ requestId: "public-id", runId, state: "running" });
  expect((await fetch(`http://127.0.0.1:${otherPort}/v1/completions/public-id`)).status).toBe(404);
  const replay = await fetch(url, { method: "PUT", body: JSON.stringify({ model: "luna", prompt: "exact original" }) });
  expect(replay.status).toBe(200);
  expect((await replay.json()).settings).toBeUndefined();
  expect((await fetch(url, { method: "PUT", body: JSON.stringify(explicit) })).status).toBe(409);
  expect(await (await fetch(`${url}/attempts`)).json()).toMatchObject({ attempts: [{ attemptId: "accepted-attempt", runId }] });
  expect((await fetch(`${url}/cancel`, { method: "POST" })).status).toBe(200);
  expect((await fetch(`${url}/retry`, { method: "POST" })).status).toBe(409);
  expect(f.retained.runs()).toHaveLength(1); expect(f.store.runs()).toHaveLength(0);
  expect(f.retained.activeLeases()).toHaveLength(1);
  await broker.close();
  const successor = f.open(), [next] = await successor.listen();
  expect(await (await fetch(`http://127.0.0.1:${next}/v1/completions/public-id`)).json()).toMatchObject({ state: "cancelled", runId });
  expect(f.retained.runs()).toHaveLength(1);
});

test("new broker requests require explicit settings and preserve exact catalogue models", async () => {
  const f = fixture(), broker = f.open(), [port] = await broker.listen(), base = `http://127.0.0.1:${port}/v1/completions`;
  expect((await fetch(`${base}/unset`, { method: "PUT", body: JSON.stringify({ model: "luna", prompt: "new" }) })).status).toBe(400);
  expect(f.store.runs()).toHaveLength(0);
  for (const [id, model] of [["astra", "astra"], ["sol", "openai-codex/gpt-6.1-sol"]]) {
    const response = await fetch(`${base}/${id}`, { method: "PUT", body: JSON.stringify({ ...explicit, model }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ model, settings: { thinkingLevel: "low", speed: "standard" } });
  }
  const schema = await (await fetch(`${base}/openapi.json`)).json();
  expect(schema.paths["/v1/completions/{requestId}/attempts"]).toBeDefined();
  expect(schema.paths["/v1/completions/{requestId}/retry"]).toBeDefined();
});

test("an unfinished cross-ledger adoption fences the public ID instead of creating another run", async () => {
  const f = fixture(), broker = f.open();
  expect(broker.adoptCompletion("kenan", "missing", "missing", "fleet")).toMatchObject({ ok: false, error: { code: "not-found" } });
  const [port] = await broker.listen();
  expect((await fetch(`http://127.0.0.1:${port}/v1/completions/missing`, { method: "PUT", body: JSON.stringify(explicit) })).status).toBe(503);
  expect(f.store.runs()).toHaveLength(0); expect(f.retained.runs()).toHaveLength(0);
});

test("broker replacement drains an accepted stream without aborting its provider request", async () => {
  const f = fixture();
  f.store.upsertAccount({ id: "account", provider: "openai-codex" });
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
  writeFileSync(join(f.root, "auth.json"), JSON.stringify({ account: { type: "oauth", access: token, refresh: "fixture", accountId: "fixture", expires: Date.now() + 3_600_000 } }));
  let release!: () => void, entered!: () => void, providerSignal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  const broker = f.open(async (_url, init) => {
    providerSignal = init.signal as AbortSignal;
    entered(); await gate;
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, model: "gpt-6-luna" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const [port] = await broker.listen();
  const pending = fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", store: false, stream: true, input: [{ role: "user", content: "fixture" }], tools: [] }) }).then(response => response.text());
  await accepted;
  let drained = false;
  const closing = broker.close().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false); expect(providerSignal?.aborted).toBe(false);
  release(); await pending; await closing;
  expect(drained).toBe(true); expect(f.store.closed).toBe(false);
  expect(f.store.activeLeases()).toHaveLength(0);
});
