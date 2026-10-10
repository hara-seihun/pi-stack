import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { repairProviderCredential, quarantineProviderCredential } from "../src/auth/provider-rejection.js";
import { isCredentialError, isRejectedTokenError } from "../src/provider-errors.js";
import { meterCredential } from "../src/auth/meter-credential.js";
import { eligibleInteractiveAccounts } from "../src/auth/account-selection.js";
import { accountCapacity, assignCompletion } from "../src/policy.js";
import { noModelPolicy } from "./fixtures/model-availability.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const invalidated = "Your authentication token has been invalidated. Please try signing in again.";
const alias = "openai-codex-8";
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true })); stores.splice(0).forEach(store => store.close()); });
function fixture(kind: "definitive" | "network" | "success" | "unchanged") {
  const root = mkdtempSync(join(tmpdir(), "credential-recovery-")); roots.push(root);
  const path = join(root, "auth.json"); let now = Date.now();
  const credential = { type: "oauth" as const, access: "bad", refresh: "grant", expires: now + 3_600_000, accountId: "account" };
  writeFileSync(path, JSON.stringify({ [alias]: credential }));
  const refresh = vi.fn(async () => {
    if (kind === "definitive") throw new Error('OAuth refresh failed: 400 {"error":"invalid_grant"}');
    if (kind === "network") throw new Error("fetch failed: ECONNRESET");
    return { ...credential, access: kind === "unchanged" ? "bad" : "fresh", refresh: "rotated" };
  });
  const options = { path, providerId: "openai-codex", refresh, toAuth: async (c: typeof credential) => ({ apiKey: c.access }), now: () => now };
  return { path, credential, refresh, auth: new SharedOAuthAuth(options), reopen: () => new SharedOAuthAuth(options), advance: () => { now += 60_001; } };
}

test.each([invalidated, "Access token revoked", "refresh_token_reused", "Provided authentication token is expired."])("classifies definitive credential rejection: %s", message => {
  expect(isRejectedTokenError(message)).toBe(true);
  expect(isCredentialError(message)).toBe(true);
});

test.each(["definitive", "network", "unchanged"] as const)("failed repair excludes known-bad credentials from all new admissions: %s", async kind => {
  const f = fixture(kind), signal = AbortSignal.timeout(2000);
  const result = await repairProviderCredential(f.auth, alias, invalidated, false, signal, "bad");
  expect(result.outcome).toBe("failed");
  const auth = f.reopen();
  expect(auth.has(alias)).toBe(false);
  expect(auth.rejection(alias)?.state).toBe(kind === "network" ? "refresh-required" : "login-required");
  await expect(auth.resolve(alias, signal)).rejects.toThrow(/shared OAuth credential/);
  expect((await meterCredential(auth, alias, 1000))).toMatchObject({ ok: false, outcome: "credential-failed" });
  expect(f.refresh).toHaveBeenCalledOnce();
  const store = Store.open(":memory:"); stores.push(store); store.upsertAccount({ id: alias, provider: "openai-codex" });
  const config = { ...loadConfig(), authPath: f.path };
  expect(eligibleInteractiveAccounts(store, auth, "openai-codex")).toHaveLength(0);
  expect(accountCapacity(store, alias, "live", config).state).toBe("unavailable");
  expect(assignCompletion(store, "blocked-completion", "luna", config, noModelPolicy).refusals).toContainEqual(expect.objectContaining({ accountId: alias, reason: expect.stringMatching(/shared OAuth credential/) }));
  f.advance();
  f.refresh.mockResolvedValue({ ...f.credential, access: "recovered", refresh: "new" });
  if (kind === "network") expect((await auth.credential(alias, signal)).access).toBe("recovered");
  else {
    await expect(auth.credential(alias, signal)).rejects.toThrow(/requires login/);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect((await auth.refresh(alias, signal)).access).toBe("recovered");
  }
  expect(auth.has(alias)).toBe(true);
});

test("concurrent invalidation repair rotates once, and a second rejection is durable with stale-result protection", async () => {
  const f = fixture("success"), signal = AbortSignal.timeout(2000);
  const repairs = await Promise.all([f.auth, f.reopen()].map(auth => repairProviderCredential(auth, alias, invalidated, false, signal, "bad")));
  expect(repairs.map(r => r.outcome)).toEqual(["repaired", "repaired"]);
  expect(f.refresh).toHaveBeenCalledOnce();
  await quarantineProviderCredential(f.auth, alias, invalidated, false, signal, "bad");
  expect(f.auth.has(alias)).toBe(true);
  await quarantineProviderCredential(f.auth, alias, invalidated, false, signal, "fresh");
  expect(f.reopen().rejection(alias)?.state).toBe("login-required");
  await f.auth.set(alias, { ...f.credential, access: "replacement" }, signal);
  expect(f.auth.has(alias)).toBe(true);
});

test("proactive refresh transport failure preserves an access token that is still valid", async () => {
  const f = fixture("network");
  await expect(f.auth.credential(alias, AbortSignal.timeout(1000), 4_000_000)).rejects.toThrow("ECONNRESET");
  expect(f.auth.rejection(alias)).toBeUndefined();
  expect(f.auth.has(alias)).toBe(true);
  expect((await f.auth.credential(alias, AbortSignal.timeout(1000), 0)).access).toBe("bad");
});

test("transport failures without credential rejection never spend OAuth repair or suppress admissions", async () => {
  const f = fixture("success");
  expect((await repairProviderCredential(f.auth, alias, "503 upstream timeout", false, AbortSignal.timeout(1000), "bad")).outcome).toBe("not-rejected");
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.auth.has(alias)).toBe(true);
});
