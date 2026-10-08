import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { archivedAcrossOwners } from "../src/threads/archived.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import type { ArchivedThreadsQuery, ThreadApi } from "../src/threads/contracts.js";

it("archive search hydrates only its page and keeps literal Unicode searches, exact totals and source revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-archive-"));
  const service = new ThreadService({ databasePath: ":memory:", sessionsDir: root, capacity: { mode: "unmanaged" },
    openSession: async () => { throw new Error("Archive reads must not start a runtime"); } });
  try {
    const settings = { model: "sol", thinkingLevel: "high" as const, speed: "standard" as const };
    expect(service.importState(Array.from({ length: 200 }, (_,i) => ({ id: String(i).padStart(3, "0"),
      title: i < 3 ? "ÄTHER %_" : "Other archive", parentId: i === 2 ? "000" : null, cwd: root,
      sessionFile: join(root, `${i}.jsonl`), settings, held: true, updatedAt: i + 1,
      metadata: { archived: true, archivedAt: new Date(1000 - i).toISOString() } })), [])).toEqual({ ok: true, value: undefined });
    const get = vi.spyOn(service, "get");
    expect(await service.archived({ kind: "count" })).toEqual({ ok: true, value: { kind: "count", total: 200 } });
    expect(get).not.toHaveBeenCalled();
    const query = { kind: "page" as const, offset: 0, limit: 1, query: "äther %_", conversationsOnly: false, order: "activity" as const };
    const result = await service.archived(query);
    if (!result.ok || result.value.kind !== "page") throw new Error("Expected an archive page");
    expect(result.value.total).toBe(3);
    expect(result.value.threads.map(thread => thread.id)).toEqual(["002"]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(await service.archived({ ...query, conversationsOnly: true })).toMatchObject({ ok: true, value: { total: 2, threads: [{ id: "001" }] } });
    expect(await service.archived({ ...query, offset: 3 })).toMatchObject({ ok: true, value: { total: 3, threads: [] } });
    expect(service.update("001", { archived: false }).ok).toBe(true);
    expect(await service.archived({ ...query, offset: 1, revision: result.value.revision })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await service.archived({ ...query, limit: 0 })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const client = createThreadClient("http://fixture/v1/threads", async (_url, init) =>
      (await threadHttp(service, new Request(String(_url), init)))!);
    expect(await client.archived({ kind: "count" })).toEqual({ ok: true, value: { kind: "count", total: 199 } });
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

it("cross-owner archives are globally sorted and offset without full-history hydration", async () => {
  const calls: Array<{ owner: number; input: ArchivedThreadsQuery }> = [];
  const rows = [Array.from({ length: 1100 }, (_,i) => ({ id: `a-${i}`, updatedAt: 2200 - 2 * i })),
    Array.from({ length: 1100 }, (_,i) => ({ id: `b-${i}`, updatedAt: 2199 - 2 * i }))];
  const owners = rows.map((entries, owner) => ({ archived: async (input: ArchivedThreadsQuery) => {
    calls.push({ owner, input });
    return { ok: true as const, value: input.kind === "count" ? { kind: "count" as const, total: entries.length }
      : { kind: "page" as const, total: entries.length, revision: String(owner + 1).repeat(64), threads: entries.slice(input.offset, input.offset + input.limit) as any[] } };
  } }));
  expect(await archivedAcrossOwners(owners, { kind: "count" })).toEqual({ ok: true, value: { kind: "count", total: 2200 } });
  calls.length = 0;
  const query = { kind: "page" as const, offset: 2050, limit: 3, conversationsOnly: false, order: "activity" as const };
  const result = await archivedAcrossOwners(owners, query);
  if (!result.ok || result.value.kind !== "page") throw new Error("Expected merged archive page");
  expect(result.value.threads.map(thread => thread.id)).toEqual(["a-1025", "b-1025", "a-1026"]);
  expect(calls.every(call => call.input.kind === "page" && call.input.limit <= 1000)).toBe(true);
  expect(calls).toHaveLength(4);
  const directory = new ThreadDirectory({ id: "person", api: owners[0] as unknown as ThreadApi }, [{ id: "fleet", api: owners[1] as unknown as ThreadApi }]);
  expect(await directory.archived({ ...query, offset: 0, revision: result.value.revision })).toMatchObject({ ok: true });
});

it("an unavailable or malformed archive owner never becomes an empty successful archive", async () => {
  const bad = { archived: async () => ({ ok: false as const, error: { code: "unavailable" as const, message: "Fixture owner offline" } }) };
  expect(await archivedAcrossOwners([bad], { kind: "count" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  const incomplete = { archived: async () => ({ ok: true as const, value: { kind: "page" as const, total: 1, revision: "a".repeat(64), threads: [] } }) };
  expect(await archivedAcrossOwners([incomplete], { kind: "page", offset: 0, limit: 1, conversationsOnly: false, order: "activity" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
});
