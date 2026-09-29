import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import routing from "../src/extension/routing.js";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { Store } from "../src/store.js";

const hooks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@earendil-works/pi-ai/providers/all", async importOriginal => {
  const original = await importOriginal<typeof import("@earendil-works/pi-ai/providers/all")>();
  return { builtinProviders: () => original.builtinProviders().map(p => p.id !== "openai-codex" ? p : {
    ...p, stream: () => ({}), auth: { ...p.auth, oauth: { ...p.auth.oauth!, refresh: hooks.refresh } },
  }) };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true })); });

test.each([false, true])("routing repairs exact invalidation once and fences a second reject, assigned=%s", async assigned => {
  const root = mkdtempSync(join(tmpdir(), "routing-credential-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), path = join(root, "auth.json"), alias = "openai-codex-8";
  const credential = { type: "oauth" as const, access: "bad", refresh: "grant", expires: Date.now() + 3_600_000 };
  writeFileSync(path, JSON.stringify({ [alias]: credential, "openai-codex-9": credential }));
  const store = Store.open(ledger); store.upsertAccount({ id: alias, provider: "openai-codex" }); store.upsertAccount({ id: "openai-codex-9", provider: "openai-codex" }); store.close();
  vi.stubEnv("PI_ORCHESTRATOR_LEDGER", ledger); vi.stubEnv("PI_ORCHESTRATOR_AUTH", path);
  vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", assigned ? "1" : "0"); vi.stubEnv("PI_ORCHESTRATOR_RUN_ID", ""); vi.stubEnv("PI_SUBAGENT_MODEL", undefined); vi.stubEnv("PI_MODEL_BROKER_URL", undefined); vi.stubEnv("PI_ORCHESTRATOR_CONFIG", join(root, "missing-config"));
  const family = builtinProviders().find(p => p.id === "openai-codex")!;
  const refresh = hooks.refresh.mockReset().mockResolvedValue({ ...credential, access: "fresh", refresh: "rotated" });
  const events = new Map<string, Array<(event: any, ctx: any) => any>>(), providers = new Map<string, Provider>();
  const model = { ...family.getModels()[0], provider: alias };
  const ctx = { model, ui: { notify: vi.fn() }, modelRegistry: { refresh: vi.fn(async () => {}) }, sessionManager: { getSessionId: () => "fixture" } };
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerProvider(provider: Provider) { providers.set(provider.id, provider); },
    events: { on: () => () => {} }, registerTool() {}, getActiveTools: () => [], setActiveTools() {},
    appendEntry: vi.fn(), getThinkingLevel: () => "high", setThinkingLevel() {},
    setModel: vi.fn(async (model: any) => { ctx.model = model; return true; }),
  };
  routing(pi as any);
  const emit = async (name: string, event = {}) => { const replies = []; for (const handler of events.get(name) ?? []) replies.push(await handler(event, ctx)); return replies; };
  const sendToken = (access: string) => providers.get(alias)!.stream(model as any, {} as any, { apiKey: access });
  const failure = { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Your authentication token has been invalidated. Please try signing in again.", provider: alias, model: model.id, usage: { totalTokens: 0 } }] };
  try {
    sendToken("bad"); await emit("agent_end", failure);
    expect(refresh).toHaveBeenCalledOnce();
    expect((await emit("agent_before_settle"))).toContainEqual(expect.objectContaining({ continue: true }));
    expect(ctx.model.provider).toBe(alias);
    sendToken("fresh"); await emit("agent_end", failure);
    expect(refresh).toHaveBeenCalledOnce();
    const auth = new SharedOAuthAuth({ path, providerId: "openai-codex", refresh: async c => c, toAuth: async c => ({ apiKey: c.access }) });
    expect(auth.rejection(alias)?.state).toBe("login-required");
    if (assigned) expect(await emit("agent_before_settle")).not.toContainEqual(expect.objectContaining({ continue: true }));
    else {
      expect(ctx.model.provider).toBe("openai-codex-9");
      expect(await emit("agent_before_settle")).toContainEqual(expect.objectContaining({ continue: true }));
    }
  } finally { await emit("session_shutdown"); }
});
