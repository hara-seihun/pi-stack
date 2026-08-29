import { join } from "node:path";
import { getCacheDir } from "./cache-dir.js";

export function generatedLogPath(
  prefix: string,
  options: { timestamp?: boolean; extension?: string } = {},
): string {
  const stamp = options.timestamp ? `-${new Date().toISOString().replace(/[:.]/g, "-")}` : "";
  return join(
    getCacheDir() ?? process.cwd(),
    `${prefix}${stamp}-${process.pid}.${options.extension ?? "log"}`,
  );
}
