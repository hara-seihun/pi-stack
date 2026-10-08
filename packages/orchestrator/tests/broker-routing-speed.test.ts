import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProviders } from "../src/models.js";
import { installBrokerRouting } from "../src/extension/broker-routing.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

function fixture(model: { provider: string; id: string }, speed: string, pin?: string) {
  const root = mkdtempSync(join(tmpdir(), "broker-speed-"));
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const context = { model, sessionManager: { getSessionId: () => "broker-speed-test" } };
  const network = vi.fn(() => { throw new Error("Unexpected network request"); });
  vi.stubGlobal("fetch", network);
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerProvider: vi.fn(), registerTool: vi.fn(),
    getActiveTools: () => [], setActiveTools: vi.fn(),
    getThinkingLevel: () => "low", setThinkingLevel: vi.fn(),
    setModel: vi.fn(async (selected: typeof model) => { context.model = selected; return true; }),
  };
  installBrokerRouting(pi as never, "http://broker.invalid", nativeProviders, join(root, "ledger.sqlite3"),
    { PI_THREAD_SPEED: speed, ...(pin ? { PI_SUBAGENT_MODEL: pin } : {}) });
  const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, context); };
  cleanup.push(async () => { await emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); });
  return { emit, context, network, pi };
}

test.each(["priority", "ultrafast", "unknown-speed"])("broker refuses Cerebras %s at every admission gate without contacting a server", async speed => {
  const f = fixture({ provider: "cerebras", id: "gpt-oss-120b" }, speed);
  for (const event of ["session_start", "before_agent_start", "before_provider_request"]) await expect(f.emit(event)).rejects.toThrow(/speed/i);
  expect(f.network).not.toHaveBeenCalled();
  expect(f.pi.setModel).not.toHaveBeenCalled();
});

test("broker permits an explicitly selected Cerebras model at standard speed", async () => {
  const f = fixture({ provider: "cerebras", id: "qwen-3.8-27b" }, "standard");
  for (const event of ["session_start", "before_agent_start", "before_provider_request"]) await f.emit(event);
  expect(f.context.model.provider).toBe("cerebras");
  expect(f.network).not.toHaveBeenCalled();
});

test.each(["gpt-6-astra", "gpt-6.1-sol"])("broker rechecks a switched %s model before the provider request", async id => {
  const f = fixture({ provider: "openai-codex", id }, "ultrafast");
  await f.emit("session_start");
  f.context.model = { provider: "cerebras", id: "qwen-3.8-27b" };
  await expect(f.emit("before_provider_request")).rejects.toThrow("Ultrafast speed requires OpenAI Codex Astra or Sol");
  expect(f.network).not.toHaveBeenCalled();
});

test.each(["openai-codex", "openai-codex-8"])("broker accepts %s Sol Ultrafast at every request gate", async provider => {
  const f = fixture({ provider, id: "gpt-6.1-sol" }, "ultrafast");
  for (const event of ["session_start", "before_agent_start", "before_provider_request"]) await f.emit(event);
  expect(f.context.model).toMatchObject({ id: "gpt-6.1-sol" });
  expect(f.network).not.toHaveBeenCalled();
});

test("broker rejects an unknown pin without substituting the current model", async () => {
  const f = fixture({ provider: "cerebras", id: "gpt-oss-120b" }, "standard", "not-installed");
  await expect(f.emit("session_start")).rejects.toThrow("Unknown subagent model pin");
  await expect(f.emit("before_provider_request")).rejects.toThrow("pinned");
  expect(f.network).not.toHaveBeenCalled();
  expect(f.pi.setModel).not.toHaveBeenCalled();
});
