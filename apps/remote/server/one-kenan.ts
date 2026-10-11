import { existsSync, readFileSync } from "node:fs";
import type { CustodyResult, CustodyStatus } from "./one-kenan-keys";

export type OneKenanConfig = { version: 1; executionUser: string; custodySocket: string; keyVerifier?: string; keyStore?: string };
export function oneKenanConfig(hostFile = process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json"): OneKenanConfig | null {
  if (!existsSync(hostFile) || JSON.parse(readFileSync(hostFile, "utf8")).oneKenan !== true) return null;
  const path = process.env.PI_KENAN_CONFIG ?? "/etc/pi-stack/one-kenan.json";
  const config = JSON.parse(readFileSync(path, "utf8")) as OneKenanConfig;
  if (config.version !== 1 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.executionUser) || !config.custodySocket?.startsWith("/")) throw new Error(`${path}: invalid One Kenan configuration`);
  if (config.keyVerifier !== undefined && !config.keyVerifier.startsWith("/")) throw new Error(`${path}: invalid custody key verifier`);
  if (config.keyStore !== undefined && !config.keyStore.startsWith("/")) throw new Error(`${path}: invalid custody key store`);
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

export async function custodyVerify(config: OneKenanConfig, user: string, key: string): Promise<CustodyResult> {
  const unavailable = (): CustodyResult => ({ ok: false, status: 503, error: "Custody key verification is unavailable; no login was granted" });
  if (!config.keyVerifier) return unavailable();
  if (!key || Buffer.byteLength(key) > 4096 || /[\r\n\0]/.test(key)) return { ok: false, status: 400, error: "Key required" };
  try {
    const child = Bun.spawn([config.keyVerifier], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      child.stdin.write(JSON.stringify({ user, key })); child.stdin.end();
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      if (code !== 0 || Buffer.byteLength(output) > 8192) return unavailable();
      const result: unknown = JSON.parse(output);
      if (!result || typeof result !== "object" || Array.isArray(result)) return unavailable();
      const value = result as Record<string, unknown>;
      if (value.ok === true && Object.keys(value).length === 1) return { ok: true };
      if (value.ok === false && [400, 403, 503].includes(value.status as number) && typeof value.error === "string" && value.error.length > 0 && Object.keys(value).length === 3) return { ok: false, status: value.status as number, error: value.error.replaceAll(key, "[redacted]") };
      return unavailable();
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
  } catch { return unavailable(); }
}
