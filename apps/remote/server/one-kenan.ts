import { existsSync, readFileSync } from "node:fs";
import type { CustodyResult, CustodyStatus } from "./one-kenan-keys";

export type OneKenanConfig = { version: 1; executionUser: string; custodySocket: string; ports: Record<string, number> };
export function oneKenanConfig(hostFile = process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json"): OneKenanConfig | null {
  if (!existsSync(hostFile) || JSON.parse(readFileSync(hostFile, "utf8")).oneKenan !== true) return null;
  const path = process.env.PI_KENAN_CONFIG ?? "/etc/pi-stack/one-kenan.json";
  const config = JSON.parse(readFileSync(path, "utf8")) as OneKenanConfig;
  if (config.version !== 1 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.executionUser) || !config.custodySocket?.startsWith("/") || !config.ports || Object.values(config.ports).some(port => !Number.isInteger(port) || port <= 0 || port > 65535) || new Set(Object.values(config.ports)).size !== Object.keys(config.ports).length) throw new Error(`${path}: invalid One Kenan configuration`);
  return config;
}
export async function custodyStatus(config: OneKenanConfig): Promise<CustodyStatus | null> {
  try {
    const response = await fetch("http://custody/status", { unix: config.custodySocket, signal: AbortSignal.timeout(1500) } as RequestInit);
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
export async function custodyAuthenticate(config: OneKenanConfig, user: string, key: string): Promise<CustodyResult> {
  try {
    const response = await fetch(`http://custody/authenticate/${encodeURIComponent(user)}`, { unix: config.custodySocket, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }), signal: AbortSignal.timeout(60_000) } as RequestInit);
    const result = await response.json();
    return response.ok && result.ok ? { ok: true } : { ok: false, status: response.status, error: typeof result.error === "string" ? result.error : "Kenan's custody is unavailable" };
  } catch { return { ok: false, status: 503, error: "Kenan's custody is unavailable; no login was granted" }; }
}
