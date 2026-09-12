import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { openCoreAccount, type CoreAccountUsage } from "../src/cores/account.js";
import { Store } from "../src/store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(credentials: Record<string, Record<string, unknown>>) {
  const root = mkdtempSync(join(tmpdir(), "core-account-"));
  roots.push(root);
  const ledgerPath = join(root, "ledger.sqlite3");
  const authPath = join(root, "auth.json");
  writeFileSync(authPath, JSON.stringify(credentials));
  return { root, ledgerPath, authPath };
}

function credential(accountId: string, access = `access-${accountId}`) {
  return { type: "oauth", access, refresh: `refresh-${accountId}`, expires: Date.now() + 3_600_000, accountId };
}

function auth(path: string, refresh = async (value: any) => value) {
  return new SharedOAuthAuth({
    path,
    providerId: "openai-codex",
    refresh,
    toAuth: async value => ({ apiKey: value.access }),
    identity: value => typeof value.accountId === "string" ? value.accountId : undefined,
  });
}

function usage(overrides: Partial<CoreAccountUsage> = {}): CoreAccountUsage {
  return {
    sessionId: "interactive-session",
    nativeThreadId: "native-thread",
    turnId: "turn-1",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    ...overrides,
  };
}

describe("external core account bridge", () => {
  it("selects an eligible interactive account, leases it, and records cumulative usage once", async () => {
    const f = fixture({
      replacement: credential("workspace-replacement"),
      reserved: credential("workspace-reserved"),
      selected: credential("workspace-selected"),
    });
    const setup = Store.open(f.ledgerPath);
    setup.upsertAccount({ id: "reserved", provider: "openai-codex" });
    setup.upsertAccount({ id: "selected", provider: "openai-codex" });
    setup.setControl("account-reservation:reserved", JSON.stringify({ metadata: { caller: "atlas" }, reason: "Atlas" }));
    setup.close();

    const account = await openCoreAccount({
      initialProvider: "openai-codex",
      initialModel: "gpt-5.6-luna",
      sessionId: "interactive-session",
      env: { HOME: f.root },
      ledgerPath: f.ledgerPath,
      authPath: f.authPath,
      auth: auth(f.authPath),
      heartbeatMs: 10,
    });
    expect(account.accountId).toBe("selected");
    await expect(account.credentials()).resolves.toEqual({
      accessToken: "access-workspace-selected",
      chatgptAccountId: "workspace-selected",
    });

    account.recordUsage(usage());
    account.recordUsage(usage());
    account.recordUsage(usage({ inputTokens: 130, cachedInputTokens: 50, outputTokens: 30, totalTokens: 160, turnId: "turn-2" }));

    const during = Store.open(f.ledgerPath);
    expect(during.activeLeases("selected").map(row => row.id)).toEqual(["interactive:interactive-session"]);
    expect(during.usageSince(0)).toEqual(expect.arrayContaining([
      { accountId: "selected", model: "gpt-5.6-luna", component: "input", tokens: 70 },
      { accountId: "selected", model: "gpt-5.6-luna", component: "cacheRead", tokens: 50 },
      { accountId: "selected", model: "gpt-5.6-luna", component: "cacheWrite", tokens: 10 },
      { accountId: "selected", model: "gpt-5.6-luna", component: "output", tokens: 30 },
    ]));
    during.close();

    await new Promise(resolve => setTimeout(resolve, 25));
    await account.close();
    await account.close();
    const after = Store.open(f.ledgerPath);
    expect(after.activeLeases("selected")).toEqual([]);
    after.close();

    const changeAccount = Store.open(f.ledgerPath);
    changeAccount.setAccountEnabled("selected", false);
    changeAccount.upsertAccount({ id: "replacement", provider: "openai-codex" });
    changeAccount.close();
    const reopened = await openCoreAccount({
      initialProvider: "openai-codex",
      initialModel: "gpt-5.6-luna",
      sessionId: "interactive-session",
      env: { HOME: f.root },
      ledgerPath: f.ledgerPath,
      authPath: f.authPath,
      auth: auth(f.authPath),
    });
    expect(reopened.accountId).toBe("replacement");
    reopened.recordUsage(usage({ inputTokens: 130, cachedInputTokens: 50, outputTokens: 30, totalTokens: 160, turnId: "turn-2" }));
    reopened.recordUsage(usage({ inputTokens: 145, cachedInputTokens: 55, outputTokens: 35, totalTokens: 180, turnId: "turn-3" }));
    await reopened.close();
    const deduplicated = Store.open(f.ledgerPath);
    expect((deduplicated.db.prepare("SELECT SUM(tokens) tokens FROM usage_hour").get() as any).tokens).toBe(180);
    expect((deduplicated.db.prepare("SELECT SUM(tokens) tokens FROM usage_hour WHERE account_id='replacement'").get() as any).tokens).toBe(20);
    expect(deduplicated.db.prepare("SELECT DISTINCT source FROM usage_hour").all()).toEqual([
      { source: "interactive:core:native-thread" },
    ]);
    deduplicated.close();
  });

  it("uses but does not own an assigned fleet lease", async () => {
    const f = fixture({ assigned: { ...credential("workspace-assigned", "secret-old"), chatgptPlanType: "pro" } });
    const setup = Store.open(f.ledgerPath);
    setup.upsertAccount({ id: "assigned", provider: "openai-codex" });
    setup.upsertAccount({ id: "other", provider: "openai-codex" });
    const [runId] = setup.createRuns({ count: 1, source: "direct", prompt: "work", cwd: f.root, profile: "standard", budget: "force" });
    setup.assignRun(runId!, {
      accountId: "assigned",
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "high",
      unit: "run.service",
      releasePath: "/release",
    });
    const startedAt = (setup.db.prepare("SELECT started_at FROM lease WHERE id=?").get(`run:${runId}`) as any).started_at;
    setup.close();

    let refreshes = 0;
    const shared = auth(f.authPath, async value => ({ ...value, access: `secret-new-${++refreshes}`, expires: Date.now() + 7_200_000 }));
    const account = await openCoreAccount({
      initialProvider: "anthropic",
      initialModel: "ignored",
      sessionId: "fleet-session",
      env: { PI_ORCHESTRATOR_ASSIGNED: "1", PI_ORCHESTRATOR_RUN_ID: runId },
      ledgerPath: f.ledgerPath,
      authPath: f.authPath,
      auth: shared,
    });
    expect(account).toMatchObject({ accountId: "assigned", provider: "openai-codex", model: "gpt-6-astra" });
    await expect(account.credentials()).resolves.toMatchObject({ accessToken: "secret-old", chatgptAccountId: "workspace-assigned", chatgptPlanType: "pro" });
    await expect(account.credentials({ refresh: true, previousAccountId: "workspace-assigned" })).resolves.toMatchObject({ accessToken: "secret-new-1" });
    expect(refreshes).toBe(1);
    expect(readFileSync(f.authPath, "utf8")).toContain("secret-new-1");

    const during = Store.open(f.ledgerPath);
    expect((during.db.prepare("SELECT started_at FROM lease WHERE id=?").get(`run:${runId}`) as any).started_at).toBe(startedAt);
    during.close();
    await account.close();
    const after = Store.open(f.ledgerPath);
    expect(after.activeLeases("assigned").map(row => row.id)).toEqual([`run:${runId}`]);
    expect((after.db.prepare("SELECT ended_at FROM lease WHERE id=?").get(`run:${runId}`) as any).ended_at).toBeNull();
    after.close();
  });
});
