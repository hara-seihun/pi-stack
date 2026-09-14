import { closeSync, openSync, readSync } from "node:fs";

export function assertPiSessionFile(path: string): void {
  const fd = openSync(path, "r");
  let header: Record<string, unknown> | undefined;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const source = buffer.toString("utf8", 0, size);
    const end = source.indexOf("\n");
    if (end >= 0 || size < buffer.length) {
      try { header = JSON.parse(end < 0 ? source : source.slice(0, end)); }
      catch { /* The format error below also covers malformed headers. */ }
    }
  } finally { closeSync(fd); }
  if (!header || header.type !== "session" || typeof header.id !== "string"
    || !Number.isInteger(header.version) || header.representation !== undefined
    || header.core !== undefined && header.core !== "pi") {
    throw new Error(`Not a native Pi session: ${path}. Import a portable conversation into a new Pi state directory instead.`);
  }
}
