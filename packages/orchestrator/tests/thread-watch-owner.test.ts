import { expect, test } from "bun:test";
import { ThreadDirectory } from "../src/threads/directory.js";
import { ThreadService } from "../src/threads/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadApi } from "../src/threads/contracts.js";
import type { WatchApi } from "../src/threads/watch-list.js";

const input = { action: "list" as const, threadId: "worker" };
function owner(id: string, custody?: string) {
  let calls = 0;
  const watch: WatchApi = { watch: async () => { calls++; return { ok: false, error: { code: "unavailable", message: custody! } }; } };
  const value = { id, api: {} as ThreadApi, ...(custody ? { watch } : {}) };
  return { value, calls: () => calls };
}
test("watch custody is explicit, not inferred from a person label or manager", async () => {
  const unbound = owner("person"), remote = owner("remote:alice", "alice-custody");
  expect(await new ThreadDirectory(unbound.value).watch(input)).toMatchObject({ ok: false, error: { code: "unavailable", message: "This scope has no adopted watch custodian" } });
  expect(await new ThreadDirectory(remote.value).watch(input)).toMatchObject({ ok: false, error: { message: "alice-custody" } });
  expect(remote.calls()).toBe(1);
});
test("local watch custody wins over peers and a canonical manager relay", async () => {
  const local = owner("remote:alice", "local"), personal = owner("person", "personal"), bob = owner("remote:bob", "bob");
  const directory = new ThreadDirectory(local.value, [personal.value, bob.value], personal.value);
  expect(await directory.watch(input)).toMatchObject({ ok: false, error: { message: "local" } });
  expect(local.calls()).toBe(1); expect(personal.calls()).toBe(0); expect(bob.calls()).toBe(0);
});
test("an open worker controller's detached owned capability never routes back through its directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-owner-"));
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" },
    workersOnly: true, openSession: async () => { throw new Error("No execution in watch custody proof"); } });
  const directory = new ThreadDirectory({ id: "remote:alice", api: service, watch: { watch: value => service.ownedWatch(value) } });
  service.setDirectory(directory);
  try {
    const unbind = service.setWatchList({ watch: async () => ({ ok: true, value: { items: [] } }) });
    expect(await directory.watch(input)).toEqual({ ok: true, value: { items: [] } });
    unbind();
    const detached = { ok: false, error: { code: "unavailable", message: "This scope has no adopted watch custodian" } } as const;
    expect(await directory.watch(input)).toEqual(detached);
    expect(await service.watch(input)).toEqual(detached);
  } finally { await service.detach(); rmSync(root, { recursive: true, force: true }); }
});
test("worker directories delegate only to a unique declared peer custodian", async () => {
  const worker = owner("fleet"), personal = owner("remote:alice", "personal"), other = owner("remote:other", "other");
  expect(await new ThreadDirectory(worker.value, [personal.value]).watch(input)).toMatchObject({ ok: false, error: { message: "personal" } });
  expect(await new ThreadDirectory(worker.value, [personal.value, other.value]).watch(input)).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("multiple peer") } });
  expect(personal.calls()).toBe(1); expect(other.calls()).toBe(0);
});
