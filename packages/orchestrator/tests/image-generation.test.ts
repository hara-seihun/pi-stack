import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Store } from "../src/store.js";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { installImageGeneration } from "../src/extension/image-generation.js";
import { requestImage, IMAGE_MODELS } from "../src/image-generation.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kXIAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function stream(events: unknown[], fragment = false) {
  const data = new TextEncoder().encode(events.map(event => `event: message\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    if (fragment) for (const byte of data) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(data);
    controller.close();
  } }));
}
function completed(model: string = IMAGE_MODELS[0], result = png.toString("base64")) {
  return { type: "response.completed", response: { id: "resp-test", output: [
    { id: "image-test", type: "image_generation_call", status: "completed", model, result },
  ], usage: { input_tokens: 10, output_tokens: 20 } } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-image-test-")); roots.push(root);
  const store = Store.open(join(root, "ledger.sqlite3")); stores.push(store);
  const authPath = join(root, "auth.json");
  const shared = new SharedOAuthAuth({ path: authPath, providerId: "openai-codex", refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) });
  const hooks = new Map<string, Function>();
  const tools = new Map<string, ToolDefinition>();
  let active = ["read", "bash"];
  const providers = new Set<string>();
  const ctx = { cwd: root, model: { provider: "anthropic" }, modelRegistry: {
    getProviderAuthStatus: (provider: string) => ({ configured: providers.has(provider) }),
    getProviderAuth: async (provider: string) => ({ auth: { apiKey: provider === "openai" ? "api-test" : `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "personal-test" } })).toString("base64url")}.b` } }),
  } } as unknown as ExtensionContext;
  installImageGeneration({
    on: (event: string, handler: Function) => hooks.set(event, handler),
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); active.push(tool.name); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI, store, shared);
  function account(enabled = true, use: "shared" | "voice" = "shared") {
    store.upsertAccount({ id: "codex-test", provider: "openai-codex", enabled });
    store.setControl("account-use:codex-test", use);
    writeFileSync(authPath, JSON.stringify({ "codex-test": { type: "oauth", access: "test-token", refresh: "test-refresh", expires: Date.now() + 3600000, accountId: "chatgpt-test" } }));
  }
  function reconcile(event = "before_agent_start") { hooks.get(event)!({}, ctx); }
  async function execute(overrides = {}, signal?: AbortSignal) {
    return tools.get("image_generation")!.execute("call-test", { prompt: "A blue circle", outputPath: "image.png", ...overrides }, signal, undefined, ctx);
  }
  return { root, store, account, providers, reconcile, execute, active: () => active, tools };
}

test("tool visibility follows eligible OpenAI accounts, independent of the chat provider", () => {
  const f = fixture();
  f.reconcile("session_start");
  expect(f.tools.size).toBe(0);
  f.account(false); f.reconcile(); expect(f.tools.size).toBe(0);
  f.account(true, "voice"); f.reconcile(); expect(f.tools.size).toBe(0);
  f.account(); f.reconcile(); expect(f.active()).toContain("image_generation");
  f.store.setCooldown("codex-test", Date.now() + 60000); f.reconcile();
  expect(f.active()).toEqual(["read", "bash"]);
  f.store.setCooldown("codex-test", 0); f.reconcile();
  expect(f.active()).toContain("image_generation");
  f.account(false); f.reconcile(); expect(f.active()).toEqual(["read", "bash"]);
  f.providers.add("openai"); f.reconcile(); expect(f.active()).toContain("image_generation");
});

test("pooled generation explicitly requests Image 2.5, leases the account, and saves a preview", async () => {
  const f = fixture(); f.account(); f.reconcile("session_start");
  const transport = vi.fn(async (url, options) => {
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(options.headers.get("chatgpt-account-id")).toBe("chatgpt-test");
    expect(f.store.activeLeases("codex-test")).toHaveLength(1);
    expect(JSON.parse(options.body).tools[0]).toMatchObject({ type: "image_generation", model: "gpt-image-2.5-flare", action: "generate" });
    return stream([completed()], true);
  });
  vi.stubGlobal("fetch", transport);
  const result = await f.execute();
  expect(readFileSync(join(f.root, "image.png"))).toEqual(png);
  expect(result.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  expect(f.store.activeLeases()).toHaveLength(0);
  await expect(f.execute()).rejects.toThrow("already exists");
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await readdir(f.root)).some(name => name.includes("staging-"))).toBe(false);
});

test("multiple completed calls are deduplicated, saved, and return the final preview without another request", async () => {
  const f = fixture(); f.account(); f.reconcile();
  const event = completed();
  const first = { ...event.response.output[0], id: "image-first" };
  event.response.output.unshift(first);
  const transport = vi.fn(async () => stream([
    { type: "response.output_item.done", item: first }, event,
  ], true));
  vi.stubGlobal("fetch", transport);
  const result = await f.execute();
  expect(result.details).toMatchObject({ path: join(f.root, "image.png"), paths: [join(f.root, "image.image-1.png"), join(f.root, "image.png")] });
  expect(readFileSync(join(f.root, "image.image-1.png"))).toEqual(png);
  expect(readFileSync(join(f.root, "image.png"))).toEqual(png);
  expect(result.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await readdir(f.root)).some(name => name.includes("staging-"))).toBe(false);
});

test("publication collision preserves every generated image and its receipt without overwriting", async () => {
  const f = fixture(); f.account(); f.reconcile();
  writeFileSync(join(f.root, "image.image-1.png"), "concurrent output");
  const event = completed();
  event.response.output.unshift({ ...event.response.output[0], id: "image-first" });
  const transport = vi.fn(async () => stream([event]));
  vi.stubGlobal("fetch", transport);
  await expect(f.execute()).rejects.toThrow("Image output retained at");
  const staging = (await readdir(f.root)).find(name => name.includes("staging-"))!;
  expect(readFileSync(join(f.root, staging, "1.png"))).toEqual(png);
  expect(readFileSync(join(f.root, staging, "2.png"))).toEqual(png);
  expect(JSON.parse(readFileSync(join(f.root, staging, "receipt.json"), "utf8")).responseId).toBe("resp-test");
  expect(readFileSync(join(f.root, "image.image-1.png"), "utf8")).toBe("concurrent output");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(f.store.activeLeases()).toHaveLength(0);
});

test.each(["openai", "openai-codex"])("personal %s credentials support edits without a pooled account", async provider => {
  const f = fixture(); f.providers.add(provider); f.reconcile("session_start");
  writeFileSync(join(f.root, "source.png"), png);
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    expect(url).toContain(provider === "openai" ? "api.openai.com/v1" : "chatgpt.com/backend-api/codex");
    const body = JSON.parse(options.body);
    expect(body.tools[0]).toMatchObject({ model: "gpt-image-2.5-sunburst", action: "edit", quality: "max" });
    expect(body.input[0].content[1].image_url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    return stream([completed(IMAGE_MODELS[1])]);
  }));
  await f.execute({ inputPaths: ["source.png"], model: IMAGE_MODELS[1], quality: "max" });
  expect(readFileSync(join(f.root, "image.png"))).toEqual(png);
});

test("rate limits cool the selected account without retries or leaked leases and files", async () => {
  const f = fixture(); f.account(); f.reconcile();
  const transport = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }));
  vi.stubGlobal("fetch", transport);
  await expect(f.execute()).rejects.toThrow("HTTP 429");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(f.store.account("codex-test")!.cooldownUntil).toBeGreaterThan(Date.now());
  expect(f.store.activeLeases()).toHaveLength(0);
  expect((await readdir(f.root)).filter(name => name.endsWith(".png"))).toEqual([]);
  f.reconcile(); expect(f.active()).not.toContain("image_generation");
});

test("revocation and cancellation refuse execution without making a provider call", async () => {
  const f = fixture(); f.account(); f.reconcile();
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  f.account(false);
  await expect(f.execute()).rejects.toThrow("requires a connected");
  f.account();
  await expect(f.execute({}, AbortSignal.abort())).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(f.store.activeLeases()).toHaveLength(0);
});

test.each([
  [[], "without response.completed"],
  [[{ type: "response.failed", response: { error: { message: "generation refused" } } }], "generation refused"],
  [[completed(IMAGE_MODELS[0], "bad")], "invalid PNG"],
  [[completed("gpt-image-2")], "instead of"],
])("incomplete, failed, invalid or wrong-model output fails without retry", async (events, message) => {
  const transport = vi.fn(async () => stream(events as unknown[]));
  const result = await requestImage({ prompt: "test" }, { kind: "api", headers: new Headers() }, new AbortController().signal, transport);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain(message);
  expect(transport).toHaveBeenCalledTimes(1);
});
