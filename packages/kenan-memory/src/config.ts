import { existsSync, readFileSync } from "node:fs";
export function oneKenanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PI_STACK_HOST_CONFIG ?? env.PI_STACK_HOST_FILE;
  if (path === undefined) return false;
  try {
    if (!existsSync(path)) return false;
    const value = JSON.parse(readFileSync(path, "utf8")).oneKenan;
    return value === true;
  } catch { return false; }
}
export function credential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PI_KENAN_MEMORY_TOKEN) return env.PI_KENAN_MEMORY_TOKEN;
  const explicit = env.PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE ?? env.PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE;
  if (explicit !== undefined) return readFileSync(explicit, "utf8").trim();
  if (!env.CREDENTIALS_DIRECTORY) return undefined;
  try { return readFileSync(`${env.CREDENTIALS_DIRECTORY}/kenan-memory-supervisor`, "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
