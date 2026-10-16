import { openSync, closeSync, readSync, writeSync, fstatSync, statSync, fsyncSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";
import { captureNativeHistoryWatermark, MAX_HISTORY_RECORD_BYTES } from "./history.mjs";
const good = value => ({ ok: true, value });
const bad = (code, path, message) => ({ ok: false, error: { code, path, message } });
const sha = raw => createHash("sha256").update(raw).digest("hex");
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/** Inserts only an exact authoritative missing prefix; never edits or drops an original byte.
 * Outputs are private staged evidence, not an adopted live session. The controller must fence all
 * native writers and explicitly adopt restoredPath after inspecting this receipt. */
export function stageNativeHistoryRecordRecovery(path, watermark, records, paths) {
  if (typeof path !== "string" || !isAbsolute(path) || typeof paths?.quarantinePath !== "string" || !isAbsolute(paths.quarantinePath)
    || typeof paths?.restoredPath !== "string" || !isAbsolute(paths.restoredPath))
    return bad("invalid-descriptor", typeof path === "string" ? path : "", "Recovery requires explicitly selected absolute source and output paths");
  path = resolve(path);
  const quarantinePath = resolve(paths.quarantinePath), restoredPath = resolve(paths.restoredPath);
  if (new Set([path, quarantinePath, restoredPath]).size !== 3) return bad("invalid-descriptor", path, "Recovery paths must be three distinct files");
  const captured = captureNativeHistoryWatermark(path);
  if (!captured.ok) return captured;
  if (!watermark || Object.keys(captured.value).some(key => captured.value[key] !== watermark[key])) return bad("stale-source", path, "Recovery requires the exact current native source watermark");
  if (watermark.closedOffset !== watermark.size) return bad("invalid-record", path, "Incomplete native tail must finish before record recovery");
  if (!Array.isArray(records) || !records.length) return bad("invalid-descriptor", path, "Recovery requires explicit authoritative records");
  let input, quarantine, restored;
  let madeQuarantine = false, madeRestored = false, result;
  try {
    input = openSync(path, "r");
    const before = fstatSync(input, { bigint: true });
    if (stamp(before) !== watermark.revision) return bad("stale-source", path, "Native source changed before recovery staging");
    const repairs = [];
    for (const record of records) {
      if (!record || typeof record !== "object") { result = bad("invalid-descriptor", path, "Recovery requires an explicit native record descriptor"); break; }
      const { offset, length, digest, raw, authority } = record;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_HISTORY_RECORD_BYTES
        || offset + length >= watermark.size || typeof raw !== "string" || Buffer.byteLength(raw) > MAX_HISTORY_RECORD_BYTES || raw.includes("\n")
        || authority?.kind !== "resident-native-session" || typeof authority.reference !== "string" || !authority.reference
        || typeof authority.entryId !== "string" || !authority.entryId) { result = bad("invalid-descriptor", path, "Recovery record requires bounded exact framing and resident native authority"); break; }
      const fragment = Buffer.allocUnsafe(length), delimiter = Buffer.allocUnsafe(1);
      let read = 0;
      while (read < length) { const count = readSync(input, fragment, read, length - read, offset + read); if (!count) break; read += count; }
      if (read !== length || sha(fragment) !== digest || (offset && (readSync(input, delimiter, 0, 1, offset - 1) !== 1 || delimiter[0] !== 10))
        || readSync(input, delimiter, 0, 1, offset + length) !== 1 || delimiter[0] !== 10) { result = bad("stale-source", path, "Corrupt native record framing or digest changed"); break; }
      let wasValid = true;
      try { JSON.parse(fragment.toString("utf8")); } catch { wasValid = false; }
      if (wasValid) { result = bad("invalid-descriptor", path, "Recovery cannot replace a valid native record"); break; }
      const recovered = Buffer.from(raw, "utf8");
      let entry;
      try { entry = JSON.parse(raw); } catch { result = bad("invalid-record", path, "Authoritative recovery record is invalid JSON"); break; }
      if (!entry || entry.id !== authority.entryId || typeof entry.type !== "string" || !entry.type || entry.type === "session"
        || recovered.length <= fragment.length || !recovered.subarray(recovered.length - fragment.length).equals(fragment)) {
        result = bad("invalid-descriptor", path, "Recovery must be an exact native record ending in every original fragment byte"); break;
      }
      repairs.push({ offset, length, digest, authority, prefix: recovered.subarray(0, recovered.length - fragment.length), recoveredDigest: sha(recovered) });
    }
    if (!result) {
      repairs.sort((a, b) => a.offset - b.offset);
      if (repairs.some((repair, index) => index && repair.offset <= repairs[index - 1].offset + repairs[index - 1].length))
        result = bad("invalid-descriptor", path, "Recovery records overlap");
    }
    if (!result) {
      quarantine = openSync(quarantinePath, "wx", 0o600); madeQuarantine = true;
      restored = openSync(restoredPath, "wx", 0o600); madeRestored = true;
      const originalHash = createHash("sha256"), restoredHash = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024);
      const writeAll = (fd, raw) => { for (let written = 0; written < raw.length;) { const count = writeSync(fd, raw, written); if (!count) throw new Error("Recovery staging write made no progress"); written += count; } };
      let position = 0, index = 0;
      while (position < watermark.size) {
        if (repairs[index]?.offset === position) { writeAll(restored, repairs[index].prefix); restoredHash.update(repairs[index].prefix); index++; }
        const next = repairs[index]?.offset ?? watermark.size;
        const count = readSync(input, chunk, 0, Math.min(chunk.length, next - position, watermark.size - position), position);
        if (!count) { result = bad("stale-source", path, "Native source changed during recovery staging"); break; }
        const raw = chunk.subarray(0, count); writeAll(quarantine, raw); writeAll(restored, raw);
        originalHash.update(raw); restoredHash.update(raw); position += count;
      }
      const after = fstatSync(input, { bigint: true }), named = statSync(path, { bigint: true });
      const sourceDigest = originalHash.digest("hex");
      if (!result && (stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || sourceDigest !== watermark.prefixDigest))
        result = bad("stale-source", path, "Native source changed during recovery staging");
      if (!result) {
        fsyncSync(quarantine); fsyncSync(restored);
        for (const directory of new Set([dirname(quarantinePath), dirname(restoredPath)])) {
          const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        result = good({ state: "staged-not-adopted", sourcePath: path, sourceRevision: watermark.revision, sourceDigest,
          quarantinePath, restoredPath, restoredDigest: restoredHash.digest("hex"),
          records: repairs.map(({ prefix, ...repair }) => ({ ...repair, insertedBytes: prefix.length })) });
      }
    }
  } catch (cause) { result = bad("io", path, `Native recovery staging failed: ${cause.code ?? "I/O"}`); }
  finally {
    for (const fd of [input, quarantine, restored]) if (fd !== undefined) try { closeSync(fd); } catch { result = bad("io", path, "Native recovery descriptor close failed"); }
    if (!result?.ok) for (const [file, made] of [[quarantinePath, madeQuarantine], [restoredPath, madeRestored]]) if (made) try { unlinkSync(file); } catch { result = bad("io", path, "Failed recovery staging evidence remains; inspect exact output paths"); }
  }
  return result;
}
