import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelAvailabilityStore, modelAvailabilityPath } from "../src/threads/model-availability.js";
import { ThreadService } from "../src/threads/service.js";
import type { Result } from "../src/threads/contracts.js";

const roots: string[] = [], services: ThreadService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "model-availability-")); roots.push(root);
  const store = new ModelAvailabilityStore(join(root, "agent", "model-availability.json"));
  return { root, store };
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function service(root: string, store: ModelAvailabilityStore) {
  const owner = new ThreadService({ databasePath: ":memory:", sessionsDir: join(root, "threads"),
    openSession: async () => { throw new Error("No inference expected"); }, admitNewThread: settings => store.admit(settings.model) });
  services.push(owner); return owner;
}

it("uses one host-global policy path with explicit fixture isolation", () => {
  expect(modelAvailabilityPath({})).toBe("/var/lib/pi-stack/model-availability/policy.json");
  expect(modelAvailabilityPath({ USER: "sybil", HOME: "/home/sybil", PI_AGENT_DIR: "/home/sybil/.pi/agent" })).toBe(modelAvailabilityPath({ USER: "kenan", HOME: "/home/kenan" }));
  expect(modelAvailabilityPath({ PI_STACK_MODEL_AVAILABILITY_PATH: "/tmp/fixture.json" })).toBe("/tmp/fixture.json");
});

it("persists globally readable desired state across owners and closes physical and numbered-alias bypasses", () => {
  const { root, store } = fixture();
  value(store.admit("astra"));
  value(store.set("astra", false));
  value(store.set("anthropic-3/claude-fable-5-1", false));
  expect(statSync(store.path).mode & 0o777).toBe(0o644);
  const other = new ModelAvailabilityStore(store.path);
  for (const model of ["astra", "ASTRA", "gpt-6-astra", "openai-codex/gpt-6-astra", "openai-codex-12/gpt-6-astra", "fable", "anthropic/claude-fable-5-1"])
    expect(other.admit(model)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  value(other.admit("sol"));
  value(other.set("openai-codex-4/gpt-6-astra", true));
  value(store.admit("astra"));
  expect(store.admit("fable").ok).toBe(false);
  value(other.set("astra", true));
  expect(JSON.parse(readFileSync(store.path, "utf8")).disabled).toEqual(["anthropic/claude-fable-5-1"]);
  const separateFixture = new ModelAvailabilityStore(join(root, "another-host.json"));
  value(separateFixture.admit("fable"));
});

it("rejects fresh roots and children without changing existing threads or accepted request receipts", async () => {
  const { root, store } = fixture(), owner = service(root, store);
  const request = { requestId: "existing", id: "existing", cwd: root, settings: { model: "astra" } };
  const existing = value(await owner.spawn(request));
  value(store.set("astra", false));
  expect(value(await owner.spawn(request)).id).toBe(existing.id);
  expect(await owner.spawn({ ...request, id: "rejected", requestId: "rejected" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(owner.get("rejected")).toBeNull();
  const anotherPersonOwner = service(join(root, "another-person"), new ModelAvailabilityStore(store.path));
  expect(await anotherPersonOwner.spawn({ requestId: "global-rejected", cwd: root, settings: { model: "astra" } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  const settings = value(await owner.control({ threadId: existing.id, action: "settings", settings: { thinkingLevel: "low" } }));
  expect(settings.settings.model).toBe("openai-codex/gpt-6-astra");
  expect(settings.settings.thinkingLevel).toBe("low");
  value(store.set("sol", false));
  expect(await owner.spawn({ requestId: "child", cwd: root, parentId: existing.id })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  value(store.set("sol", true));
  const child = value(await owner.spawn({ requestId: "child", cwd: root, parentId: existing.id }));
  expect(child.settings.model).toBe("openai-codex/gpt-6.1-sol");
  value(store.set("astra", true));
  expect((await owner.spawn({ ...request, id: "rejected", requestId: "rejected" })).ok).toBe(true);
});

it("admits new live meetings and their priority workers while Astra and Fable are disabled", async () => {
  const { root, store } = fixture(), owner = service(root, store);
  value(store.set("astra", false));
  value(store.set("fable", false));
  const meeting = value(await owner.spawn({ requestId: "meeting", cwd: root, metadata: { mode: "live" } }));
  expect(meeting).toMatchObject({ admission: "live", settings: { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "low", speed: "priority" } });
  const worker = value(await owner.spawn({ requestId: "worker", cwd: root, parentId: meeting.id }));
  expect(worker).toMatchObject({ admission: "live", settings: { model: "openai-codex/gpt-6-luna", speed: "priority" } });
  const explicit = value(await owner.spawn({ requestId: "explicit", cwd: root, metadata: { mode: "live" },
    settings: { model: "opus", thinkingLevel: "high", speed: "standard" } }));
  expect(explicit.settings).toEqual({ model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" });
  expect(store.admit("astra").ok).toBe(false);
  expect(store.admit("fable").ok).toBe(false);
});

it("fails closed on unreadable policy without rewriting or enabling it", async () => {
  const { root, store } = fixture();
  value(store.set("astra", false));
  writeFileSync(store.path, "broken policy\n");
  const owner = service(root, store);
  expect(store.admit("sol")).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(store.set("astra", true)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(await owner.spawn({ requestId: "broken", cwd: root, settings: { model: "sol" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(readFileSync(store.path, "utf8")).toBe("broken policy\n");
  expect(owner.snapshot()).toEqual([]);
});
