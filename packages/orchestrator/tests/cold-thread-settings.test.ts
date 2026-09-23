import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Thread, ThreadApi } from "../src/api.js";
import { ThreadService } from "../src/threads/service.js";
import { threadSettingsMetadata } from "../src/threads/settings-metadata.js";
import { updateThreadSettings } from "../../../apps/remote/server/thread-settings.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test.each([false, true])("cold settings read/write needs neither a workspace nor model admission, held=%s", async held => {
  const root = mkdtempSync(join(tmpdir(), "cold-settings-"));
  const openSession = vi.fn(async () => { throw new Error("Settings must not open native sessions"); });
  const admit = vi.fn(async () => { throw new Error("Settings must not admit model work"); });
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, openSession, admit });
  cleanup.push(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const imported = service.importThread({ id: "cold", title: "Cold", cwd: "/missing/checkout", sessionFile: "/missing/native.jsonl", held,
    settings: { model: "openai-codex/gpt-6-sol", thinkingLevel: "high", speed: "standard" }, metadata: { retain: true } });
  expect(imported.ok).toBe(true);
  if (held) service.importMessage({ id: "held", threadId: "cold", text: "Do not replay", state: "queued" });
  const before = service.get("cold")!, pending = service.pending("cold");
  expect(threadSettingsMetadata(before.settings)).toMatchObject({ model: { provider: "openai-codex", id: "gpt-6-sol" }, thinkingLevel: "high" });
  const invalid = await updateThreadSettings(service, before, { modelProvider: "anthropic", modelId: "claude-fable-5-1", bashTimeoutSeconds: 1 });
  expect(invalid.ok).toBe(false);
  expect(service.get("cold")!.settings).toEqual(before.settings);
  expect(await updateThreadSettings(service, before, { modelId: "gpt-6-astra" })).toMatchObject({ ok: false });
  const result = await updateThreadSettings(service, before, { modelProvider: "anthropic", modelId: "claude-fable-5-1", thinkingLevel: "high", bashTimeoutSeconds: 300 });
  expect(result).toMatchObject({ ok: true, value: { state: before.state, metadata: { retain: true, bashTimeoutSeconds: 300 }, settings: { model: "anthropic/claude-fable-5-1" } } });
  if (!result.ok) return;
  const settings = threadSettingsMetadata(result.value.settings);
  expect(settings.model.id).toBe("claude-fable-5-1");
  expect(settings.models.some(model => model.id === settings.model.id && model.provider === settings.model.provider)).toBe(true);
  expect(settings.thinkingLevels).toContain("high");
  expect(service.pending("cold")).toEqual(pending);
  expect(openSession).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});

test("a saved pooled account selects the same canonical option as the model list", () => {
  const settings = threadSettingsMetadata({ model: "openai-codex-8/gpt-6-astra", thinkingLevel: "high", speed: "standard" });
  expect(settings.model).toMatchObject({ provider: "openai-codex", id: "gpt-6-astra" });
  expect(settings.models).toContainEqual(settings.model);
  expect(settings.models).toHaveLength(6);
  expect(settings.speedModes).toEqual(["standard", "priority"]);
});

test("unlisted saved models remain selectable without replacing the accepted selection", () => {
  for (const model of ["private/local-model", "anthropic/claude-sonnet-4-5"]) {
    const settings = threadSettingsMetadata({ model, thinkingLevel: "medium", speed: "standard" });
    expect(`${settings.model.provider}/${settings.model.id}`).toBe(model);
    expect(settings.models).toContainEqual(settings.model);
    expect(settings.models).toHaveLength(7);
    expect(settings.thinkingLevels).toContain("medium");
  }
});

test("a failed second write identifies the settings already saved", async () => {
  const thread: Thread = {
    id: "cold", parentId: null, title: "Cold", cwd: "/missing/checkout", sessionFile: "/missing/native.jsonl",
    settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" },
    admission: "force", state: "idle", held: false, revision: 1, createdAt: 0, updatedAt: 0, pendingMessages: 0,
    metadata: { retain: true },
  };
  const control = vi.fn<ThreadApi["control"]>().mockResolvedValueOnce({ ok: true, value: thread })
    .mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "Controller handed off" } });
  expect(await updateThreadSettings({ control }, thread, { thinkingLevel: "high", bashTimeoutSeconds: 300 })).toMatchObject({
    ok: false, error: { code: "unavailable", message: expect.stringContaining("settings were saved, but the bash timeout update was not confirmed") },
  });
});
