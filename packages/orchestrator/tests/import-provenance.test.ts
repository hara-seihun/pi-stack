import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptImportProvenance } from "../src/threads/import-provenance.js";

const faults = vi.hoisted(() => ({ read: "", unlink: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => { if (String(args[0]) === faults.read) throw new Error("Native reads forbidden"); return fs.readFileSync(...args); },
    unlinkSync: (path: string) => { if (path === faults.unlink) throw new Error("Cleanup interrupted"); return fs.unlinkSync(path); },
  };
});
const roots: string[] = [];
afterEach(() => { faults.read = faults.unlink = ""; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-provenance-")); roots.push(root);
  const native = join(root, "root.jsonl");
  const original = [
    { type: "session", version: 3, id: "native-id", cwd: root, timestamp: "2020-01-01T00:00:00Z" },
    { type: "message", id: "other-branch", parentId: null, message: { role: "user", content: "Earlier branch", timestamp: 1 } },
    { type: "message", id: "current-leaf", parentId: null, message: { role: "user", content: "Current branch", timestamp: 2 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  writeFileSync(native, original);
  const thread = { id: "root", sessionFile: native, metadata: { importedFrom: { nativeStateDirectory: root } } };
  return { root, native, original, thread };
}
function lines(path: string, values: unknown[]) { writeFileSync(path, values.map(value => JSON.stringify(value)).join("\n") + "\n"); }
function entries(path: string) { return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)); }

it("preserves unique source facts inertly, deduplicates all native branches and cleans exact representations", () => {
  const { root, native, original, thread } = fixture();
  const journal = join(root, "conversation.jsonl");
  lines(journal, [{ type: "session", id: "root", representation: "portable-activity" },
    { type: "message", id: "p1", parentId: null, message: { role: "user", content: "Earlier branch", timestamp: 1 } },
    { type: "core_branch", id: "fork", parentId: null },
    { type: "message", id: "p2", parentId: "fork", message: { role: "assistant", content: "Unique foreign history", timestamp: 3 } }]);
  writeFileSync(join(root, "transfer.json"), JSON.stringify({ version: 1, sourceCore: "codex", messages: [{ role: "assistant", content: "Unique foreign history", timestamp: 3 }], agents: [{ id: "foreign", name: "Foreign author" }] }));
  lines(join(root, "activity.jsonl"), [{ type: "agent_end", messages: [{ role: "user", content: "Earlier branch", timestamp: 1 }], timestamp: 4 }, { type: "extension_error", error: "Useful failure", timestamp: 5 }]);
  const node = { id: "root", parentId: null, name: "Root", state: "idle", busy: false, sessionFile: native, cwd: root, workspace: { repo: "repo", root: "pool", path: "checkout" }, error: "Prior error", work: { id: "done", status: "complete", task: "Do work", result: "Done", delivered: true } };
  writeFileSync(join(root, "pi-tree.json"), JSON.stringify({ version: 1, rootId: "root", nodes: [node], requests: [["request", "root"]], dispatches: [["done", { state: "accepted", hash: "digest" }]], transferHash: "transfer-digest" }));
  writeFileSync(join(root, "agents.json"), JSON.stringify([{ id: "root", name: "Root", state: "idle" }]));
  const result = adoptImportProvenance({ threads: [thread] });
  expect(result).toMatchObject({ ok: true, value: { metadata: { root: { workspace: node.workspace, executionError: "Prior error", importProvenance: { stateDirs: [root] } } } } });
  expect(existsSync(journal)).toBe(false);
  expect(existsSync(join(root, "pi-tree.json"))).toBe(false);
  const text = readFileSync(native, "utf8");
  expect(text.startsWith(original)).toBe(true);
  const appended = entries(native).slice(3);
  expect(appended[0].parentId).toBe("current-leaf");
  expect(appended.every(entry => entry.type === "custom" && entry.customType === "thread_import_provenance")).toBe(true);
  const facts = appended.flatMap(entry => entry.data.facts);
  expect(facts.filter(fact => fact.kind === "message")).toHaveLength(1);
  expect(text.match(/Unique foreign history/g)).toHaveLength(1);
  expect(facts.some(fact => fact.kind === "activity" && fact.record.error === "Useful failure")).toBe(true);
  expect(facts.some(fact => fact.kind === "activity" && fact.record.messages)).toBe(false);
  expect(text).toContain("transfer-digest");
});

it("retries cleanup without appending provenance twice, then skips all history reads", () => {
  const { root, native, thread } = fixture();
  const source = join(root, "transfer.json");
  writeFileSync(source, JSON.stringify({ version: 1, sourceCore: "pi", messages: [{ role: "user", content: "Unmatched", timestamp: 10 }], agents: [] }));
  faults.unlink = source;
  expect(adoptImportProvenance({ threads: [thread] })).toMatchObject({ ok: false, error: { message: "Cleanup interrupted" } });
  expect(existsSync(source)).toBe(true);
  const saved = readFileSync(native, "utf8");
  faults.unlink = "";
  expect(adoptImportProvenance({ threads: [thread] })).toMatchObject({ ok: true });
  expect(readFileSync(native, "utf8")).toBe(saved);
  faults.read = native;
  expect(adoptImportProvenance({ threads: [thread] })).toEqual({ ok: true, value: { removedFiles: [], metadata: {} } });
});

it("assigns hashed child journals to their existing native child without removing its history", () => {
  const { root, thread } = fixture();
  const child = join(root, "children", "child-id.jsonl"); mkdirSync(join(root, "children"));
  lines(child, [{ type: "session", version: 3, id: "child-native", cwd: root }]);
  const journalDir = join(root, "children", createHash("sha256").update("child-id").digest("hex")); mkdirSync(journalDir);
  lines(join(journalDir, "conversation.jsonl"), [{ type: "session", id: "child-id", representation: "portable-activity" }, { type: "message", id: "p1", message: { role: "assistant", content: "Child provenance" } }]);
  lines(join(journalDir, "activity.jsonl"), [{ type: "extension_error", error: "Child failure" }]);
  expect(adoptImportProvenance({ threads: [thread, { id: "child-id", sessionFile: child }] })).toMatchObject({ ok: true });
  expect(existsSync(child)).toBe(true); expect(existsSync(journalDir)).toBe(false);
  expect(readFileSync(child, "utf8")).toContain("Child failure");
  expect(readFileSync(thread.sessionFile, "utf8")).not.toContain("Child provenance");
});

it.each(["running", "queued", "unexpected"])("does not erase unresolved %s work or change its native file", status => {
  const { root, native, original, thread } = fixture();
  const tree = join(root, "pi-tree.json");
  writeFileSync(tree, JSON.stringify({ nodes: [{ id: "root", busy: false, work: { id: "work", status } }] }));
  expect(adoptImportProvenance({ threads: [thread] })).toMatchObject({ ok: false, error: { message: expect.stringContaining("not settled") } });
  expect(existsSync(tree)).toBe(true); expect(readFileSync(native, "utf8")).toBe(original);
});
