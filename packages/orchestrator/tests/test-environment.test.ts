import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { assign } from "../src/policy.js";
import { Store } from "../src/store.js";

it("keeps default configuration and OAuth inside the test home, including after env stubs reset", () => {
  const home = process.env.HOME!;
  const defaults = () => {
    const config = loadConfig();
    expect(config.authPath).toBe(join(home, ".local/share/pi-orchestrator/auth.json"));
    expect(config.agentDir).toBe(join(home, ".pi/agent"));
    expect(config.modelBrokerUrl).toBeUndefined();
    expect(config.ultrafastModelBrokerUrl).toBeUndefined();
    expect(config.port).toBeUndefined();
  };
  expect(home).toContain("orchestrator-test-home-");
  defaults();
  try {
    vi.stubEnv("PI_ORCHESTRATOR_AUTH", join(home, "fixture-auth.json"));
    expect(loadConfig().authPath).toBe(join(home, "fixture-auth.json"));
  } finally { vi.unstubAllEnvs(); }
  defaults();
});

it("isolates synthetic admissions without bypassing explicit credential rejection", () => {
  const store = Store.open(":memory:");
  try {
    store.upsertAccount({ id: "anthropic", provider: "anthropic" });
    const config = loadConfig("/missing");
    expect(assign(store, { provider: "anthropic", model: "claude-opus-5-5" }, "force", config).assignment?.accountId).toBe("anthropic");
    const authPath = join(process.env.HOME!, "rejected-auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: {
      type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60_000,
      piCredentialState: { state: "login-required", rejectedAt: Date.now() },
    } }));
    const refused = assign(store, { provider: "anthropic", model: "claude-opus-5-5" }, "force", { ...config, authPath });
    expect(refused.assignment).toBeUndefined();
    expect(refused.refusals).toEqual([{ accountId: "anthropic", reason: "shared OAuth credential requires login" }]);
  } finally { store.close(); }
});
