import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { Result, ThreadError } from "./threads/contracts.js";

export const GLOBAL_AGENT_LIMIT = 100;
export const AGENT_CAPACITY_AUTHORITY = "pi-stack-global-agents-v1";
export interface AgentExecution { agentId: string; executionId: string }
export interface CapacityCustody extends AgentExecution { leaseId: string }
export interface CapacityLease extends CapacityCustody { release(): Promise<Result<void>> }
export type CapacityObservation = { state: "absent" | "queued" | "released" } | { state: "active"; custody: CapacityCustody };
export interface AgentCapacity {
  acquire(execution: AgentExecution): Promise<Result<CapacityLease>>;
  release(custody: CapacityCustody): Promise<Result<void>>;
  inspect(execution: AgentExecution): Promise<Result<CapacityObservation>>;
  withdraw(execution: AgentExecution): Promise<Result<void>>;
}
export interface AgentCapacityStatus { authority: typeof AGENT_CAPACITY_AUTHORITY; limit: typeof GLOBAL_AGENT_LIMIT; initialized: boolean; active: number; queued: number }
export type CapacityAcquireResult = Result<CapacityCustody>;
const unavailable = <T>(message: string): Result<T> => ({ ok: false, error: { code: "unavailable", message: `Global agent capacity: ${message}`, retryAt: Date.now() + 5_000 } });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
export function isAgentExecution(value: unknown): value is AgentExecution {
  return !!value && typeof value === "object" && text((value as AgentExecution).agentId) && text((value as AgentExecution).executionId);
}
export function isCapacityCustody(value: unknown): value is CapacityCustody {
  return isAgentExecution(value) && text((value as CapacityCustody).leaseId);
}
function isThreadError(value: unknown): value is ThreadError {
  if (!value || typeof value !== "object") return false;
  const error = value as ThreadError;
  return ["invalid_request", "conflict", "unavailable"].includes(error.code) && typeof error.message === "string"
    && (error.retryAt === undefined || typeof error.retryAt === "number" && Number.isFinite(error.retryAt));
}

export type CapacityTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface AgentCapacityClientOptions { url: string; ownerId: string; token: string; transport?: CapacityTransport }
export interface AgentCapacityStatusClient extends AgentCapacity { status(): Promise<Result<AgentCapacityStatus>> }
export function createAgentCapacityClient(options: AgentCapacityClientOptions): AgentCapacityStatusClient {
  const url = new URL(options.url);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !url.port) throw new Error("Agent capacity URL must be an explicit http://HOST:PORT authority");
  if (!text(options.ownerId) || !text(options.token)) throw new Error("Agent capacity owner and credential must be explicit");
  const transport = options.transport ?? fetch;
  async function request(path: string, input?: AgentExecution | CapacityCustody): Promise<Result<unknown>> {
    try {
      const response = await transport(new URL(path, url), { method: input ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
        body: input ? JSON.stringify({ ...input, ownerId: options.ownerId }) : undefined, signal: AbortSignal.timeout(5_000), redirect: "error" });
      const body = await response.json() as { authority?: unknown; result?: unknown };
      if (body.authority !== AGENT_CAPACITY_AUTHORITY || !body.result || typeof body.result !== "object") return unavailable("authority returned an invalid receipt; custody is retained");
      const result = body.result as Result<unknown>;
      if (result.ok === false && isThreadError(result.error)) return result;
      if (response.ok && result.ok === true) return result;
      return unavailable("authority returned an invalid result; custody is retained");
    } catch (error) {
      return unavailable(`authority unreachable (${error instanceof Error ? error.message : String(error)}); custody is retained`);
    }
  }
  const client: AgentCapacityStatusClient = {
    async status() {
      const result = await request("/v1/status");
      if (!result.ok) return result;
      const status = result.value as AgentCapacityStatus | null;
      if (!status || status.authority !== AGENT_CAPACITY_AUTHORITY || status.limit !== GLOBAL_AGENT_LIMIT || typeof status.initialized !== "boolean"
        || !Number.isSafeInteger(status.active) || status.active < 0 || status.active > GLOBAL_AGENT_LIMIT || !Number.isSafeInteger(status.queued) || status.queued < 0) return unavailable("authority returned invalid capacity status");
      return { ok: true, value: status };
    },
    async inspect(execution) {
      const result = await request("/v1/inspect", execution);
      if (!result.ok) return result;
      if (!result.value || typeof result.value !== "object") return unavailable("authority returned an invalid observation");
      const observation = result.value as CapacityObservation;
      if (["absent", "queued", "released"].includes(observation.state)) return { ok: true, value: observation };
      if (observation.state === "active" && isCapacityCustody(observation.custody) && observation.custody.agentId === execution.agentId && observation.custody.executionId === execution.executionId) return { ok: true, value: observation };
      return unavailable("authority returned mismatched observation");
    },
    async withdraw(execution) {
      const result = await request("/v1/withdraw", execution);
      if (!result.ok) return result;
      return result.value === null ? { ok: true, value: undefined } : unavailable("authority did not acknowledge withdrawal");
    },
    async acquire(execution) {
      if (!isAgentExecution(execution)) return { ok: false, error: { code: "invalid_request", message: "Agent and execution identities are required" } };
      const result = await request("/v1/acquire", execution);
      if (!result.ok) return result;
      if (!isCapacityCustody(result.value) || result.value.agentId !== execution.agentId || result.value.executionId !== execution.executionId) return unavailable("authority returned mismatched custody");
      const custody = result.value;
      return { ok: true, value: { ...custody, release: () => client.release(custody) } };
    },
    async release(custody) {
      if (!isCapacityCustody(custody)) return { ok: false, error: { code: "invalid_request", message: "Complete capacity custody is required for release" } };
      const result = await request("/v1/release", custody);
      if (!result.ok) return result;
      if (result.value !== null) return unavailable("authority did not acknowledge release");
      return { ok: true, value: undefined };
    },
  };
  return client;
}

export const AGENT_CAPACITY_CLIENT_CONFIG = "/etc/pi-stack/agent-capacity-client.json";
export interface AgentCapacityClientManifest { authorityUrl: string; owners: { uid: number; ownerId: string; tokenFile: string }[] }
export function configuredAgentCapacitySettings(env: NodeJS.ProcessEnv = process.env): Result<{ capacity: AgentCapacityStatusClient; ownerId: string }> {
  try {
    let url = env.PI_AGENT_CAPACITY_URL, ownerId = env.PI_AGENT_CAPACITY_OWNER, tokenFile = env.PI_AGENT_CAPACITY_TOKEN_FILE;
    const environmentConfigured = [url, ownerId, tokenFile].some(value => value !== undefined);
    if (!environmentConfigured) {
      const path = env.PI_AGENT_CAPACITY_CONFIG ?? AGENT_CAPACITY_CLIENT_CONFIG;
      if (!path.startsWith("/")) return unavailable("Agent capacity client manifest path must be absolute");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as AgentCapacityClientManifest;
      if (!manifest || !text(manifest.authorityUrl) || !Array.isArray(manifest.owners)
        || manifest.owners.some(owner => !owner || !Number.isSafeInteger(owner.uid) || owner.uid < 0 || !text(owner.ownerId) || !text(owner.tokenFile) || !owner.tokenFile.startsWith("/"))
        || new Set(manifest.owners.map(owner => owner.uid)).size !== manifest.owners.length || new Set(manifest.owners.map(owner => owner.ownerId)).size !== manifest.owners.length) return unavailable("Invalid explicit host agent capacity client manifest");
      const owner = manifest.owners.find(owner => owner.uid === userInfo().uid);
      if (!owner) return unavailable("This Unix identity has no registered global agent capacity owner");
      url = manifest.authorityUrl; ownerId = owner.ownerId; tokenFile = owner.tokenFile;
    }
    if (!url || !ownerId || !tokenFile || !tokenFile.startsWith("/")) return unavailable("PI_AGENT_CAPACITY_URL, PI_AGENT_CAPACITY_OWNER and absolute PI_AGENT_CAPACITY_TOKEN_FILE must be configured together");
    return { ok: true, value: { ownerId, capacity: createAgentCapacityClient({ url, ownerId, token: readFileSync(tokenFile, "utf8").trim() }) } };
  } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
}

export async function configuredAgentCapacityStatus(env: NodeJS.ProcessEnv = process.env): Promise<Result<AgentCapacityStatus>> {
  const configured = configuredAgentCapacitySettings(env);
  return configured.ok ? configured.value.capacity.status() : configured;
}

/** Missing configuration queues work. There is deliberately no local authority or fail-open path. */
export function configuredAgentCapacity(env: NodeJS.ProcessEnv = process.env): AgentCapacity {
  const configured = configuredAgentCapacitySettings(env);
  if (configured.ok) return configured.value.capacity;
  const error = configured.error;
  return { acquire: async () => ({ ok: false, error }), release: async () => ({ ok: false, error }), inspect: async () => ({ ok: false, error }), withdraw: async () => ({ ok: false, error }) };
}
