import { existsSync, readFileSync } from "node:fs";
export function oneKenanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PI_STACK_HOST_CONFIG ?? env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json";
  if (!existsSync(path)) return false;
  const value = JSON.parse(readFileSync(path, "utf8")).oneKenan;
  return value === true;
}
export function credential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PI_KENAN_MEMORY_TOKEN) return env.PI_KENAN_MEMORY_TOKEN;
  const path = env.PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE ?? env.PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE
    ?? (env.CREDENTIALS_DIRECTORY ? `${env.CREDENTIALS_DIRECTORY}/kenan-memory-supervisor` : undefined);
  return path ? readFileSync(path, "utf8").trim() : undefined;
}
