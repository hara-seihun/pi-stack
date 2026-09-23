import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { loadThreadModelCatalog } from "../src/threads/model-catalog.js";
import { threadSettingsMetadata } from "../src/threads/settings-metadata.js";
import { resolveThreadSettings } from "../src/threads/settings.js";
import customModelConfig from "../src/models.json" with { type: "json" };
import { resolveSessionModel } from "../src/extension/routing.js";
import { installBrokerRouting } from "../src/extension/broker-routing.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thread-models-")); roots.push(root);
  const config = { baseUrl: "https://example.invalid/v1", api: "openai-completions", headers: { "x-private": "secret-header" }, models: [
    { id: "z/default", name: "Private model", icon: "🧪", reasoning: true, thinkingLevelMap: { off: null, minimal: null, medium: null, xhigh: null, max: "max" } },
    { id: "a-second", icon: "🔬" },
  ] };
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { "private-2": config, unavailable: config,
    command: { ...config, apiKey: "!exit 91" } } }));
  writeFileSync(join(root, "auth.json"), JSON.stringify({ "private-2": { type: "api_key", key: "secret-key" } }));
  return root;
}

test("owner-local configured models retain order, auth availability and capabilities without exposing request config", async () => {
  const root = fixture();
  const catalog = await loadThreadModelCatalog(root);
  expect(catalog.configuredModels.map(model => `${model.provider}/${model.id}`)).toEqual([
    "private-2/z/default", "private-2/a-second", "command/z/default", "command/a-second",
  ]);
  const resolved = resolveThreadSettings({ model: "private-2/z/default" });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const metadata = threadSettingsMetadata(resolved.value, catalog);
  expect(metadata.model).toMatchObject({ provider: "private-2", id: "z/default", name: "Private model" });
  expect(catalog.configuredModels.map(model => model.icon)).toEqual(["🧪", "🔬", "🧪", "🔬"]);
  expect(metadata.thinkingLevels).toEqual(["low", "high", "max"]);
  expect(metadata.models.some(model => model.provider === "unavailable")).toBe(false);
  expect(metadata.models.some(model => model.id === "gpt-6-astra")).toBe(true);
  expect(metadata.models.some(model => model.id === "claude-fable-5-1")).toBe(true);
  expect(JSON.stringify(metadata)).not.toMatch(/secret-|example.invalid|exit 91|headers|baseUrl/);
  const otherOwner = mkdtempSync(join(tmpdir(), "thread-models-other-")); roots.push(otherOwner);
  expect((await loadThreadModelCatalog(otherOwner)).configuredModels).toEqual([]);
});

test("custom models pass direct and broker session admission without pooled alias rewriting", async () => {
  const root = fixture();
  const runtime = await ModelRuntime.create({ modelsPath: join(root, "models.json"), authPath: join(root, "auth.json") });
  const model = runtime.getModel("private-2", "z/default")!;
  for (const env of [{ PI_ORCHESTRATOR_CONFIG: join(root, "no-config.json") }, { PI_MODEL_BROKER_URL: "http://127.0.0.1:9999" }]) {
    expect(resolveSessionModel(runtime.getModels(), model.provider, model.id, env)).toEqual({ ok: true, model });
  }
  const handlers = new Map<string, Function>();
  const pi = { registerProvider() {}, registerTool() {}, on(event: string, handler: Function) { handlers.set(event, handler); } };
  installBrokerRouting(pi as never, "http://127.0.0.1:9999", builtinProviders(), join(root, "ledger.sqlite3"), {});
  try {
    await expect(handlers.get("session_start")!({}, { model })).resolves.toBeUndefined();
  } finally { handlers.get("session_shutdown")!({}, { sessionManager: { getSessionId: () => "test" } }); }
});

test("a configured model without an icon is refused; one the orchestrator catalog names borrows its icon", async () => {
  const root = fixture();
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
    anthropic: { models: [{ id: "claude-fable-5-1", name: "Fable" }] },
    "private-2": { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "plain" }] },
  } }));
  await expect(loadThreadModelCatalog(root)).rejects.toThrow(/private-2\/plain .* has no icon/);
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-fable-5-1", name: "Fable" }] } } }));
  writeFileSync(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "secret-key" } }));
  const catalog = await loadThreadModelCatalog(root);
  expect(catalog.configuredModels.find(model => model.id === "claude-fable-5-1")?.icon).toBe("🪶");
});

test("deployed custom models expose the default Opus through native discovery", async () => {
  const root = fixture();
  writeFileSync(join(root, "models.json"), JSON.stringify(customModelConfig));
  writeFileSync(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "secret-key" } }));
  const catalog = await loadThreadModelCatalog(root);
  const resolved = resolveThreadSettings({ model: "opus" });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const metadata = threadSettingsMetadata(resolved.value, catalog);
  expect(metadata.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
  expect(catalog.configuredModels.find(model => model.id === metadata.model.id)?.icon).toBe("🎨");
  expect(catalog.models.some(model => model.id === "claude-opus-5")).toBe(true);
});

test("invalid model configuration fails discovery instead of silently hiding configured providers", async () => {
  const root = fixture();
  writeFileSync(join(root, "models.json"), "{broken");
  await expect(loadThreadModelCatalog(root)).rejects.toThrow("Cannot load thread models");
});
