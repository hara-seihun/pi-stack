import type { Result } from "./contracts.js";

export function measureJsonBytes(value: unknown, limit: number): Result<number> {
  let bytes = 0;
  const active = new Set<object>();
  const add = (count: number): boolean => { bytes += count; return bytes <= limit; };
  const string = (text: string): boolean => {
    if (!add(Buffer.byteLength(text) + 2)) return false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) { if (!add(1)) return false; }
      else if (code < 32) { if (!add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5)) return false; }
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) index++;
        else if (!add(3)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff && !add(3)) return false;
    }
    return true;
  };
  const omitted = (value: unknown) => value === undefined || typeof value === "function" || typeof value === "symbol";
  const visit = (input: unknown, depth: number): "ok" | "oversized" | "invalid" => {
    if (input === null) return add(4) ? "ok" : "oversized";
    if (typeof input === "string") return string(input) ? "ok" : "oversized";
    if (typeof input === "boolean") return add(input ? 4 : 5) ? "ok" : "oversized";
    if (typeof input === "number") return add(Number.isFinite(input) ? JSON.stringify(input).length : 4) ? "ok" : "oversized";
    if (typeof input !== "object" || depth > 1000 || active.has(input)) return "invalid";
    active.add(input);
    if (!add(2)) return "oversized";
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index++) {
        if (index && !add(1)) return "oversized";
        const result = omitted(input[index]) ? add(4) ? "ok" : "oversized" : visit(input[index], depth + 1);
        if (result !== "ok") return result;
      }
    } else {
      let count = 0;
      for (const [key, entry] of Object.entries(input)) {
        if (omitted(entry)) continue;
        if (count++ && !add(1) || !string(key) || !add(1)) return "oversized";
        const result = visit(entry, depth + 1);
        if (result !== "ok") return result;
      }
    }
    active.delete(input);
    return "ok";
  };
  try {
    const result = visit(value, 0);
    return result === "ok" ? { ok: true, value: bytes }
      : { ok: false, error: { code: result === "oversized" ? "oversized" : "invalid_request", message: result === "oversized" ? "Context transport exceeds its byte limit" : "Context must contain finite-depth, acyclic JSON values" } };
  } catch (error) {
    return { ok: false, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } };
  }
}
