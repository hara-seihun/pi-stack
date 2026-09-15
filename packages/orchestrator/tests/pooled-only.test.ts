import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { pooledOnlyProvider } from "../src/auth/pooled-only.js";
import { Store } from "../src/store.js";
import { resolveSessionModel } from "../src/extension/routing.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function family(id: string): Provider {
  const provider = builtinProviders().find(provider => provider.id === id);
  if (!provider) throw new Error(`${id} is not a builtin provider`);
  return provider;
}

// The ambient sources upstream auth reads: environment first, then whatever a
// person happens to have stored.
const context = { ctx: { env: async (name: string) => process.env[name] } as never, signal: new AbortController().signal };

test.each(["openai-codex", "anthropic"])("%s keeps its models and refuses ambient credentials", async id => {
  vi.stubEnv("OPENAI_API_KEY", "sk-should-never-be-used");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-never-be-used");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "should-never-be-used");
  const upstream = family(id), pooled = pooledOnlyProvider(upstream);
  expect(pooled.id).toBe(upstream.id);
  expect(pooled.getModels().map(model => model.id)).toEqual(upstream.getModels().map(model => model.id));
  // Nothing outside shared custody can authenticate: no ambient key, no stored
  // credential, and no interactive login that would create one.
  expect(pooled.auth.oauth).toBeUndefined();
  expect(pooled.auth.apiKey?.login).toBeUndefined();
  await expect(pooled.auth.apiKey!.check!(context)).resolves.toBeUndefined();
  await expect(pooled.auth.apiKey!.resolve(context)).rejects.toThrow(/shared account pool/);
  // Upstream would take a personal subscription login, and for Anthropic an
  // environment key as well. Both routes are gone once the family is pooled.
  expect(upstream.auth.oauth ?? await upstream.auth.apiKey?.resolve(context)).toBeTruthy();
});

test("a family with no pooled account cannot serve a session", () => {
  const root = mkdtempSync(join(tmpdir(), "pooled-only-"));
  roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), auth = join(root, "auth.json");
  writeFileSync(auth, "{}");
  const store = Store.open(ledger);
  store.close();
  const env = { PI_ORCHESTRATOR_LEDGER: ledger, PI_ORCHESTRATOR_AUTH: auth, PI_ORCHESTRATOR_ASSIGNED: "0", OPENAI_API_KEY: "sk-should-never-be-used" };
  const models = [{ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-astra" } as Model<never>];
  expect(resolveSessionModel(models, "openai-codex", "gpt-6-astra", env)).toEqual({
    ok: false,
    error: "No eligible pooled account for openai-codex/gpt-6-astra.",
  });
  expect(resolveSessionModel(models, "openai-codex", "gpt-9-nonexistent", env))
    .toEqual({ ok: false, error: "Model not found: openai-codex/gpt-9-nonexistent" });
});

test("admission prefers a free account and still admits when the whole pool is cooling", () => {
  const root = mkdtempSync(join(tmpdir(), "pooled-cooling-"));
  roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), authPath = join(root, "auth.json");
  const credential = { type: "oauth", access: "test", refresh: "test", expires: Date.now() + 3_600_000 };
  const accounts = ["openai-codex-2", "openai-codex-3", "openai-codex-4"];
  writeFileSync(authPath, JSON.stringify(Object.fromEntries(accounts.map(id => [id, credential]))));
  const store = Store.open(ledger);
  for (const id of accounts) store.upsertAccount({ id, provider: "openai-codex" });
  const env = { PI_ORCHESTRATOR_LEDGER: ledger, PI_ORCHESTRATOR_AUTH: authPath, PI_ORCHESTRATOR_ASSIGNED: "0" };
  const models = [{ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-astra" } as Model<never>,
    ...accounts.map(id => ({ api: "openai-codex-responses", provider: id, id: "gpt-6-astra" } as Model<never>))];
  const chosen = () => {
    const selection = resolveSessionModel(models, "openai-codex", "gpt-6-astra", env);
    return selection.ok ? selection.model.provider : selection.error;
  };
  store.setCooldown("openai-codex-2", Date.now() + 600_000);
  expect(chosen()).toBe("openai-codex-3");
  store.setCooldown("openai-codex-3", Date.now() + 300_000);
  store.setCooldown("openai-codex-4", Date.now() + 900_000);
  // Every account is cooling. The session lands on the one nearest to expiry
  // rather than being refused: the provider decides, not our guess.
  expect(chosen()).toBe("openai-codex-3");
  store.setCooldown("openai-codex-3", Date.now() + 1_200_000);
  expect(chosen()).toBe("openai-codex-2");
  store.close();
});
