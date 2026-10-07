import { expect, it, vi } from "vitest";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { chooseInteractiveAccount, interactiveRetryAvailability } from "../src/auth/account-selection.js";
import { accountModelUnsupported, MODEL_UNSUPPORTED_TTL_MS, modelUnsupportedEvidence, recordAccountModelUnsupported } from "../src/auth/model-entitlement.js";
import { isCredentialError, isModelConfigurationError, isRateLimitError, isTransientFailure, transientRetryAt } from "../src/provider-errors.js";
import type { Thread } from "../src/threads/contracts.js";

const refusal = (model: string) => `{"detail":"The '${model}' model is not supported when using Codex with a ChatGPT account."}`;
const thread: Thread = { id: "worker", parentId: "root", title: "work", cwd: "/tmp", sessionFile: "/tmp/worker.jsonl",
  settings: { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" }, admission: "force",
  state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };
const auth = { has: () => true } as never;

it("classifies an account entitlement refusal as model configuration that reroutes accepted work at once, never capacity or credential", () => {
  for (const message of [refusal("gpt-6.1-sol"), "Codex error: The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."]) {
    expect(isModelConfigurationError(message)).toBe(true);
    expect(isRateLimitError(message)).toBe(false);
    expect(isTransientFailure(message)).toBe(true);
    expect(transientRetryAt(message, 3, 1_000)).toBe(1_000);
    expect(isCredentialError(message)).toBe(false);
  }
  expect(accountModelUnsupported(refusal("gpt-6.1-sol"))).toBe("gpt-6.1-sol");
  expect(accountModelUnsupported("HTTP 429: usage limit reached")).toBeUndefined();
});

it("records only the refused account/model pair named by the provider", () => {
  const store = Store.open(":memory:");
  try {
    store.upsertAccount({ id: "openai-codex-11", provider: "openai-codex" });
    expect(recordAccountModelUnsupported(store, "openai-codex-11", "gpt-6-luna", refusal("gpt-6.1-sol"))).toBe(false);
    expect(recordAccountModelUnsupported(store, "openai-codex-missing", "gpt-6.1-sol", refusal("gpt-6.1-sol"))).toBe(false);
    expect(recordAccountModelUnsupported(store, "openai-codex-11", "gpt-6.1-sol", refusal("gpt-6.1-sol"))).toBe(true);
    expect(modelUnsupportedEvidence(store, "openai-codex-11", "gpt-6.1-sol")).toMatchObject({ model: "gpt-6.1-sol" });
    expect(modelUnsupportedEvidence(store, "openai-codex-11", "gpt-6-luna")).toBeUndefined();
    expect(store.account("openai-codex-11")?.cooldownUntil ?? undefined).toBeUndefined();
  } finally { store.close(); }
});

it("moves future thread admission off a refusing pooled alias, keeps the model, and preserves held-lease recovery", async () => {
  const store = Store.open(":memory:"), fleet = new Fleet(store, loadConfig("/missing"));
  for (const id of ["openai-codex-10", "openai-codex-11"]) store.upsertAccount({ id, provider: "openai-codex", concurrency: 4 });
  try {
    // Affinity pins the thread to -11, as observed when -11 began refusing Sol 6.1.
    store.setControl(`thread-account-affinity:${JSON.stringify([thread.id, "openai-codex", "gpt-6.1-sol"])}`, "openai-codex-11");
    const first = await fleet.admit(thread, thread.settings, false, "accepted");
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.env).toMatchObject({ PI_ORCHESTRATOR_ACCOUNT_ID: "openai-codex-11", PI_ORCHESTRATOR_PROVIDER: "openai-codex" });
    fleet.event(thread.id, { type: "message_end", message: { role: "assistant", model: "gpt-6.1-sol", stopReason: "error", errorMessage: refusal("gpt-6.1-sol") } });
    expect(modelUnsupportedEvidence(store, "openai-codex-11", "gpt-6.1-sol")).toBeDefined();
    expect(store.account("openai-codex-11")?.cooldownUntil ?? undefined).toBeUndefined();

    // Recovery of the accepted execution keeps its recorded account; it is not relabeled or moved.
    const recovered = await fleet.admit(thread, thread.settings, true, "accepted");
    if (!recovered.ok) throw new Error(recovered.error.message);
    expect(recovered.value.env).toMatchObject({ PI_ORCHESTRATOR_ACCOUNT_ID: "openai-codex-11" });
    await recovered.value.release();

    const next = await fleet.admit(thread, thread.settings, false, "next");
    if (!next.ok) throw new Error(next.error.message);
    expect(next.value.env).toMatchObject({ PI_ORCHESTRATOR_ACCOUNT_ID: "openai-codex-10", PI_ORCHESTRATOR_PROVIDER: "openai-codex" });
    expect(store.control(`thread-account-affinity:${JSON.stringify([thread.id, "openai-codex", "gpt-6.1-sol"])}`)).toBe("openai-codex-10");
    await next.value.release();

    // Another model on the refusing account is unaffected.
    const luna = await fleet.admit({ ...thread, id: "luna" }, { ...thread.settings, model: "openai-codex/gpt-6-luna" }, false, "luna");
    expect(luna.ok).toBe(true);
    if (luna.ok) await luna.value.release();
  } finally { store.close(); }
});

it("rejects admission with an actionable error once every account refuses the model, instead of a capacity wait", async () => {
  const store = Store.open(":memory:"), fleet = new Fleet(store, loadConfig("/missing"));
  for (const id of ["openai-codex-11", "openai-codex-12"]) {
    store.upsertAccount({ id, provider: "openai-codex", concurrency: 4 });
    recordAccountModelUnsupported(store, id, "gpt-6-astra", refusal("gpt-6-astra"));
  }
  try {
    const result = await fleet.admit(thread, { ...thread.settings, model: "openai-codex/gpt-6-astra" }, false, "astra");
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("openai-codex/gpt-6-astra is not supported on any eligible openai-codex account") } });
    if (!result.ok) expect(result.error.retryAt).toBeUndefined();
    expect(store.activeSessionLeases()).toEqual([]);
  } finally { store.close(); }
});

it("interactive and broker selection skip refused pairs until the evidence expires", () => {
  const store = Store.open(":memory:"), now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    for (const id of ["openai-codex-2", "openai-codex-11"]) store.upsertAccount({ id, provider: "openai-codex" });
    recordAccountModelUnsupported(store, "openai-codex-2", "gpt-6.1-sol", refusal("gpt-6.1-sol"), now);
    expect(chooseInteractiveAccount(store, auth, "openai-codex", undefined, { model: "gpt-6.1-sol", includeCooling: true })?.id).toBe("openai-codex-11");
    expect(chooseInteractiveAccount(store, auth, "openai-codex", undefined, { model: "gpt-6-luna" })?.id).toBe("openai-codex-11");
    recordAccountModelUnsupported(store, "openai-codex-11", "gpt-6.1-sol", refusal("gpt-6.1-sol"), now);
    expect(chooseInteractiveAccount(store, auth, "openai-codex", undefined, { model: "gpt-6.1-sol", includeCooling: true })).toBeUndefined();
    expect(interactiveRetryAvailability(store, auth, "openai-codex", "gpt-6.1-sol", now).available).toBe(false);
    expect(chooseInteractiveAccount(store, auth, "openai-codex", undefined, { model: "gpt-6-luna" })).toBeDefined();
    clock.mockReturnValue(now + MODEL_UNSUPPORTED_TTL_MS);
    expect(chooseInteractiveAccount(store, auth, "openai-codex", undefined, { model: "gpt-6.1-sol" })).toBeDefined();
  } finally { clock.mockRestore(); store.close(); }
});
