import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureNativeHistoryWatermark, indexedThreadHistory, parseSession, type ThreadHistoryResult } from "../src/threads/history.mjs";
import { stageNativeHistoryRecordRecovery } from "../src/threads/history-recovery.mjs";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const unwrap = <T>(r: ThreadHistoryResult<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-record-recovery-")); roots.push(root);
  const header = JSON.stringify({ type: "session", id: "session", version: 3, cwd: root });
  const complete = JSON.stringify({ type: "message", id: "lost", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_BODY_NOT_EXPORTED" }] } });
  const fragment = complete.slice(55);
  const next = JSON.stringify({ type: "custom", id: "next", parentId: "lost", customType: "receipt", data: {} });
  const original = `${header}\n${fragment}\n${next}\n`, path = join(root, "native.jsonl"); writeFileSync(path, original);
  const watermark = unwrap(captureNativeHistoryWatermark(path));
  const record = { offset: Buffer.byteLength(header) + 1, length: Buffer.byteLength(fragment), digest: sha(fragment), raw: complete,
    authority: { kind: "resident-native-session" as const, reference: "registered:original-owner", entryId: "lost" } };
  const paths = { quarantinePath: join(root, "evidence.jsonl"), restoredPath: join(root, "restored.jsonl") };
  return { root, path, header, original, complete, fragment, next, watermark, record, paths };
}

it("reports exact closed-record corruption evidence without parser body disclosure", () => {
  const f = fixture(), parsed = indexedThreadHistory(f.path);
  expect(parsed).toMatchObject({ ok: false, error: { code: "invalid-record", line: 2, offset: f.record.offset,
    length: f.record.length, digest: f.record.digest, closed: true, syntax: "json" } });
  expect(JSON.stringify(parsed)).not.toContain("PRIVATE_BODY_NOT_EXPORTED");
  expect(() => parseSession(f.original)).toThrow("line 2: invalid JSON");
  const partial = join(f.root, "partial.jsonl"); writeFileSync(partial, `${f.header}\n${f.fragment}`);
  expect(indexedThreadHistory(partial)).toMatchObject({ ok: true });
});

it("stages exact original-byte evidence plus authoritative prefix restoration without adopting or editing source", () => {
  const f = fixture();
  const receipt = unwrap(stageNativeHistoryRecordRecovery(f.path, f.watermark, [f.record], f.paths));
  expect(receipt.state).toBe("staged-not-adopted");
  expect(readFileSync(f.path, "utf8")).toBe(f.original);
  expect(readFileSync(f.paths.quarantinePath, "utf8")).toBe(f.original);
  expect(readFileSync(f.paths.restoredPath, "utf8")).toBe(`${f.header}\n${f.complete}\n${f.next}\n`);
  expect(receipt.sourceDigest).toBe(sha(f.original));
  expect(statSync(f.paths.quarantinePath).mode & 0o777).toBe(0o600);
  expect(statSync(f.paths.restoredPath).mode & 0o777).toBe(0o600);
  expect(indexedThreadHistory(f.paths.restoredPath)).toMatchObject({ ok: true });
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE_BODY_NOT_EXPORTED");
});

it("refuses guesses, altered content, stale input, valid record replacement and unresolved EOF", () => {
  const f = fixture();
  expect(stageNativeHistoryRecordRecovery(f.path, f.watermark, [{ ...f.record, raw: f.complete.replace("PRIVATE_BODY_NOT_EXPORTED", "fabricated") }], f.paths))
    .toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
  expect(stageNativeHistoryRecordRecovery(f.path, f.watermark, [{ ...f.record, authority: { ...f.record.authority, entryId: "guessed" } }], f.paths))
    .toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
  expect(stageNativeHistoryRecordRecovery(f.path, f.watermark, [{ ...f.record, digest: "0".repeat(64) }], f.paths))
    .toMatchObject({ ok: false, error: { code: "stale-source" } });
  expect(stageNativeHistoryRecordRecovery(f.path, f.watermark, [{ ...f.record, offset: 0, length: Buffer.byteLength(f.header), digest: sha(f.header) }], f.paths))
    .toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
  expect(existsSync(f.paths.quarantinePath)).toBe(false); expect(existsSync(f.paths.restoredPath)).toBe(false);
  appendFileSync(f.path, "unclosed");
  expect(stageNativeHistoryRecordRecovery(f.path, f.watermark, [f.record], f.paths)).toMatchObject({ ok: false, error: { code: "stale-source" } });
  const current = unwrap(captureNativeHistoryWatermark(f.path));
  expect(stageNativeHistoryRecordRecovery(f.path, current, [f.record], f.paths)).toMatchObject({ ok: false, error: { code: "invalid-record" } });
});
