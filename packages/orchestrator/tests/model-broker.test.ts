import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Store } from "../src/store.js";
import { CompletionClient } from "../src/completion-client.js";
import { CompletionService } from "../src/completion.js";
import { assignCompletion } from "../src/policy.js";
import { brokerProvider, modelBrokerUrl, validateBrokerBody } from "../src/model-broker-contract.js";
import { createModelBroker, validateBrokerConfig, type BrokerTransport } from "../src/model-broker.js";
import { createSharedImageGenerationService } from "../src/image-service.js";
import { loadConfig, modelBrokerUrl as publicModelBrokerUrl } from "../src/api.js";
import * as codexUsage from "../src/meters-codex.js";
import { SharedOAuthAuth, withSharedAuth } from "../src/auth/shared-oauth.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const anthropic = builtinProviders().find(provider => provider.id === "anthropic")!;
const anthropicModel = anthropic.getModels()[0];
const body = () => ({ model: "gpt-6-luna", store: false, stream: true, input: [{ role: "user", content: "hello" }], tools: [] });
const sse = (response: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream", "set-cookie": "owner-cookie=never-forward" } });
async function fixture(transport: BrokerTransport) {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.sqlite3"), authPath = join(root, "auth.json");
  vi.stubEnv("PI_ORCHESTRATOR_CONFIG", join(root, "config.json"));
  const store = Store.open(ledgerPath);
  cleanup.push(async () => store.close());
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "shared-account" } })).toString("base64url")}.signature`;
  for (const id of ["shared", "owner-only"]) store.upsertAccount({ id, provider: "openai-codex", enabled: true });
  store.upsertAccount({ id: "anthropic-shared", provider: "anthropic", enabled: true });
  writeFileSync(authPath, JSON.stringify(Object.fromEntries(["shared", "owner-only", "anthropic-shared"].map(id => [id, { type: "oauth", access: token, refresh: "fixture-refresh", accountId: "shared-account", expires: Date.now() + 3600000 }]))));
  const broker = createModelBroker({ ledgerPath, authPath, listeners: [{ principal: "sybil", port: 0, accounts: ["shared", "anthropic-shared"], models: ["openai-codex/gpt-6-luna", `anthropic/${anthropicModel.id}`], maxInFlight: 2 }] }, transport);
  cleanup.push(() => broker.close());
  const [port] = await broker.listen();
  const url = `http://127.0.0.1:${port}`;
  const regrant = (accounts: string[], models = ["openai-codex/gpt-6-luna"]) => broker.applyGrants([{ principal: "sybil", port: 0, accounts, models, maxInFlight: 2 }]);
  const post = (data: unknown, path = "/backend-api/codex/responses") => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer attacker", "chatgpt-account-id": "owner-only", cookie: "owner-cookie", session_id: "kenan-session" }, body: JSON.stringify(data) });
  return { root, store, token, post, url, regrant };
}

test("the person listener routes Voice without opening provider credentials", async () => {
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:8796/sessions");
    expect(JSON.parse(String(init.body)).owner).toBe("broker:sybil");
    return Response.json({ session: { id: "rtc_123" } }, { status: 201 });
  });
  const f = await fixture(transport);
  const response = await f.post({ owner: "kenan", threadId: "thread", sdp: "sdp", instructions: "hello" }, "/v1/voice/sessions");
  expect(response.status).toBe(201);
  expect(transport).toHaveBeenCalledOnce();
  expect(f.store.activeLeases()).toHaveLength(0);
});

test("model-only routes inject granted credentials, namespace affinity and retain only broker usage", async () => {
  const transport = vi.fn(async (_url: any, init: any) => {
    expect(init.headers.get("authorization")).toBe(`Bearer ${f.token}`);
    expect(init.headers.get("chatgpt-account-id")).toBe("shared-account");
    expect(init.headers.get("cookie")).toBeNull();
    expect(init.headers.get("session_id")).not.toBe("kenan-session");
    expect(f.store.activeLeases().map(lease => lease.account_id)).toEqual(["shared"]);
    return sse({ id: "test-response", status: "completed", output: [], usage: { input_tokens: 15, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } } });
  });
  const f = await fixture(transport);
  const response = await f.post(body());
  expect(response.status).toBe(200);
  expect(response.headers.has("set-cookie")).toBe(false);
  await response.text();
  expect(transport.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(f.store.activeLeases()).toHaveLength(0);
  expect(f.store.runs()).toHaveLength(0);
  expect(f.store.usageSince(0).reduce((sum, row) => sum + row.tokens, 0)).toBe(17);
});

test("Fable scoped exhaustion blocks Fable but leaves Opus on shared weekly quota", async () => {
  const transport = vi.fn(async () => new Response("ok"));
  const f = await fixture(transport);
  f.regrant(["anthropic-shared"], ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"]);
  const now = Date.now();
  f.store.recordMeter("anthropic-shared", "anthropic-7d", 90, now + 3600000, now);
  f.store.recordMeter("anthropic-shared", "anthropic-7d_oi", 100, now + 3600000, now);
  const post = (model: string) => fetch(`${f.url}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [] }),
  });
  expect((await post("claude-fable-5-1")).status).toBe(503);
  expect((await post("claude-opus-5-5")).status).toBe(200);
  expect(transport).toHaveBeenCalledOnce();
  f.store.recordMeter("anthropic-shared", "anthropic-7d", 100, now + 3600000, now + 1);
  expect((await post("claude-opus-5-5")).status).toBe(503);
  expect(transport).toHaveBeenCalledOnce();
});

test.each(["repaired", "still-rejected", "usage-healthy", "usage-failed"])("broker bounds corroborated Codex 404 repair and preserves the response: %s", async kind => {
  const probe = vi.spyOn(codexUsage, "fetchCodexUsage").mockImplementation(async () => {
    if (kind === "usage-healthy") return [];
    if (kind === "usage-failed") throw new Error("usage connection failed");
    throw new codexUsage.CodexUnauthorizedError(404, " request-id=usage-rejection");
  });
  const refresh = vi.spyOn(SharedOAuthAuth.prototype, "refreshRejected").mockImplementation(async function(this: SharedOAuthAuth, account, rejected, signal) {
    const credential = await this.credential(account, signal);
    expect(credential.access).toBe(rejected);
    const fresh = { ...credential, access: `${credential.access}-fresh` };
    await withSharedAuth(this.path, signal, (auth, save) => { auth[account] = fresh; save(); });
    return fresh;
  });
  let attempts = 0;
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${f.token}${attempts ? "-fresh" : ""}`);
    return ++attempts === 2 && kind === "repaired" ? sse({}) : new Response("Not Found", { status: 404, headers: { "x-request-id": "inference-rejection" } });
  });
  const f = await fixture(transport);
  const response = await f.post(body());
  expect(response.status).toBe(kind === "repaired" ? 200 : 404);
  expect(probe).toHaveBeenCalledOnce();
  expect(probe.mock.calls[0][0]).toBe(f.token);
  expect(refresh).toHaveBeenCalledTimes(kind.startsWith("usage-") ? 0 : 1);
  expect(transport).toHaveBeenCalledTimes(kind.startsWith("usage-") ? 1 : 2);
  expect(decodeURIComponent(response.headers.get("x-pi-credential-repair")!)).toContain("HTTP 404");
  if (kind !== "repaired") {
    expect(await response.text()).toBe("Not Found");
    expect(response.headers.get("x-request-id")).toBe("inference-rejection");
  } else await response.text();
  expect(f.store.activeLeases()).toHaveLength(0);
});

test("fleet, transcripts, credentials, ungranted models and provider-resource references never reach upstream", async () => {
  const transport = vi.fn(async () => sse({}));
  const f = await fixture(transport);
  for (const path of ["/v1/run", "/v1/run/isolated", "/v1/accounts", "/v1/status", "/v1/runs/owner/transcript", "/auth.json", "/v1/files/owner", "/backend-api/codex/responses?url=http://localhost"]) {
    expect((await f.post(body(), path)).status).toBe(404);
  }
  expect((await f.post({ ...body(), model: "gpt-6-astra" })).status).toBe(403);
  for (const payload of [
    { ...body(), previous_response_id: "owner-response" },
    { ...body(), input: [{ type: "item_reference", id: "owner-item" }] },
    { ...body(), input: [{ type: "input_file", file_id: "owner-file" }] },
    { ...body(), input: [{ type: "input_image", image_url: "https://provider.example/owner-file" }] },
    { ...body(), tools: [{ type: "code_interpreter", container: "owner-container" }] },
    { ...body(), tools: [{ type: "mcp", server_url: "http://localhost/private" }] },
  ]) expect((await f.post(payload)).status).toBe(400);
  expect(transport).not.toHaveBeenCalled();
  f.store.setAccountEnabled("shared", false);
  expect((await f.post(body())).status).toBe(503);
  expect(transport).not.toHaveBeenCalled();
});

test("foreground broker requests admit while fleet account and machine session slots are full", async () => {
  const transport = vi.fn(async () => sse({}));
  const f = await fixture(transport);
  const policy = loadConfig(undefined, f.store.path);
  for (let i = 0; i < Math.max(policy.maxConcurrentSessions, policy.defaultAccountConcurrency); i++) {
    f.store.createLease(`thread:busy-${i}`, "shared", "fleet");
  }
  const before = f.store.activeLeases().length;
  const response = await f.post(body());
  expect(response.status).toBe(200);
  await response.text();
  expect(transport).toHaveBeenCalledOnce();
  expect(f.store.activeLeases()).toHaveLength(before);
  f.store.recordMeter("shared", "codex-7d", 100, Date.now() + 60_000, Date.now());
  expect((await f.post(body())).status).toBe(503);
  expect(transport).toHaveBeenCalledOnce();
});

test("broker probes a cooling granted account when no uncooling account exists", async () => {
  const transport = vi.fn(async () => sse({}));
  const f = await fixture(transport);
  const cooldown = Date.now() + 24 * 60 * 60_000;
  f.store.setCooldown("shared", cooldown);
  const response = await f.post(body());
  expect(response.status).toBe(200);
  await response.text();
  expect(transport).toHaveBeenCalledOnce();
  expect(f.store.account("shared")?.cooldownUntil).toBe(cooldown);
  f.store.recordMeter("shared", "codex-7d", 100, cooldown, Date.now());
  expect((await f.post(body())).status).toBe(503);
  expect(transport).toHaveBeenCalledOnce();
});

test("a broker 429 does not shorten a longer account cooldown", async () => {
  const f = await fixture(async () => new Response("Rate limited", { status: 429 }));
  const cooldown = Date.now() + 24 * 60 * 60_000;
  f.store.setCooldown("shared", cooldown);
  const response = await f.post(body());
  expect(response.status).toBe(429);
  await response.text();
  expect(f.store.account("shared")?.cooldownUntil).toBe(cooldown);
});

test("the principal request ceiling survives busy fleets and keeps its error through native Codex", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = vi.fn(async () => { await held; return sse({}); });
  const f = await fixture(transport);
  const pending = [f.post(body()), f.post(body())];
  try {
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    const family = builtinProviders().find(provider => provider.id === "openai-codex")!;
    const provider = brokerProvider(family, f.url);
    const result = await provider.stream(provider.getModels().find(model => model.id === "gpt-6-luna")!, normalizeContext({
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    }), { maxRetries: 0 }).result();
    expect(result.errorMessage).toContain("Your shared model request limit is full");
    expect(result.errorMessage).not.toContain("ChatGPT usage limit");
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await Promise.all(pending.map(async request => (await request).text()));
  }
  expect(f.store.activeLeases()).toHaveLength(0);
  await (await f.post(body())).text();
  expect(transport).toHaveBeenCalledTimes(3);
});

test.each(["title", "remote-name:thread-1:2"])("durable completion %s retains identity and grants through the client URL encoding", async requestId => {
  const transport = vi.fn(async () => sse({}));
  const f = await fixture(transport);
  const owner = new CompletionService(f.store, f.root);
  expect(owner.submit(requestId, { model: "luna", prompt: "private owner prompt" }).ok).toBe(true);
  const client = new CompletionClient({ baseUrl: f.url });
  expect(await client.get(requestId)).toMatchObject({ ok: false, error: { code: "not-found" } });
  const input = { model: "luna" as const, prompt: "public title", thinkingLevel: "low" as const };
  const submitted = await client.submit(requestId, input);
  expect(submitted).toMatchObject({ ok: true, value: { requestId, state: "queued" } });
  if (!submitted.ok) return;
  expect(await client.submit(requestId, input)).toEqual(submitted);
  expect(await client.get(requestId)).toEqual(submitted);
  expect(await (await fetch(`${f.url}/v1/completions/${requestId}`)).json()).toEqual(submitted.value);
  const now = Date.now();
  for (const id of ["shared", "owner-only"]) f.store.recordMeter(id, "primary", id === "shared" ? 50 : 0, now + 60000, now);
  const assignment = assignCompletion(f.store, submitted.value.runId, "luna", loadConfig(undefined, f.store.path));
  expect(assignment.assignment?.accountId).toBe("shared");
  expect(transport).not.toHaveBeenCalled();
});

test("a waiting completion follows the principal's current grant, not the pool it was submitted with", async () => {
  const f = await fixture(async () => sse({}));
  const submitted = await new CompletionClient({ baseUrl: f.url }).submit("remote-name:thread-7:3", { model: "luna", prompt: "title this" });
  expect(submitted.ok).toBe(true);
  if (!submitted.ok) return;
  const now = Date.now();
  for (const id of ["shared", "owner-only"]) f.store.recordMeter(id, "primary", 10, now + 60_000, now);
  const admit = () => assignCompletion(f.store, submitted.value.runId, "luna", loadConfig(undefined, f.store.path));
  expect(admit().assignment?.accountId).toBe("shared");
  f.regrant(["owner-only"]);
  expect(await new CompletionClient({ baseUrl: f.url }).submit("remote-name:thread-7:3", { model: "luna", prompt: "title this" })).toEqual(submitted);
  expect(admit().assignment?.accountId).toBe("owner-only");
  f.regrant(["owner-only"], [`anthropic/${anthropicModel.id}`]);
  expect(admit().assignment).toBeUndefined();
  f.store.publishBrokerGrants([]);
  expect(admit().refusals.map(refusal => refusal.reason)).toContain("no live model broker grant for sybil");
});

test.each(["bad%", "bad%2Fid", "bad%253Aid"])("broker rejects malformed completion ID %s before storing work", async id => {
  const f = await fixture(async () => sse({}));
  const response = await fetch(`${f.url}/v1/completions/${id}`);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid-request" } });
  expect(f.store.runs()).toHaveLength(0);
});

test("native provider keeps payload and response hooks while using the broker and SSE", async () => {
  const f = await fixture(async (_url, init) => {
    expect(JSON.parse(String(init.body)).fixture).toBe("compaction-hook");
    return sse({ id: "test-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0 } });
  });
  const family = builtinProviders().find(provider => provider.id === "openai-codex")!;
  const provider = brokerProvider(family, f.url);
  let captured = false, observed = false;
  const output = await provider.stream(provider.getModels().find(model => model.id === "gpt-6-luna")!, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }), {
    transport: "websocket", maxRetries: 0,
    onPayload(payload) { captured = true; return { ...(payload as object), fixture: "compaction-hook" }; },
    fetch: (async (url, init) => {
      observed = true;
      expect(String(url)).toBe(`${f.url}/backend-api/codex/responses`);
      return fetch(url, init);
    }) as typeof fetch,
  }).result();
  expect(captured && observed).toBe(true);
  expect(output.errorMessage).toBeUndefined();
  expect(output.stopReason).toBe("stop");
});

test("image service uses broker transport without local OAuth or owner filesystem access", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kXIAAAAASUVORK5CYII=", "base64");
  const transport = vi.fn(async (_url: any, init: any) => {
    const payload = JSON.parse(init.body);
    expect(payload.tools[0].type).toBe("image_generation");
    expect(payload.inputPaths).toBeUndefined();
    return sse({ id: "image-response", status: "completed", output: [{ id: "image", type: "image_generation_call", status: "completed", result: png.toString("base64") }], usage: {} });
  });
  const f = await fixture(transport);
  const configPath = join(f.root, "client-config.json");
  writeFileSync(configPath, JSON.stringify({ modelBrokerUrl: f.url }));
  const service = createSharedImageGenerationService({ configPath, ledgerPath: "/unreadable/owner-ledger", authPath: "/unreadable/owner-auth" });
  cleanup.push(() => service.close());
  expect(await service.generateImageWithSharedAccount({ prompt: "hello" })).toMatchObject({ ok: true, accountId: "model-broker", images: [{ bytes: png }] });
});

test("Anthropic native requests and signed request bytes survive the broker", async () => {
  let signedBytes: string | undefined;
  const f = await fixture(async (url, init) => {
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    if (signedBytes) expect(Buffer.from(init.body as Uint8Array).toString()).toBe(signedBytes);
    const events = [
      { type: "message_start", message: { id: "message", role: "assistant", model: anthropicModel.id, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const provider = brokerProvider(anthropic, f.url);
  const result = await provider.streamSimple(provider.getModels().find(model => model.id === anthropicModel.id)!, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }), { maxRetries: 0 }).result();
  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("stop");
  signedBytes = ` { "model": ${JSON.stringify(anthropicModel.id)}, "stream": true, "messages": [], "metadata": { "user_id": "signed-user-metadata" } } `;
  const response = await fetch(`${f.url}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json" }, body: signedBytes });
  expect(response.status).toBe(200);
  await response.text();
});

test("per-user config discovers the broker without shell environment and explicit overrides win", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-broker-config-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".config/pi-orchestrator/config.json");
  mkdirSync(join(home, ".config/pi-orchestrator"), { recursive: true });
  writeFileSync(path, JSON.stringify({ modelBrokerUrl: "http://127.0.0.1:2461" }));
  const env = { HOME: home };
  expect(publicModelBrokerUrl(env)).toBe("http://127.0.0.1:2461");
  expect(loadConfig(undefined, undefined, env).modelBrokerUrl).toBe("http://127.0.0.1:2461");
  expect(publicModelBrokerUrl({ ...env, PI_MODEL_BROKER_URL: "http://127.0.0.1:2462" })).toBe("http://127.0.0.1:2462");
  const other = join(home, "other.json");
  writeFileSync(other, JSON.stringify({ modelBrokerUrl: "http://127.0.0.1:2463" }));
  expect(publicModelBrokerUrl({ ...env, PI_ORCHESTRATOR_CONFIG: other })).toBe("http://127.0.0.1:2463");
  expect(publicModelBrokerUrl(env, other)).toBe("http://127.0.0.1:2463");
  writeFileSync(path, JSON.stringify({ modelBrokerUrl: 2461 }));
  expect(() => publicModelBrokerUrl(env)).toThrow("modelBrokerUrl must be a string");
  expect(() => publicModelBrokerUrl({ ...env, PI_MODEL_BROKER_URL: "" })).toThrow();
});

test("broker configuration and inline Anthropic tools reject ambiguous trust boundaries", () => {
  expect(() => modelBrokerUrl({ PI_MODEL_BROKER_URL: "https://example.com" })).toThrow();
  expect(validateBrokerConfig({ ledgerPath: "/ledger", authPath: "/auth", listeners: [] })).toBe(false);
  expect(validateBrokerBody("anthropic", { model: "claude", stream: true, messages: [{ type: "tool_use", input: { file_id: "local-file" } }], tools: [{ name: "read", input_schema: { type: "object", properties: { file_id: { type: "string" } } } }] })).toBeUndefined();
  expect(validateBrokerBody("anthropic", { model: "claude", stream: true, messages: [{ content: [{ type: "image", source: { type: "file", file_id: "owner-file" } }] }] })).toMatch(/resources/);
});
