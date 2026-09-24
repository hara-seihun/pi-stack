import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiRemoteConfig {
  version: 1;
  user?: string;
  displayName?: string;
  environment?: Record<string, string | number | boolean | object>;
}

function configPath(): string {
  if (process.env.PI_REMOTE_CONFIG) return process.env.PI_REMOTE_CONFIG;
  const home = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(home, "pi-remote", "config.json");
}

export function applyLocalConfig(path = configPath()): string {
  let config: PiRemoteConfig;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause: any) {
    throw new Error(`Cannot read Pi Remote config at ${path}: ${cause?.message ?? cause}`);
  }
  if (config?.version !== 1 || !config.environment || typeof config.environment !== "object") {
    throw new Error(`Pi Remote config at ${path} must have version 1 and an environment object`);
  }
  for (const [name, value] of Object.entries(config.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment key in ${path}: ${name}`);
    if (process.env[name] !== undefined) continue;
    process.env[name] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  if (config.user) {
    process.env.PI_REMOTE_SENDER_ID = config.user;
    process.env.PI_REMOTE_SENDER_NAME = config.displayName || config.user;
  }
  return path;
}
