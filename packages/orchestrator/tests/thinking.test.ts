import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATOR_CATALOG } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { assign, assignCompletion } from "../src/policy.js";
import { Store } from "../src/store.js";

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thinking-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), path = join(root, "config.json");
  const store = Store.open(ledger); stores.push(store);
  for (const provider of ["openai-codex", "anthropic"] as const) store.upsertAccount({ id: provider, provider, concurrency: 100 });
  const create = (profile = "standard", source: "direct" | "lane" = "direct") => store.createRuns({ count: 1, source, prompt: "test", cwd: root, profile, budget: "force" })[0]!;
  const admit = (id: string, provider = "openai-codex", model = "gpt-6-astra", thinking = "off") => store.assignRun(id, { provider, model, thinking, accountId: provider, unit: id, releasePath: "/release" });
  return { root, ledger, path, store, create, admit };
}

it("normalizes every new direct and lane admission, including private profiles and model-name lookalikes", () => {
  const { store, create, admit } = fixture();
  for (const candidate of [...ORCHESTRATOR_CATALOG.models.filter(candidate => candidate.provider === "openai-codex"), { provider: "openai-codex", model: "private-model" }]) {
    const expected = candidate.model === "gpt-6-luna" ? "max" : "high";
    for (const source of ["direct", "lane"] as const) {
      const id = create("private", source);
      expect(admit(id, candidate.provider, candidate.model, "off")).toBe(true);
      expect(store.run(id)?.thinking).toBe(expected);
      expect(admit(id, candidate.provider, candidate.model, "max")).toBe(false);
      expect(store.run(id)?.thinking).toBe(expected);
    }
  }
});

it("normalizes OpenAI profiles and refuses Anthropic scheduling even with raw config or persisted runs", () => {
  const { path, store, create } = fixture();
  writeFileSync(path, JSON.stringify({ profiles: { custom: [
    { provider: "openai-codex", model: "gpt-6-luna", thinking: "low" },
  ] } }));
  const config = loadConfig(path);
  expect(config.profiles.custom).toEqual([{ provider: "openai-codex", model: "gpt-6-luna", thinking: "max" }]);
  const raw = { ...config, profiles: { custom: [
    { provider: "openai-codex", model: "gpt-6-luna" },
    { provider: "anthropic", model: "claude-opus-5" },
  ] } };
  expect(assign(store, "custom", "force", raw)).toMatchObject({ refusals: [{ accountId: "*", reason: expect.stringContaining("outside OpenAI") }] });
  const id = create("custom");
  expect(assignCompletion(store, id, "custom", raw)).toMatchObject({ refusals: [{ accountId: "*", reason: expect.stringContaining("outside OpenAI") }] });
  expect(store.assignRun(id, { provider: "anthropic", model: "claude-opus-5", accountId: "anthropic", unit: id, releasePath: "/release" })).toBe(false);
  const choice = assign(store, "custom", "force", config).assignment!;
  expect(store.assignRun(id, { ...choice, unit: id, releasePath: "/release" })).toBe(true);
  expect(store.run(id)?.thinking).toBe("max");
  const pinned = create("custom");
  store.db.prepare("UPDATE run SET provider='anthropic', model='claude-opus-5' WHERE id=?").run(pinned);
  expect(assignCompletion(store, pinned, "custom", config)).toMatchObject({ refusals: [{ accountId: "*", reason: expect.stringContaining("outside OpenAI") }] });
});
