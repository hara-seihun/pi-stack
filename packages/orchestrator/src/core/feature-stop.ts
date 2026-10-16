import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CoreScope } from "./contracts.js";
export type SharedCustodyFlag = { state: "enabled" | "disabled" } | { state: "unavailable"; message: string };
export function sharedCustodyFlag(scope: Pick<CoreScope, "environment" | "resources">, path: (logical: string) => string): SharedCustodyFlag {
  const file = scope.environment.PI_STACK_HOST_CONFIG;
  if (typeof file !== "string" || !isAbsolute(file) || resolve(file) !== file || /[\0\r\n]/.test(file) || !scope.resources.some(resource => resource.path === file && resource.kind === "file")) return { state: "unavailable", message: "Shared custody requires its explicit registered host feature file" };
  try {
    const actual = path(file), stat = statSync(actual);
    if (!stat.isFile() || stat.size > 65536) return { state: "unavailable", message: "Shared custody host feature file is invalid" };
    const config = JSON.parse(readFileSync(actual, "utf8"));
    if (config?.oneKenan === true) return { state: "enabled" };
    if (config?.oneKenan === false) return { state: "disabled" };
    return { state: "unavailable", message: "Shared custody oneKenan flag is unset or invalid" };
  } catch { return { state: "unavailable", message: "Shared custody host feature file is unreadable" }; }
}
