import { stat } from "node:fs/promises";

export const fileWriteGuardProtocol = "file-write-guard-v1";
export const substantialShrinkBytes = 4096;
const failure = (code, message, data = {}) => ({ ok: false, error: { code, message, ...data } });

export async function localFileSize(path) {
  try { return { ok: true, value: (await stat(path)).size }; }
  catch (error) {
    return error.code === "ENOENT" ? { ok: true, value: null }
      : failure("WRITE_INSPECTION_FAILED", `Cannot inspect destination: ${error.message}`);
  }
}

export async function inspectWrite(path, content, overwrite, inspect) {
  if (typeof content !== "string") return failure("WRITE_INVALID_INPUT", "content must be a string");
  if (overwrite !== undefined && (!overwrite || typeof overwrite !== "object" ||
      !Number.isSafeInteger(overwrite.expectedBytes) || overwrite.expectedBytes < 0 ||
      typeof overwrite.reason !== "string" || !overwrite.reason.trim()))
    return failure("WRITE_INVALID_OVERRIDE", "overwrite requires expectedBytes and a nonblank reason");
  if (typeof inspect !== "function") return failure("WRITE_INSPECTION_UNSUPPORTED", "Write operations must provide fileSize before overwrite");
  let observed;
  try { observed = await inspect(path); }
  catch (error) { return failure("WRITE_INSPECTION_FAILED", `Cannot inspect destination: ${error.message}`); }
  if (!observed?.ok) return observed?.error ? observed : failure("WRITE_INSPECTION_FAILED", "Invalid inspection result");
  const previousBytes = observed.value;
  if (previousBytes !== null && (!Number.isSafeInteger(previousBytes) || previousBytes < 0))
    return failure("WRITE_INSPECTION_FAILED", "Inspection must return byte length or null for a missing file");
  if (overwrite !== undefined && previousBytes !== overwrite.expectedBytes)
    return failure("WRITE_OVERRIDE_CONFLICT", "Destination length changed or destination is missing", { previousBytes, expectedBytes: overwrite.expectedBytes });
  const nextBytes = Buffer.byteLength(content, "utf8");
  const destructive = previousBytes !== null && previousBytes > 0 &&
    (content.trim().length === 0 || (previousBytes - nextBytes >= substantialShrinkBytes && nextBytes * 2 <= previousBytes));
  if (destructive && overwrite === undefined)
    return failure("WRITE_DESTRUCTIVE_OVERWRITE_REFUSED", "Refused blanking or substantial shrink. Use append for additions, edit for targeted changes, or overwrite:{expectedBytes,reason} for a deliberate full rewrite.", { previousBytes, nextBytes });
  return { ok: true, value: { previousBytes, nextBytes } };
}

export function requireWriteInspection(result) {
  if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), result.error);
}

export async function environmentFileSize(env, path, context) {
  if (typeof env.fileInfo !== "function") return failure("WRITE_INSPECTION_UNSUPPORTED", "Environment must support fileInfo");
  const info = await env.fileInfo(path, context);
  if (!info.ok) return info.error.code === "not_found" ? { ok: true, value: null }
    : failure("WRITE_INSPECTION_FAILED", info.error.message);
  if (info.value.kind === "symlink") {
    const bytes = await env.readBinaryFile(path, context);
    return bytes.ok ? { ok: true, value: bytes.value.byteLength }
      : failure("WRITE_INSPECTION_FAILED", bytes.error.message);
  }
  return { ok: true, value: info.value.size };
}
