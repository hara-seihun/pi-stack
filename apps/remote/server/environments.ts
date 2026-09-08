import { existsSync, readFileSync } from "node:fs";

export function knownEnvironments(
  environment: Record<string, unknown> = process.env,
  hostFile = process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json",
) {
  const own = { id: String(environment.PI_REMOTE_ENVIRONMENT_ID ?? "local"), name: String(environment.PI_REMOTE_ENVIRONMENT_NAME ?? "Local"), baseUrl: "" };
  const declared = existsSync(hostFile) ? JSON.parse(readFileSync(hostFile, "utf8")).environments : undefined;
  if (declared === undefined) return [own];
  if (!Array.isArray(declared) || declared.length === 0) throw new Error(`${hostFile}: environments must be a non-empty list`);
  const ids = new Set<string>();
  return declared.map((entry: { id: string; name?: string; baseUrl?: string }) => {
    if (!entry || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id) || ids.has(entry.id)) throw new Error(`${hostFile}: environments requires unique lowercase ids`);
    ids.add(entry.id);
    const baseUrl = String(entry.baseUrl ?? "").replace(/\/+$/, "");
    if (baseUrl && !/^\/(?!\/)[^?#\\]*$/.test(baseUrl)) throw new Error(`${hostFile}: environment ${entry.id} needs a same-origin path prefix`);
    return { id: entry.id, name: String(entry.name ?? entry.id), baseUrl };
  });
}
