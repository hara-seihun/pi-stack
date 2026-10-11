import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedThreadHistory, quarantinedThreadHistoryPage, type ThreadHistoryResult } from "../src/threads/history.mjs";
import { ThreadService } from "../src/threads/service.js";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const unwrap = <T>(r: ThreadHistoryResult<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
const message = (id: string, parentId: string | null, text: string, extra = {}) => JSON.stringify({ type: "message", id, parentId,
  message: { role: "assistant", content: [{ type: "text", text }], ...extra } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-quarantine-")); roots.push(root);
  const header = JSON.stringify({ type: "session", id: "header" });
  const first = message("before", null, "First intact record");
  const corrupt = 'content":"SECRET_MISSING_PREFIX_DO_NOT_EXPORT"}}';
  const last = message("after", "missing-ancestor", "Remaining intact record", { content: [{ type: "thinking", thinking: "private thought" }, { type: "text", text: "Visible remaining" }] });
  const path = join(root, "session.jsonl"), raw = `${header}\n${first}\n${corrupt}\n${last}\n`;
  writeFileSync(path, raw);
  return { root, path, raw, corrupt, corruptOffset: Buffer.byteLength(`${header}\n${first}\n`) };
}

it("reports closed corruption with exact byte evidence and keeps strict model history unavailable", () => {
  const { path, raw, corrupt, corruptOffset } = fixture(), before = statSync(path);
  expect(indexedThreadHistory(path)).toMatchObject({ ok: false, error: { code: "invalid-record", closed: true,
    line: 3, offset: corruptOffset, length: Buffer.byteLength(corrupt), digest: createHash("sha256").update(corrupt).digest("hex"), syntax: "json" } });
  const page = unwrap(quarantinedThreadHistoryPage(path, { offset: 0, limit: 100 }));
  expect(page.integrity).toMatchObject({ kind: "partial", traversal: "stored-order", ancestry: "unproven", resumeAllowed: false });
  expect(page.entries.map(entry => entry.id)).toEqual(["before", expect.stringContaining("native-gap:"), "after"]);
  expect(page.entries[1]).toMatchObject({ customType: "native_history_gap", details: { offset: corruptOffset, length: Buffer.byteLength(corrupt), line: 3 } });
  expect(JSON.stringify(page)).not.toContain("SECRET_MISSING_PREFIX");
  expect(page.integrity.gaps).toHaveLength(1);
  expect(readFileSync(path, "utf8")).toBe(raw);
  expect(statSync(path).ino).toBe(before.ino);
});

it("pages remaining records truthfully and distinguishes an unclosed append tail from a closed gap", () => {
  const { path, raw } = fixture();
  writeFileSync(path, `${raw}{"incomplete":"SECRET_TAIL`);
  const first = unwrap(quarantinedThreadHistoryPage(path, { offset: 0, limit: 1 }));
  expect(first.entries[0]?.id).toBe("before");
  expect(first.nextCursor).toBe("1");
  expect(first.integrity.gaps).toHaveLength(1);
  expect(first.integrity.unclosedTailBytes).toBeGreaterThan(0);
  const gap = unwrap(quarantinedThreadHistoryPage(path, { offset: 1, limit: 1 }));
  expect(gap.entries[0]?.customType).toBe("native_history_gap");
  const remaining = unwrap(quarantinedThreadHistoryPage(path, { offset: 0, limit: 5, entryId: "after" }));
  expect(remaining.entries).toHaveLength(1);
  expect(remaining.integrity.resumeAllowed).toBe(false);
});

it("thread_read exposes partial integrity and byte custody while continuing visible record projection", async () => {
  const { root, path, raw } = fixture();
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async () => { throw new Error("Observational reads must not construct or resume a model"); } });
  try {
    const imported = service.importThread({ id: "damaged", cwd: root, title: "Damaged native", sessionFile: path,
      settings: { model: "faux/faux", thinkingLevel: "off", speed: "standard" }, metadata: { nativeHistoryRequired: true } });
    expect(imported.ok).toBe(true);
    const page = await service.read({ threadId: "damaged", entryId: "after" });
    expect(page).toMatchObject({ ok: true, value: { integrity: { kind: "partial", resumeAllowed: false }, entries: [{ id: "after", message: { content: [{ type: "text", text: "Visible remaining" }] } }] } });
    expect(readFileSync(path, "utf8")).toBe(raw);
  } finally { await service.detach(); }
});
