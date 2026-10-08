import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { readLivePeers, readPeerAncestors, readPeerSession } from "./peer-directory";

function thread(id: string, parentId: string | null = null, archived = false): Thread {
  return { id, parentId, title: id, cwd: "/fixture", sessionFile: "/fixture/native", settings: { model: "sol", thinkingLevel: "high", speed: "standard" },
    admission: "force", state: "idle", held: false, revision: 1, pendingMessages: 0, createdAt: 1, updatedAt: 1,
    metadata: { archived, agentName: id } };
}
function fixture(rows: Thread[]) {
  const calls: Array<{ operation: string; input: any }> = [];
  const api: Pick<ThreadApi, "list" | "archived"> = {
    archived: async input => { calls.push({ operation: "archived", input }); return { ok: true, value: { kind: "count", total: rows.filter(row => row.metadata?.archived).length } }; },
    list: async (input = {}) => {
      calls.push({ operation: "list", input });
      const selected = rows.filter(row => (input.archived !== false || !row.metadata?.archived) && (input.id === undefined || input.id === row.id));
      return { ok: true, value: { threads: selected } };
    },
  };
  return { api, calls };
}

test("ordinary peer refresh reads live rows and an exact count, never archived bodies", async () => {
  const rows = [...Array.from({ length: 2000 }, (_,i) => thread(`archive-${i}`, null, true)), thread("live")];
  const { api, calls } = fixture(rows);
  const result = await readLivePeers(api, () => null, new Map());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect([...result.value.threads.keys()]).toEqual(["live"]);
  expect(result.value.archivedTotal).toBe(2000);
  expect(calls).toEqual([{ operation: "archived", input: { kind: "count" } }, { operation: "list", input: { archived: false, limit: 1000 } }]);
});

test("live and explicitly opened archived children hydrate only missing ancestors and reuse captured parents", async () => {
  const parent = thread("parent", null, true);
  const child = thread("child", "parent");
  const { api, calls } = fixture([parent, child, thread("irrelevant", null, true)]);
  const first = await readLivePeers(api, () => null, new Map());
  if (!first.ok) throw new Error(first.error.message);
  expect([...first.value.threads.keys()]).toEqual(["child", "parent"]);
  expect(calls.filter(call => call.input.id).map(call => call.input.id)).toEqual(["parent"]);
  calls.length = 0;
  const next = await readPeerAncestors(api, [thread("archived-child", "parent", true)], () => null, first.value.threads);
  expect(next.ok).toBe(true);
  expect(calls).toEqual([]);
});

test("direct archived URLs remain accessible without first listing the archive", async () => {
  const { api, calls } = fixture([thread("parent", null, true), thread("archived", "parent", true)]);
  const opened = await readPeerSession(api, "archived", () => null, new Map());
  if (!opened.ok || !opened.value) throw new Error("Expected a requested archive and ancestor");
  expect([...opened.value.keys()]).toEqual(["archived", "parent"]);
  expect(calls.map(call => call.input.id)).toEqual(["archived", "parent"]);
  expect(await readPeerSession(api, "absent", () => null, new Map())).toEqual({ ok: true, value: null });
});

test("failed counts, missing ancestors and duplicate custody stay explicit errors", async () => {
  const { api } = fixture([thread("live", "missing")]);
  expect(await readLivePeers(api, () => null, new Map())).toMatchObject({ ok: false, error: { code: "unavailable" } });
  const duplicate = fixture([thread("duplicate")]);
  expect(await readLivePeers(duplicate.api, id => thread(id), new Map())).toMatchObject({ ok: false, error: { code: "conflict" } });
  const failure: Pick<ThreadApi, "list" | "archived"> = { ...duplicate.api, archived: async () => ({ ok: false, error: { code: "unavailable", message: "Fixture owner unavailable" } }) };
  expect(await readLivePeers(failure, () => null, new Map())).toMatchObject({ ok: false, error: { code: "unavailable" } });
});
