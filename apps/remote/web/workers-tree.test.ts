import { expect, test } from "bun:test";
import type { Session } from "../server/protocol";
import { buildWorkerTree, visibleWorker } from "./src/features/workers/tree-model";

function session(id: string, updates: Partial<Session> = {}): Session {
  return { id, parentId: null, hasChildren: false, origin: "person", model: "model", name: id, cwd: "/", workspaceName: "", environment: "local", state: "idle", held: false, activity: "idle", activeTools: [], provider: "openai", createdAt: "", updatedAt: "2026-01-01T00:00:00.000Z", revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null, ...updates };
}

test("groups roots, links children, and puts active recent work first", () => {
  const tree = buildWorkerTree([
    session("fleet", { origin: "fleet", updatedAt: "2026-01-04T00:00:00.000Z" }),
    session("older", { updatedAt: "2026-01-02T00:00:00.000Z" }),
    session("running", { state: "running", updatedAt: "2026-01-01T00:00:00.000Z" }),
    session("child", { parentId: "older", state: "running" }),
    session("orphan", { parentId: "missing" }),
  ]);
  expect(tree.map(node => node.session.id)).toEqual(["running", "older", "orphan", "fleet"]);
  expect(tree[1].children.map(node => node.session.id)).toEqual(["child"]);
  expect(tree[1].children[0].depth).toBe(1);
  expect(tree[1].activeDescendants).toBe(1);
});

test("Active shows a working parent's settled workers, not a finished tree", () => {
  const [busy, done] = buildWorkerTree([
    session("busy", { state: "running", hasChildren: true }),
    session("settled", { parentId: "busy" }),
    session("grandchild", { parentId: "settled" }),
    session("done", { hasChildren: true, updatedAt: "2025-12-31T00:00:00.000Z" }),
    session("done-worker", { parentId: "done" }),
  ]);
  expect(busy.session.id).toBe("busy");
  expect(visibleWorker(busy, "active")).toBe(true);
  const settled = busy.children[0];
  expect(visibleWorker(settled, "active")).toBe(false);
  expect(visibleWorker(settled, "active", true)).toBe(true);
  expect(visibleWorker(settled.children[0], "active", false)).toBe(false);
  expect(visibleWorker(done, "active")).toBe(false);
  expect(visibleWorker(done.children[0], "active", false)).toBe(false);
  expect(visibleWorker(done, "all")).toBe(true);
});
