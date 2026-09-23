import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { createSharedImageGenerationService, generateImageWithSharedAccount, IMAGE_MODELS } from "../src/image-service.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kXIAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function sharedAuth(authPath: string) {
  return new SharedOAuthAuth({ path: authPath, providerId: "openai-codex", refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) });
}
function writeCredentials(authPath: string, aliases: readonly string[]) {
  writeFileSync(authPath, JSON.stringify(Object.fromEntries(aliases.map(alias => [alias, {
    type: "oauth", access: `${alias}-token`, refresh: `${alias}-refresh`, expires: Date.now() + 3600000, accountId: `${alias}-account`,
  }]))));
}
function fixture(aliases: readonly string[] = ["test"]) {
  const root = mkdtempSync(join(tmpdir(), "pi-image-service-")); roots.push(root);
  const ledgerPath = join(root, "ledger.sqlite3");
  const store = Store.open(ledgerPath); stores.push(store);
  const authPath = join(root, "auth.json");
  const shared = sharedAuth(authPath);
  for (const id of aliases) store.upsertAccount({ id, provider: "openai-codex", enabled: true });
  writeCredentials(authPath, aliases);
  return { root, store, shared, ledgerPath, authPath };
}
function response() {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response-test", output: [
    { id: "image-test", type: "image_generation_call", status: "completed", model: IMAGE_MODELS[0], result: png.toString("base64") },
  ], usage: { input_tokens: 10 } } })}\n\n`);
}

test("public service loads existing config and returns bytes without publishing files", async () => {
  execFileSync("bun", ["-e", `import { createSharedImageGenerationService, IMAGE_MODELS } from "pi-orchestrator/image-service";
    if (typeof createSharedImageGenerationService !== "function" || !IMAGE_MODELS.length) process.exit(1);`], { cwd: new URL("..", import.meta.url), timeout: 5000 });
  const f = fixture();
  const configPath = join(f.root, "config.json");
  writeFileSync(configPath, JSON.stringify({ authPath: f.authPath }));
  vi.stubEnv("PI_ORCHESTRATOR_AUTH", "");
  const service = createSharedImageGenerationService({ configPath, ledgerPath: f.ledgerPath });
  writeFileSync(join(f.root, "input.png"), png);
  const files = await readdir(f.root);
  const transport = vi.fn(async (_url, init) => {
    expect(f.store.activeLeases()).toHaveLength(1);
    expect(init.headers.get("chatgpt-account-id")).toBe("test-account");
    const body = JSON.parse(init.body);
    expect(body.tools[0].action).toBe("edit");
    expect(body.input[0].content[1].image_url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    return response();
  });
  vi.stubGlobal("fetch", transport);
  const result = await service.generateImageWithSharedAccount({ prompt: "Edit", inputPaths: ["@input.png"] }, { cwd: f.root });
  expect(result).toEqual({ ok: true, accountId: "test", images: [{ id: "image-test", bytes: png }], model: IMAGE_MODELS[0], responseId: "response-test", usage: { input_tokens: 10 } });
  expect(await readdir(f.root)).toEqual(files);
  expect(f.store.activeLeases()).toHaveLength(0);
  await service.close();
  await expect(service.generateImageWithSharedAccount({ prompt: "after shutdown" })).resolves.toMatchObject({ ok: false, error: { kind: "closed" } });
  await service.close();
  expect(transport).toHaveBeenCalledTimes(1);
});

test("spread balances simultaneous requests across eligible accounts and ignores unrelated load and spend", async () => {
  const f = fixture(["a", "b", "c", "disabled", "anthropic", "voice", "reserved", "cooled", "missing-auth"]);
  f.store.setAccountEnabled("disabled", false);
  f.store.upsertAccount({ id: "anthropic", provider: "anthropic", enabled: true });
  f.store.setControl("account-use:voice", "voice");
  f.store.setControl("account-reservation:reserved", JSON.stringify({ reason: "reserved test account", metadata: {} }));
  f.store.setCooldown("cooled", Date.now() + 60_000);
  writeCredentials(f.authPath, ["a", "b", "c", "disabled", "anthropic", "voice", "reserved", "cooled"]);
  f.store.recordMeter("a", "codex-7d", 99, Date.now() + 60_000);
  f.store.recordMeter("b", "codex-7d", 50, Date.now() + 60_000);
  f.store.recordMeter("c", "codex-7d", 1, Date.now() + 60_000);
  f.store.createLease("interactive:image:expired", "a", "interactive", undefined, Date.now() - 120_001);
  f.store.createLease("interactive:image:ended", "a", "interactive");
  f.store.endLease("interactive:image:ended");
  f.store.createLease("interactive:chat", "a", "interactive");

  let release!: () => void;
  let allStarted!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  const selected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    selected.push(init.headers.get("chatgpt-account-id"));
    if (selected.length === 6) allStarted();
    await blocked;
    return response();
  }));

  const owners = Array.from({ length: 6 }, (_, index) => {
    const store = index === 0 ? f.store : Store.open(f.ledgerPath);
    if (index > 0) stores.push(store);
    return { store, shared: sharedAuth(f.authPath) };
  });
  const requests = owners.map((owner, index) => generateImageWithSharedAccount(
    { prompt: `spread ${index}` }, { ...owner, accountSelection: "spread" },
  ));
  await started;
  expect([...selected].sort()).toEqual(["a-account", "a-account", "b-account", "b-account", "c-account", "c-account"]);
  expect(f.store.activeLeases().filter(lease => lease.id.startsWith("interactive:image:")))
    .toHaveLength(6);
  release();
  const results = await Promise.all(requests);
  expect(results.map(result => result.ok ? result.accountId : result.error.kind)).toEqual(["a", "b", "c", "a", "b", "c"]);

  vi.stubGlobal("fetch", vi.fn(async () => response()));
  f.store.createLease("interactive:image:busy", "a", "interactive");
  await expect(generateImageWithSharedAccount({ prompt: "load before rotation" }, { ...f, accountSelection: "spread" }))
    .resolves.toMatchObject({ ok: true, accountId: "b" });
  f.store.endLease("interactive:image:busy");
  await expect(generateImageWithSharedAccount({ prompt: "default selection" }, f))
    .resolves.toMatchObject({ ok: true, accountId: "c" });
});

test("spread round-robin cursor survives new services and stores", async () => {
  const f = fixture(["a", "b", "c"]);
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  const selected: string[] = [];
  for (let index = 0; index < 4; index++) {
    const store = index === 0 ? f.store : Store.open(f.ledgerPath);
    if (index > 0) stores.push(store);
    const service = createSharedImageGenerationService({ store, shared: sharedAuth(f.authPath) });
    const result = await service.generateImageWithSharedAccount({ prompt: `rotation ${index}` }, { accountSelection: "spread" });
    expect(result.ok).toBe(true);
    if (result.ok) selected.push(result.accountId);
    await service.close();
  }
  expect(selected).toEqual(["a", "b", "c", "a"]);
});

test("close aborts and drains concurrent calls before returning, leaving a borrowed store open", async () => {
  const f = fixture();
  const service = createSharedImageGenerationService(f);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let count = 0;
  const transport = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    if (++count === 2) entered();
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", transport);
  const requests = [service.generateImageWithSharedAccount({ prompt: "one" }), service.generateImageWithSharedAccount({ prompt: "two" })];
  await started;
  expect(f.store.activeLeases()).toHaveLength(2);
  await service.close();
  expect(f.store.activeLeases()).toHaveLength(0);
  for (const result of await Promise.all(requests)) expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  expect(transport).toHaveBeenCalledTimes(2);
});

test("cancellation during credential resolution releases the lease and makes no provider call", async () => {
  const f = fixture();
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  const controller = new AbortController();
  vi.spyOn(f.shared, "credential").mockImplementation(async (_account, signal) => {
    controller.abort();
    signal.throwIfAborted();
    throw new Error("unreachable");
  });
  expect(await generateImageWithSharedAccount({ prompt: "test" }, { ...f, signal: controller.signal })).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  expect(f.store.activeLeases()).toHaveLength(0);
  expect(transport).not.toHaveBeenCalled();
});

test("invalid inputs, cancelled calls and unavailable accounts do not acquire credentials", async () => {
  const f = fixture();
  const credential = vi.spyOn(f.shared, "credential");
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  for (const input of [{ prompt: " " }, { prompt: "x", inputPaths: Array(17).fill("a") }, { prompt: "x", inputPaths: ["missing.png"] }]) {
    expect(await generateImageWithSharedAccount(input, { ...f, cwd: f.root })).toMatchObject({ ok: false, error: { kind: "invalid-input" } });
  }
  expect(await generateImageWithSharedAccount({ prompt: "x" }, { ...f, signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  f.store.setControl("account-use:test", "voice");
  expect(await generateImageWithSharedAccount({ prompt: "x" }, f)).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  expect(credential).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(f.store.activeLeases()).toHaveLength(0);
});

test("heartbeat failure aborts the request, reports storage failure, and releases the lease", async () => {
  const f = fixture();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    entered();
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  vi.spyOn(f.store, "heartbeatLease").mockImplementation(() => { throw new Error("database unavailable"); });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const request = generateImageWithSharedAccount({ prompt: "test" }, f);
  await started;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await request).toMatchObject({ ok: false, error: { kind: "storage", message: "Image lease heartbeat failed: database unavailable" } });
  expect(f.store.activeLeases()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
