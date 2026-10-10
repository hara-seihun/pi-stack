import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Person } from "./persons";
import { proxyFetch } from "./proxy-fetch";

export const WORK_ACTION_CAPABILITY_HEADER = "x-pi-work-action-capability";
export type WorkActionGrant = { capabilitySha256: string; owner: string; scope: string; sourceEnvironment: string };
export type WorkActionsConfig = { routes: Record<string, { origin: string; capabilityFile: string }>; grants: WorkActionGrant[] };
export type WorkActionsConfigResult = { state: "unset" } | { state: "unavailable" } | { state: "ready"; config: WorkActionsConfig };
type FileResult = { ok: true; text: string } | { ok: false; error: "missing" | "unavailable" };
type TrustedFileReader = (path: string, secret: boolean) => FileResult;
const account = /^[a-z_][a-z0-9_-]{0,63}$/;
const environment = /^[a-z][a-z0-9-]{0,31}$/;
const scope = /^[a-zA-Z0-9_.:/-]{1,200}$/;
const MAX_BODY = 2_100_000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));

function trustedFile(path: string, secret: boolean): FileResult {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path)) return { ok: false, error: "unavailable" };
    let parent = dirname(path);
    for (;;) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return { ok: false, error: "unavailable" };
      if (parent === dirname(parent)) break;
      parent = dirname(parent);
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & (secret ? 0o077 : 0o022)) !== 0 || stat.size > (secret ? 1024 : 65_536)) return { ok: false, error: "unavailable" };
    return { ok: true, text: readFileSync(fd, "utf8") };
  } catch (error) { return { ok: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readWorkActionsConfig(env: NodeJS.ProcessEnv = process.env, read: TrustedFileReader = trustedFile): WorkActionsConfigResult {
  const explicit = env.PI_STACK_WORK_ACTIONS_CONFIG;
  const path = explicit === undefined ? "/etc/pi-stack/work-actions.json" : explicit;
  if (!isAbsolute(path)) return { state: "unavailable" };
  const file = read(path, false);
  if (!file.ok) return { state: explicit === undefined && file.error === "missing" ? "unset" : "unavailable" };
  try {
    const value: unknown = JSON.parse(file.text);
    if (!record(value) || !exact(value, ["routes", "grants"]) || !record(value.routes) || !Array.isArray(value.grants)) return { state: "unavailable" };
    const routes: WorkActionsConfig["routes"] = Object.create(null);
    for (const [user, route] of Object.entries(value.routes)) {
      if (!account.test(user) || !record(route) || !exact(route, ["origin", "capabilityFile"]) || typeof route.origin !== "string" || typeof route.capabilityFile !== "string" || !isAbsolute(route.capabilityFile)) return { state: "unavailable" };
      const origin = new URL(route.origin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return { state: "unavailable" };
      routes[user] = { origin: origin.origin, capabilityFile: route.capabilityFile };
    }
    const grants: WorkActionGrant[] = [];
    const hashes = new Set<string>();
    for (const grant of value.grants) {
      if (!record(grant) || !exact(grant, ["capabilitySha256", "owner", "scope", "sourceEnvironment"]) || typeof grant.capabilitySha256 !== "string" || !/^[a-f0-9]{64}$/.test(grant.capabilitySha256) || hashes.has(grant.capabilitySha256) || typeof grant.owner !== "string" || !account.test(grant.owner) || typeof grant.scope !== "string" || !scope.test(grant.scope) || typeof grant.sourceEnvironment !== "string" || !environment.test(grant.sourceEnvironment)) return { state: "unavailable" };
      hashes.add(grant.capabilitySha256);
      grants.push({ capabilitySha256: grant.capabilitySha256, owner: grant.owner, scope: grant.scope, sourceEnvironment: grant.sourceEnvironment });
    }
    return { state: "ready", config: { routes, grants } };
  } catch { return { state: "unavailable" }; }
}

const denied = (message: string, status: number, error: "unavailable" | "invalid-input" = "unavailable") => Response.json({ ok: false, error, message }, { status });
async function boundedText(body: ReadableStream<Uint8Array> | null): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!body) return { ok: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return { ok: false }; }
      chunks.push(item.value);
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
  } catch { return { ok: false }; }
  finally { reader.releaseLock(); }
}

export async function handleWorkAgentActions(req: Request, peer: { uid: number } | undefined, people: ReadonlyMap<number, string>, person: (user: string) => Person | undefined,
  config: WorkActionsConfigResult, dependencies: { read?: TrustedFileReader; fetch?: typeof proxyFetch } = {}): Promise<Response | null> {
  const user = peer && people.get(peer.uid);
  if (!user || !person(user)) return denied("External actions require the registered local owning Unix identity", 403);
  if (config.state === "unset") return null;
  if (config.state === "unavailable") return denied("Work action route configuration is unavailable; no authority fallback", 503);
  const route = config.config.routes[user];
  if (!route) return null;
  if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/external-actions") return denied("Unknown work action authority route", 404);
  const raw = await boundedText(req.body);
  if (!raw.ok) return denied("Bounded JSON action request required", 400, "invalid-input");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.text);
    if (!record(parsed) || !exact(parsed, ["operation", "input"]) || typeof parsed.operation !== "string" || !["submit", "inspect", "claim", "dispatch", "finish"].includes(parsed.operation) || !record(parsed.input)) return denied("Unsupported scoped work action operation", 400, "invalid-input");
    if (parsed.operation === "inspect" && (typeof parsed.input.id !== "string" || !parsed.input.id.trim())) return denied("Scoped inspection requires an action identity; listing is unavailable", 400, "invalid-input");
    body = parsed;
  } catch { return denied("Invalid action JSON", 400, "invalid-input"); }
  const capability = (dependencies.read ?? trustedFile)(route.capabilityFile, true);
  if (!capability.ok || !/^[A-Za-z0-9_-]{32,512}$/.test(capability.text.trim())) return denied("Work action capability is unavailable; no authority fallback", 503);
  try {
    const response = await (dependencies.fetch ?? proxyFetch)(new URL("/v1/work-external-actions", route.origin).href, {
      method: "POST", headers: { "content-type": "application/json", [WORK_ACTION_CAPABILITY_HEADER]: capability.text.trim() },
      body: JSON.stringify(body), signal: AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]), redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return denied("Work action authority redirects are unavailable; inspect original intent before retrying", 502);
    }
    const result = await boundedText(response.body);
    if (!result.ok) return denied("Canonical work action response unavailable; inspect original intent before retrying", 502);
    const parsed: unknown = JSON.parse(result.text);
    if (!record(parsed) || typeof parsed.ok !== "boolean") return denied("Canonical work action response unavailable; inspect original intent before retrying", 502);
    return Response.json(parsed, { status: response.status });
  } catch { return denied("Canonical work action response unavailable; inspect original intent before retrying", 502); }
}
