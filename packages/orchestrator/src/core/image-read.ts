import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { CoreResult } from "./config.js";
import type { CustodyResources } from "./custody-resources.js";

const helper = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./image-read.py" : "../../src/core/image-read.py", import.meta.url));
const program = readFileSync(helper, "utf8");
export type ImageReader = (path: string, allowedRoots: readonly string[], signal: AbortSignal) => Promise<CoreResult<Buffer>>;

export function createImageReader(resources: CustodyResources): ImageReader {
  return async (path, allowedRoots, signal) => {
    try {
      const command = resources.launch(["/usr/bin/python3", "-c", program, path, JSON.stringify(allowedRoots)]);
      return await new Promise<CoreResult<Buffer>>(resolve => {
        execFile(command[0]!, command.slice(1), { encoding: "buffer", env: { PATH: "/usr/bin:/bin", LANG: "C", PYTHONDONTWRITEBYTECODE: "1" }, signal, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 + 4096 }, (error, stdout, stderr) => {
          resolve(error ? { ok: false, error: { code: "unavailable", message: `Owner image read denied or unavailable: ${stderr.toString().trim() || error.message}` } } : { ok: true, value: stdout });
        });
      });
    } catch (cause) {
      return { ok: false, error: { code: "unavailable", message: `Owner image read unavailable: ${String(cause)}` } };
    }
  };
}
