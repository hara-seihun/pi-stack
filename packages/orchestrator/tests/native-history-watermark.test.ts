import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, closeSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureNativeHistoryWatermark, withNativeHistorySuffix, indexedThreadHistory, MAX_HISTORY_RECORD_BYTES,
  type NativeHistoryWatermark, type ThreadHistoryResult, type NativeHistorySuffixRecord } from "../src/threads/history.mjs";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const unwrap = <T>(r: ThreadHistoryResult<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
function source(text = "") {
  const root = mkdtempSync(join(tmpdir(), "native-watermark-")); roots.push(root);
  const path = join(root, "native.jsonl"); writeFileSync(path, text); return path;
}
const header = JSON.stringify({ type: "session", id: "session" });
const image = (id: string) => JSON.stringify({ type: "message", id, parentId: null, message: { role: "assistant", content: [{ type: "text", text: `<pi-remote-image id="${id}" prompt="test" />` }] } });
function giant(path: string, closed = true) {
  const hash = createHash("sha256"), fd = openSync(path, "a");
  const chunks = ['{"type":"message","id":"tool","parentId":null,"message":{"role":"toolResult","content":"', ...Array(160).fill("x".repeat(64 * 1024)), '"}}'];
  try { for (const chunk of chunks) { writeSync(fd, chunk); hash.update(chunk); } if (closed) writeSync(fd, "\n"); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}
function suffix(path: string, watermark: NativeHistoryWatermark) {
  return unwrap(withNativeHistorySuffix(path, watermark, records => [...records]));
}

it("captures >8MiB historic tool records as exact raw offsets/digests without decoding bodies", () => {
  const path = source(`${header}\n`), expectedDigest = giant(path);
  const parse = vi.spyOn(JSON, "parse");
  const watermark = unwrap(captureNativeHistoryWatermark(path));
  expect(parse).not.toHaveBeenCalled();
  expect(watermark.lastOffset).toBe(Buffer.byteLength(header) + 1);
  expect(watermark.lastDigest).toBe(expectedDigest);
  expect(watermark.lastLength).toBeGreaterThan(MAX_HISTORY_RECORD_BYTES);
  expect(watermark.closedOffset).toBe(watermark.size);
  parse.mockRestore();
  expect(indexedThreadHistory(path)).toMatchObject({ ok: false, error: { code: "oversized-record" } });
  appendFileSync(path, `${image("new")}\n`);
  const read = suffix(path, watermark);
  expect(read.value).toHaveLength(1);
  expect(read.value[0]).toMatchObject({ kind: "record", entry: { id: "new" } });
  expect(suffix(path, read.watermark).value).toEqual([]);
  expect(suffix(path, JSON.parse(JSON.stringify(read.watermark))).value).toEqual([]);
});

it("keeps a fixed closed prefix while valid and giant incomplete EOF wait for the next observation", () => {
  const path = source(`${header}\n${image("first")}`);
  const baseline = unwrap(captureNativeHistoryWatermark(path));
  expect(baseline.closedOffset).toBe(Buffer.byteLength(header) + 1);
  expect(suffix(path, baseline).value).toEqual([]);
  appendFileSync(path, "\n");
  const first = suffix(path, baseline);
  expect(first.value[0]).toMatchObject({ kind: "record", entry: { id: "first" } });
  giant(path, false);
  const tail = unwrap(captureNativeHistoryWatermark(path));
  expect(tail.lastDigest).toBe(first.watermark.lastDigest);
  expect(tail.size - tail.closedOffset).toBeGreaterThan(MAX_HISTORY_RECORD_BYTES);
  expect(suffix(path, tail).value).toEqual([]);
  appendFileSync(path, `\n${image("after-giant")}\n`);
  const completed = suffix(path, tail);
  expect(completed.value).toHaveLength(2);
  expect(completed.value[0]).toMatchObject({ kind: "uncertain", error: { code: "oversized-record" } });
  expect(completed.value[1]).toMatchObject({ kind: "record", entry: { id: "after-giant" } });
});

it("returns new oversized or invalid records as uncertainty and continues to later images", () => {
  const path = source(`${header}\n`), baseline = unwrap(captureNativeHistoryWatermark(path));
  giant(path); appendFileSync(path, `not-json\n${image("valid")}\n`);
  const read = suffix(path, baseline);
  expect(read.value.map(record => record.kind)).toEqual(["uncertain", "uncertain", "record"]);
  expect(read.value[0]).toMatchObject({ error: { code: "oversized-record" } });
  expect(read.value[1]).toMatchObject({ error: { code: "invalid-record" } });
  expect(suffix(path, read.watermark).value).toEqual([]);
});

it("rejects untrusted subsets, earlier edits retaining last line, forged boundary hashes and replacement", () => {
  const path = source(`${header}\n${image("last")}\n`), baseline = unwrap(captureNativeHistoryWatermark(path));
  expect(withNativeHistorySuffix(path, { revision: baseline.revision, lastOffset: baseline.lastOffset, lastDigest: baseline.lastDigest } as NativeHistoryWatermark, r => [...r]))
    .toMatchObject({ ok: false, error: { code: "invalid-watermark" } });
  expect(withNativeHistorySuffix(path, { ...baseline, lastDigest: "0".repeat(64) }, r => [...r]))
    .toMatchObject({ ok: false, error: { code: "stale-source" } });
  const fd = openSync(path, "r+"); try { writeSync(fd, Buffer.from("X"), 0, 1, header.indexOf("session\"")); } finally { closeSync(fd); }
  expect(withNativeHistorySuffix(path, baseline, r => [...r])).toMatchObject({ ok: false, error: { code: "stale-source" } });
  writeFileSync(`${path}.replacement`, `${header}\n${image("last")}\n`); renameSync(`${path}.replacement`, path);
  expect(withNativeHistorySuffix(path, baseline, r => [...r])).toMatchObject({ ok: false, error: { code: "stale-source" } });
});

it("captures one byte prefix, allows concurrent append, and expires a projected iterable", () => {
  const path = source(`${header}\n`), baseline = unwrap(captureNativeHistoryWatermark(path));
  appendFileSync(path, `${image("captured")}\n`);
  let escaped!: Iterable<NativeHistorySuffixRecord>;
  const read = unwrap(withNativeHistorySuffix(path, baseline, records => {
    escaped = records; appendFileSync(path, `${image("later")}\n`); return [...records];
  }));
  expect(read.value.map(record => record.kind === "record" ? record.entry.id : "uncertain")).toEqual(["captured"]);
  expect(() => [...escaped]).toThrow("iterable expired");
  expect(suffix(path, read.watermark).value[0]).toMatchObject({ kind: "record", entry: { id: "later" } });
  expect(withNativeHistorySuffix(path, baseline, records => records[Symbol.iterator]().next()))
    .toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
});

it("rejects prefix mutation during projection and reports missing sources without effects", () => {
  const path = source(`${header}\n`), baseline = unwrap(captureNativeHistoryWatermark(path));
  appendFileSync(path, `${image("new")}\n`);
  const read = withNativeHistorySuffix(path, baseline, records => {
    const collected = [...records]; writeFileSync(path, `${header.replace("session", "changed")}\n${image("new")}\n`); return collected;
  });
  expect(read).toMatchObject({ ok: false, error: { code: "stale-source" } });
  expect(captureNativeHistoryWatermark(`${path}.missing`)).toMatchObject({ ok: false, error: { code: "missing" } });
});
