import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenPiSession, Result, SpawnThread, Thread, ThreadApi } from "../src/threads/contracts.js";
import { ThreadService } from "../src/threads/service.js";
import { resolveSpawnSettings } from "../src/threads/settings.js";

const roots: string[] = [];
const services: ThreadService[] = [];

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function parent(model: string): Thread {
  return {
    id: "parent", parentId: null, role: "conversation", title: "Parent", cwd: "/work",
    sessionFile: "/work/parent.jsonl", settings: { model, thinkingLevel: "high", speed: "standard" },
    admission: "force", state: "idle", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 0,
  };
}

function fixture(): { root: string; service: ThreadService } {
  const root = mkdtempSync(join(tmpdir(), "spawn-settings-"));
  const openSession: OpenPiSession = async () => { throw new Error("This test must not open a model session"); };
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), openSession });
  roots.push(root);
  services.push(service);
  return { root, service };
}

function digest(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])]))
    : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("child spawn settings", () => {
  it.each([
    ["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol"],
    ["openai-codex-8/gpt-6-astra", "openai-codex/gpt-6-sol"],
    ["anthropic/claude-sonnet", "openai-codex/gpt-6-sol"],
    ["anthropic-3/claude-opus-5", "openai-codex/gpt-6-sol"],
  ])("defaults a %s parent to %s", (parentModel, childModel) => {
    expect(resolveSpawnSettings(undefined, parent(parentModel))).toEqual({
      ok: true,
      value: { model: childModel, thinkingLevel: "high", speed: "standard" },
    });
  });

  it.each([
    ["luna", "openai-codex/gpt-6-luna"],
    ["sol", "openai-codex/gpt-6-sol"],
  ])("preserves the explicit %s choice", (requested, model) => {
    expect(resolveSpawnSettings({ model: requested, thinkingLevel: "minimal", speed: "priority" }, parent("openai-codex/gpt-6-astra"))).toEqual({
      ok: true,
      value: { model, thinkingLevel: "minimal", speed: "priority" },
    });
  });

  it.each([
    "astra", "gpt-6-astra", "openai-codex/gpt-6-astra", "openai-codex-8/gpt-6-astra", "alternate/gpt-6-astra",
    "fable", "claude-fable-5-1", "anthropic/claude-fable-5-1", "anthropic-8/claude-fable-5-1", "alternate/claude-fable-5-1",
  ])("rejects forbidden child identity %s", model => {
    expect(resolveSpawnSettings({ model }, parent("openai-codex/gpt-6-astra"))).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("Astra or Fable") },
    });
  });

  it.each([
    "opus", "sonnet", "anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic-3/claude-opus-5",
  ])("accepts explicit Anthropic child model %s", model => {
    expect(value(resolveSpawnSettings({ model }, parent("openai-codex/gpt-6-sol"))).model).toMatch(/^anthropic(-\d+)?\//);
  });

  it.each([
    "anthropic/missing-model", "anthropic-8/missing-model",
    "openai-codex/missing-model", "openai-codex-8/missing-model",
  ])("retains installed-model validation for child model %s", model => {
    expect(resolveSpawnSettings({ model }, parent("openai-codex/gpt-6-astra"))).toMatchObject({
      ok: false, error: { code: "invalid_request", message: expect.stringContaining(`Unknown model ${model}`) },
    });
  });

  it("leaves parentless defaults and model choices unchanged", () => {
    expect(value(resolveSpawnSettings(undefined, null)).model).toBe("openai-codex/gpt-6-astra");
    expect(value(resolveSpawnSettings({ model: "astra" }, null)).model).toBe("openai-codex/gpt-6-astra");
    expect(value(resolveSpawnSettings({ model: "fable" }, null)).model).toBe("anthropic/claude-fable-5-1");
  });
});

describe("ThreadService child spawn policy", () => {
  it("keeps explicit Anthropic on conversations, children and direct runs", async () => {
    const { root, service } = fixture();
    const conversation = value(await service.spawn({ requestId: "root", cwd: root, settings: { model: "opus" } }));
    const child = value(await service.spawn({ requestId: "child", cwd: root, parentId: conversation.id }));
    expect(child.settings.model).toBe("openai-codex/gpt-6-sol");
    expect(await service.control({ action: "settings", threadId: child.id, settings: { model: "opus" } })).toMatchObject({ ok: true });
    expect(await service.control({ action: "settings", threadId: child.id, settings: { model: "fable" } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(value(await service.spawn({ requestId: "direct", cwd: root, settings: { model: "opus" }, metadata: { source: "direct" } })).settings.model).toMatch(/^anthropic\//);
    expect(await service.control({ action: "settings", threadId: conversation.id, settings: { model: "fable" } })).toMatchObject({ ok: true });
  });

  it("rejects forbidden settings before forwarding to a worker owner", async () => {
    const { root, service } = fixture();
    const rootThread = value(await service.spawn({ requestId: "root", cwd: root }));
    const forward = vi.fn(async (_input: SpawnThread) => ({ ok: true as const, value: rootThread }));
    service.setDirectory(service, () => ({ spawn: forward } as unknown as ThreadApi));

    const result = await service.spawn({ requestId: "child", parentId: rootThread.id, cwd: root, settings: { model: "alternate/gpt-6-astra" } });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(forward).not.toHaveBeenCalled();
  });

  it("replays a persisted pre-policy child receipt without revalidating it", async () => {
    const { root, service } = fixture();
    const rootThread = value(await service.spawn({ requestId: "root", cwd: root }));
    const input: SpawnThread = { requestId: "old-child", parentId: rootThread.id, cwd: root, settings: { model: "astra" } };
    const child = value(service.importThread({
      id: "old-child-thread", parentId: rootThread.id, title: "Old child", cwd: root,
      sessionFile: join(root, "old-child.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" },
    }));
    const db = new DatabaseSync(join(root, "threads.sqlite"));
    try {
      db.prepare("INSERT INTO thread_request(id,hash,kind,target) VALUES(?,?,?,?)").run(input.requestId, digest(input), "spawn", child.id);
    } finally {
      db.close();
    }

    expect(await service.spawn(input)).toEqual({ ok: true, value: child });
  });
});
