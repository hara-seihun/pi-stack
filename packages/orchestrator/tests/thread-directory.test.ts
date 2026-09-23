import { describe, expect, it, vi } from "vitest";
import { ThreadDirectory } from "../src/threads/directory.js";
import type { Thread, ThreadApi } from "../src/threads/contracts.js";

function owner(ids: string[]) {
  const api = {
    list: vi.fn(async (input: { id?: string; limit?: number; cursor?: string } = {}) => {
      const selected = input.id ? ids.filter(id => id === input.id) : ids;
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
  it("pages owner records without skipping a boundary or changing filters", async () => {
    const first = owner(["a", "b"]), second = owner(["c", "d"]);
    const directory = new ThreadDirectory({ id: "person", api: first.api }, [{ id: "fleet", api: second.api }]);
    const page = await directory.list({ limit: 3 });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.value.threads.map(thread => thread.id)).toEqual(["a", "b", "c"]);
    const next = await directory.list({ limit: 3, cursor: page.value.nextCursor });
    expect(next).toEqual({ ok: true, value: { threads: [{ id: "d" }] } });
    const mismatched = await directory.list({ parentId: "different", cursor: page.value.nextCursor });
    expect(mismatched.ok).toBe(false);
  });
});
