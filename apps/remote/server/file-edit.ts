import { execFile } from "node:child_process";
import { join } from "node:path";
import { API_CORS_HEADERS } from "./cors";
import type { FileEditSnapshot } from "./protocol";

type EditResult = { ok: true; value: FileEditSnapshot } | { ok: false; status: number; error: string };
const MAX_REQUEST_BYTES = 6 * 1_048_576 + 4096;

function invokeEditor(body: unknown, backupDirectory: string): Promise<EditResult> {
  return new Promise(resolve => {
    let inputFailed = false;
    const child = execFile("python3", [join(import.meta.dir, "file-edit.py"), backupDirectory], {
      timeout: 10_000, maxBuffer: MAX_REQUEST_BYTES + 4096,
    }, (failure, stdout) => {
      if (failure || inputFailed) {
        resolve({ ok: false, status: 500, error: "File edit was not confirmed. Reload before retrying; interrupted-save backups may require recovery." });
        return;
      }
      try { resolve(JSON.parse(stdout) as EditResult); }
      catch { resolve({ ok: false, status: 500, error: "Invalid file edit result; reload before retrying" }); }
    });
    child.stdin?.on("error", () => { inputFailed = true; });
    child.stdin?.end(JSON.stringify(body));
  });
}

export async function fileEditResponse(req: Request, backupDirectory: string): Promise<Response> {
  const reply = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" },
  });
  let body: unknown;
  if (req.method === "GET") {
    body = { operation: "read", path: new URL(req.url).searchParams.get("path") };
  } else if (req.method === "PUT") {
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
      return reply({ error: "JSON content is required" }, 415);
    const reader = req.body?.getReader();
    if (!reader) return reply({ error: "An edit request is required" }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_REQUEST_BYTES) {
          await reader.cancel();
          return reply({ error: "Editing is limited to 1 MiB" }, 413);
        }
        chunks.push(chunk.value);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input))
        return reply({ error: "Invalid edit request" }, 400);
      body = { operation: "save", path: input.path, content: input.content, revision: input.revision };
    } catch { return reply({ error: "Invalid edit request" }, 400); }
    finally { reader.releaseLock(); }
  } else return reply({ error: "Method not allowed" }, 405);
  const result = await invokeEditor(body, backupDirectory);
  return result.ok ? reply(result.value) : reply({ error: result.error }, result.status);
}
