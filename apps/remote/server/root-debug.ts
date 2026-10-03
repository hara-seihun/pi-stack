import { existsSync, readFileSync } from "node:fs";
import { ROOT_ADMIN_HEADER, isMachineAdministrator, rootDebugRoute, rootSessionDenied, type RegisteredPerson } from "../../../packages/kenan-root/src/visibility";

export interface RootDebugConfig { port: number; adminCapabilityFile: string }
export function rootDebugConfig(env: NodeJS.ProcessEnv = process.env): RootDebugConfig | null {
  const host = env.PI_STACK_HOST_CONFIG ?? env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json";
  if (!existsSync(host) || JSON.parse(readFileSync(host, "utf8")).oneKenan !== true) return null;
  const configPath = env.PI_KENAN_CONFIG ?? "/etc/pi-stack/one-kenan.json";
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const port = Number(config.rootPort ?? 18821);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid root Kenan debug port");
  return { port, adminCapabilityFile: env.PI_KENAN_ROOT_ADMIN_CAPABILITY_FILE ?? config.rootAdminCapabilityFile ?? "/var/lib/pi-kenan/root-admin-capability" };
}

export interface RootDebugOptions {
  /** Authenticated router session identity, never a request header/body claim. */
  authenticatedUser: string;
  /** Entries loaded by the router from the root-owned person registry. */
  persons: readonly RegisteredPerson[];
  config: RootDebugConfig | null;
  signal?: AbortSignal;
  readCapability?: (path: string) => string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function rootDebugResponse(request: Request, options: RootDebugOptions): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/admin/root-sessions" && !path.startsWith("/v1/admin/root-sessions/")) return null;
  if (!options.config || !isMachineAdministrator(options.authenticatedUser, options.persons) || !rootDebugRoute(request)) return rootSessionDenied();
  try {
    const capability = (options.readCapability ?? (path => readFileSync(path, "utf8")))(options.config.adminCapabilityFile).trim();
    if (!/^[0-9a-f]{64}$/.test(capability)) return Response.json({ error: "Root debugging is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
    // Construct the upstream request, rather than forwarding client headers or
    // query parameters. A forged admin header or ordinary session token cannot
    // become root authority, and browser credentials never enter the root store.
    const response = await (options.fetch ?? fetch)(`http://127.0.0.1:${options.config.port}${path}`, {
      method: "GET", headers: { [ROOT_ADMIN_HEADER]: capability }, redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
      await response.body?.cancel();
      return Response.json({ error: "Root debugging is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return new Response(response.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Root debugging is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
