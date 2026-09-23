// Files a client sends to the machine: named safely, never overwriting, and
// streamed to disk. Partial chunked transfers are pruned by the supervisor.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";

export function uploadName(raw: string): string {
  const value = basename(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value || value === "." || value === "..") throw new Error("Valid file name required");
  return value.slice(0, 180);
}

export function availableUploadPath(root: string, name: string): string {
  let candidate = join(root, name);
  if (!existsSync(candidate)) return candidate;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 2; index < 10_000; index++) {
    candidate = join(root, `${stem}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(root, `${stem}-${crypto.randomUUID()}${extension}`);
}

export async function storeUpload(req: Request, requestedName: string, root: string, maxBytes = Infinity) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = availableUploadPath(root, uploadName(requestedName));
  const writer = Bun.file(path).writer();
  let size = 0;
  try {
    const reader = req.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`Attachment exceeds ${maxBytes} bytes`);
        }
        writer.write(value);
      }
    }
    await writer.end();
    return { name: basename(path), path, size };
  } catch (cause) {
    try { await writer.end(); } catch {}
    if (existsSync(path)) unlinkSync(path);
    throw cause;
  }
}
