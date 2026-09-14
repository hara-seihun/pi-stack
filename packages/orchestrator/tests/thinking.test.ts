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
  for (const candidate of [...ORCHESTRATOR_CATALOG.models, { provider: "anthropic", model: "gpt-5.6-luna" }, { provider: "openai-codex", model: "private-model" }]) {
    const expected = candidate.provider === "openai-codex" && candidate.model === "gpt-5.6-luna" ? "max" : "high";
    for (const source of ["direct", "lane"] as const) {
      const id = create("private", source);
      expect(admit(id, candidate.provider, candidate.model, "off")).toBe(true);
      expect(store.run(id)?.thinking).toBe(expected);
      expect(admit(id, candidate.provider, candidate.model, "max")).toBe(false);
      expect(store.run(id)?.thinking).toBe(expected);
    }
  }
});

it("normalizes config without changing candidate priority, and Store enforces the policy on raw custom config", () => {
  const { path, store, create } = fixture();
  writeFileSync(path, JSON.stringify({ profiles: { custom: [
    { provider: "anthropic", model: "claude-opus-5", thinking: "off" },
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low" },
  ] } }));
  const config = loadConfig(path);
  expect(config.profiles.custom).toEqual([
    { provider: "anthropic", model: "claude-opus-5", thinking: "high" },
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" },
  ]);
  for (const candidate of ORCHESTRATOR_CATALOG.models) expect(candidate.thinking).toBe(candidate.id === "luna" ? "max" : "high");
  const raw = { ...config, profiles: { custom: [{ provider: "anthropic", model: "claude-opus-5", thinking: "low" }] } };
  const choice = assign(store, "custom", "force", raw).assignment!;
  expect(choice.provider).toBe("anthropic");
  const id = create("custom");
  expect(store.assignRun(id, { ...choice, unit: id, releasePath: "/release" })).toBe(true);
  expect(store.run(id)?.thinking).toBe("high");
});

it("admits fixed fleet children despite a superseded configured thinking level", () => {
  const { store, root, create, admit } = fixture();
  const parent = create();
  const [id] = store.createRuns({ count: 1, source: "direct", prompt: "child", cwd: root, profile: "astra", budget: "force", child: {
    requestId: "child", task: "child", model: "astra", parentRunId: parent, rootRunId: parent,
    assignment: { provider: "openai-codex", model: "gpt-6-astra", thinking: "max" },
  } });
  expect(admit(id!, "openai-codex", "gpt-5.6-sol")).toBe(false);
  expect(admit(id!)).toBe(true);
  expect(store.run(id!)?.thinking).toBe("high");
});

it("keeps admitted thinking and environment through reopen, recovery and completion retries", () => {
  const { ledger, path, store, create, admit } = fixture();
  const id = create("terra");
  expect(admit(id, "openai-codex", "gpt-5.6-terra")).toBe(true);
  store.db.prepare("UPDATE run SET thinking='medium' WHERE id=?").run(id);
  store.setControl(`run-environment:${id}`, JSON.stringify({ HOME: "/root" }));
  store.setControl(`completion-run:${id}`, "request");
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = Store.open(ledger); stores.push(reopened);
  expect(reopened.resumeAssignedRun(id)).toBe(true);
  expect(reopened.adoptAssignedRun(id)).toBe(true);
  expect(reopened.run(id)?.thinking).toBe("medium");
  reopened.requeueRejectedCompletion(id);
  reopened.recordMeter("openai-codex", "codex-5h", 0, Date.now() + 60_000);
  const config = loadConfig(path);
  const choice = assignCompletion(reopened, id, "terra", { ...config, profiles: {} }).assignment!;
  expect(choice).toMatchObject({ model: "gpt-5.6-terra", thinking: "medium" });
  expect(reopened.assignRun(id, { ...choice, thinking: "max", unit: id, releasePath: "/release", environment: { HOME: "/different" } })).toBe(true);
  expect(reopened.run(id)?.thinking).toBe("medium");
  expect(JSON.parse(reopened.control(`run-environment:${id}`)!)).toEqual({ HOME: "/root" });
});

it("selects high Terra and max Luna for new completions and atomically records launch environment", () => {
  const { store, path, create } = fixture();
  store.recordMeter("openai-codex", "codex-5h", 0, Date.now() + 60_000);
  const config = loadConfig(path);
  for (const model of ["terra", "luna"] as const) {
    const id = create(model), expected = model === "luna" ? "max" : "high";
    const choice = assignCompletion(store, id, model, { ...config, profiles: { ...config.profiles, [model]: [{ ...config.profiles[model]![0]!, thinking: "off" }] } }).assignment!;
    expect(choice.thinking).toBe(expected);
    const assignment = { ...choice, unit: id, releasePath: "/release", environment: { HOME: "/root", PI_AGENT_DIR: "/root/.pi/agent" } };
    expect(() => store.assignRun(id, { ...assignment, accountId: "missing" })).toThrow();
    expect(store.control(`run-environment:${id}`)).toBeUndefined();
    expect(store.assignRun(id, assignment)).toBe(true);
    expect(store.run(id)?.thinking).toBe(expected);
    expect(JSON.parse(store.control(`run-environment:${id}`)!)).toEqual(assignment.environment);
  }
});
