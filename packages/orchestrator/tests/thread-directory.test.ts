import { describe, expect, it, vi } from "vitest";
import { ThreadDirectory } from "../src/threads/directory.js";
import type { Thread, ThreadApi } from "../src/threads/contracts.js";

function owner(ids: string[], parents: Record<string, string> = {}) {
  const api = {
    list: vi.fn(async (input: { id?: string; parentId?: string; limit?: number; cursor?: string } = {}) => {
      const selected = ids.filter(id => (!input.id || id === input.id) && (!input.parentId || parents[id] === input.parentId));
      const offset = Number(input.cursor ?? 0), end = offset + (input.limit ?? 100);
      return { ok: true as const, value: { threads: selected.slice(offset, end).map(id => ({ id } as Thread)), ...(end < selected.length ? { nextCursor: String(end) } : {}) } };
    }),
    control: vi.fn(async () => ({ ok: true as const, value: { id: ids[0] } as Thread })),
  };
  return { api: api as unknown as ThreadApi, calls: api };
}

describe("authorized thread directory", () => {
  it("does not make a known local control depend on fleet availability", async () => {
    const local = owner(["local"]), peer = owner([]);
    peer.calls.list.mockRejectedValue(new Error("must not contact peer"));
    const directory = new ThreadDirectory({ id: "person", api: local.api }, [{ id: "fleet", api: peer.api }]);
    expect((await directory.control({ threadId: "local", action: "stop", descendants: false })).ok).toBe(true);
    expect(peer.calls.list).not.toHaveBeenCalled();
    expect(local.calls.control).toHaveBeenCalledOnce();
  });
  it("resolves known fleet identities locally but never claims a complete child list when another owner is locked", async () => {
    const local = owner(["parent", "a", "b"], { a: "parent", b: "parent" }), locked = owner([]);
    locked.calls.list.mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Personal supervisor locked" } } as never);
    const directory = new ThreadDirectory({ id: "fleet", api: local.api }, [{ id: "person", api: locked.api }]);
    expect(await directory.list({ id: "parent", limit: 100 })).toMatchObject({ ok: true, value: { threads: [{ id: "parent", ownerId: "fleet" }] } });
    expect(locked.calls.list).not.toHaveBeenCalled();
    const first = await directory.list({ parentId: "parent", limit: 2 });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.threads.map(thread => thread.id)).toEqual(["a", "b"]);
    expect(await directory.list({ parentId: "parent", limit: 2, cursor: first.value.nextCursor })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await directory.list({ id: "unknown" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("lists direct children across execution owners and preserves filters through pagination", async () => {
    const person = owner(["parent", "private-child", "unrelated"], { "private-child": "parent", unrelated: "other" });
    const fleet = owner(["worker", "worker-two", "grandchild"], { worker: "parent", "worker-two": "parent", grandchild: "worker" });
    const directory = new ThreadDirectory({ id: "person", api: person.api }, [{ id: "fleet", api: fleet.api }]);
    const first = await directory.list({ parentId: "parent", limit: 2 });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.threads.map(thread => [thread.id, thread.ownerId])).toEqual([["private-child", "person"], ["worker", "fleet"]]);
    const next = await directory.list({ parentId: "parent", limit: 2, cursor: first.value.nextCursor });
    expect(next).toMatchObject({ ok: true, value: { threads: [{ id: "worker-two", ownerId: "fleet" }] } });
    expect(next.ok && next.value.nextCursor).toBeUndefined();
  });
  it("supports the owner's 1000-record batch without expanding the normal 100-record page", async () => {
    const first = owner(Array.from({ length: 600 }, (_,i) => `local-${i}`));
    const second = owner(Array.from({ length: 600 }, (_,i) => `peer-${i}`));
    const directory = new ThreadDirectory({ id: "person", api: first.api }, [{ id: "fleet", api: second.api }]);
    const normal = await directory.list();
    expect(normal).toMatchObject({ ok: true, value: { threads: expect.any(Array) } });
    if (!normal.ok) throw new Error(normal.error.message);
    expect(normal.value.threads).toHaveLength(100);
    const batch = await directory.list({ limit: 1000 });
    if (!batch.ok) throw new Error(batch.error.message);
    expect(batch.value.threads).toHaveLength(1000);
    const last = await directory.list({ limit: 1000, cursor: batch.value.nextCursor });
    if (!last.ok) throw new Error(last.error.message);
    expect(last.value.threads).toHaveLength(200);
    expect(last.value.nextCursor).toBeUndefined();
    expect(new Set([...batch.value.threads, ...last.value.threads].map(thread => thread.id)).size).toBe(1200);
    expect(await directory.list({ limit: 1001 })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
  it("pages owner records without skipping a boundary or changing filters", async () => {
    const first = owner(["a", "b"]), second = owner(["c", "d"]);
    const directory = new ThreadDirectory({ id: "person", api: first.api }, [{ id: "fleet", api: second.api }]);
    const page = await directory.list({ limit: 3 });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.value.threads.map(thread => thread.id)).toEqual(["a", "b", "c"]);
    const next = await directory.list({ limit: 3, cursor: page.value.nextCursor });
    expect(next).toEqual({ ok: true, value: { threads: [{ id: "d", ownerId: "fleet" }] } });
    const mismatched = await directory.list({ parentId: "different", cursor: page.value.nextCursor });
    expect(mismatched.ok).toBe(false);
  });
});
