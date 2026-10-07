import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateThreadSettings } from "../src/threads/settings.js";
import { ThreadService, type ImportMessage, type ImportThread } from "../src/threads/service.js";
import type { ThreadSettings } from "../src/threads/contracts.js";

const settings: ThreadSettings = { model: "sol", thinkingLevel: "high", speed: "standard" };
const malformed: unknown[] = [undefined, null, {}, [], "sol", { model: "sol" },
  { thinkingLevel: "high", speed: "standard" }, { model: "sol", speed: "standard" },
  { model: "sol", thinkingLevel: "high" }, { ...settings, model: "" },
  { ...settings, thinkingLevel: "unknown" }, { ...settings, speed: "unknown" },
  { ...settings, unexpected: true }];
const services: ThreadService[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "complete-settings-")); roots.push(root);
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async () => { throw new Error("import validation must not execute a session"); } });
  services.push(service);
  const thread: ImportThread = { id: "thread", title: "Imported", cwd: root,
    sessionFile: join(root, "thread.jsonl"), settings };
  return { service, thread };
}

it("complete settings reject missing or invalid values instead of manufacturing execution preferences", () => {
  for (const input of malformed) expect(validateThreadSettings(input)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(validateThreadSettings(settings)).toMatchObject({ ok: true, value: {
    model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" } });
});

it("malformed external thread settings cannot create an import or pass a runtime-only test", () => {
  const { service, thread } = fixture();
  for (const input of malformed) {
    expect(service.importThread({ ...thread, settings: input } as ImportThread)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(service.get(thread.id)).toBeNull();
  }
  expect(service.importThread(thread)).toMatchObject({ ok: true, value: { settings: {
    model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" } } });
});

it("invalid imported work settings cannot persist work or a fabricated execution", () => {
  const { service, thread } = fixture();
  expect(service.importThread(thread).ok).toBe(true);
  for (const [index, input] of malformed.entries()) {
    if (input === undefined) continue;
    expect(service.importMessage({ id: `work-${index}`, threadId: thread.id, text: "input", state: "dispatched", settings: input } as ImportMessage))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(service.pending(thread.id)).toEqual([]);
    expect(service.get(thread.id)).toMatchObject({ state: "idle", pendingMessages: 0 });
  }
  expect(service.importMessage({ id: "accepted", threadId: thread.id, text: "input", state: "done" }).ok).toBe(true);
});

it("bulk import failure rolls back earlier valid rows rather than leaving a partial recovered state", () => {
  const { service, thread } = fixture();
  expect(service.importState([thread, { ...thread, id: "invalid", settings: {} } as ImportThread], []))
    .toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(service.snapshot()).toEqual([]);
});
