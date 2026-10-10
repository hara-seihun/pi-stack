export const RETELL_ERROR_LIMIT = 8192;
export type RetellErrorBody =
  | { state: "captured"; format: "json" | "text" | "invalid-json"; text: string; truncated: boolean }
  | { state: "empty" | "too-large" | "invalid-encoding" | "unavailable" };
export type RetellProviderError = { status: number; message: string | null; code: string | null; body: RetellErrorBody };
export type RetellFailure = { ok: false; error: string; providerError?: RetellProviderError };
export type RetellResult<T> = { ok: true; value: T } | RetellFailure;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sensitiveKey = /authorization|token|(?:api|private|signing|encryption)[_-]?key|secret|password|credential|llm[_-]?websocket[_-]?url|silent[_-]?url/i;
const bounded = (text: string, bytes: number) => {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
};
function redactor(secrets: readonly string[]) {
  const variants = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    for (const secret of variants) text = text.split(secret).join("[REDACTED]");
    text = text.replace(/\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]/g, escape => JSON.parse(`"${escape}"`) as string);
    for (const secret of variants) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/\bBearer\s+[^\s"'<>;,}]+/gi, "Bearer [REDACTED]")
      .replace(/(\/retell\/silent\/)[a-f0-9]{64}/gi, "$1[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/((?:[\w-]*[_-])?(?:api[_-]?key|access[_-]?token|silent[_-]?token|secret|password|credential|authorization)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi, "$1[REDACTED]");
  };
}
function scrub(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(item => scrub(item, redact));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), sensitiveKey.test(key) ? "[REDACTED]" : scrub(item, redact)]));
  return value;
}
function field(value: unknown, redact: (text: string) => string, bytes: number): string | null {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return null;
  const text = redact(String(value)).trim();
  return text ? bounded(text, bytes) : null;
}
async function readBounded(response: Response): Promise<{ state: "read"; bytes: Uint8Array } | Exclude<RetellErrorBody, { state: "captured" }>> {
  if (!response.body) return { state: "empty" };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { return { state: "unavailable" }; }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > RETELL_ERROR_LIMIT) {
        // Discard oversized bodies: an excerpt could cut an echoed secret in half.
        void reader.cancel().catch(() => {});
        return { state: "too-large" };
      }
      chunks.push(next.value);
    }
    return size === 0 ? { state: "empty" } : { state: "read", bytes: Buffer.concat(chunks, size) };
  } catch { return { state: "unavailable" }; }
  finally { reader.releaseLock(); }
}
export async function retellProviderError(response: Response, secrets: readonly string[]): Promise<RetellProviderError> {
  const read = await readBounded(response);
  if (read.state !== "read") return { status: response.status, message: null, code: null, body: read };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes); }
  catch { return { status: response.status, message: null, code: null, body: { state: "invalid-encoding" } }; }
  const redact = redactor(secrets);
  let format: "json" | "text" | "invalid-json" = "text", message: string | null = null, code: string | null = null;
  if (/\bjson\b/i.test(response.headers.get("content-type") ?? "") || /^[\s]*[\[{]/.test(text)) {
    try {
      const value: unknown = JSON.parse(text);
      if (object(value)) {
        const error = object(value.error) ? value.error : value;
        message = field(error.message ?? value.message ?? value.error_message ?? (typeof value.error === "string" ? value.error : value.detail), redact, 1000);
        code = field(error.code ?? value.code ?? value.error_code, redact, 200);
      }
      text = JSON.stringify(scrub(value, redact)); format = "json";
    } catch { text = redact(text); format = "invalid-json"; }
  } else { text = redact(text); message = field(text, redact, 1000); }
  const captured = bounded(text, RETELL_ERROR_LIMIT);
  return { status: response.status, message, code, body: { state: "captured", format, text: captured, truncated: captured !== text } };
}
