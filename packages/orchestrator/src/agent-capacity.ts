import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import type { Result, ThreadError } from "./threads/contracts.js";

/** No global execution cap; custody still prevents duplicate execution. */
export const GLOBAL_AGENT_LIMIT = null;
export const AGENT_CAPACITY_AUTHORITY = "pi-stack-global-agents-v1";
export interface AgentExecution { agentId: string; executionId: string }
export interface CapacityCustody extends AgentExecution { leaseId: string }
export interface CapacityLease extends CapacityCustody { release(): Promise<Result<void>> }
export type CapacityObservation = { state: "absent" | "queued" | "released" } | { state: "active"; custody: CapacityCustody };
export type CapacityReleaseClient = Pick<AgentCapacity, "inspect" | "release" | "withdraw">;
export interface CapacityRecovery {
  recordedOwner(execution: AgentExecution): Promise<Result<string | null>>;
  originalOwner(ownerId: string, execution: AgentExecution): Result<CapacityReleaseClient>;
}
export interface AgentCapacity {
  readonly ownerId?: string;
  acquire(execution: AgentExecution): Promise<Result<CapacityLease>>;
  release(custody: CapacityCustody): Promise<Result<void>>;
  inspect(execution: AgentExecution): Promise<Result<CapacityObservation>>;
  withdraw(execution: AgentExecution): Promise<Result<void>>;
}
export interface AgentCapacityStatus { authority: typeof AGENT_CAPACITY_AUTHORITY; limit: number | null; initialized: boolean; active: number; queued: number }
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
export interface AgentCapacityStatusClient extends AgentCapacity {
  status(): Promise<Result<AgentCapacityStatus>>;
  recordedOwner(execution: AgentExecution): Promise<Result<string | null>>;
}
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
    ownerId: options.ownerId,
    async recordedOwner(execution) {
      const result = await request("/v1/recorded-owner", execution);
      if (!result.ok) return result;
      const value = result.value as { kind?: string; ownerId?: string } | null;
      if (value?.kind === "absent") return { ok: true, value: null };
      return value?.kind === "recorded" && text(value.ownerId) ? { ok: true, value: value.ownerId } : unavailable("Invalid original-owner receipt");
    },
    async status() {
      const result = await request("/v1/status");
      if (!result.ok) return result;
      const status = result.value as AgentCapacityStatus | null;
      if (!status || status.authority !== AGENT_CAPACITY_AUTHORITY || (status.limit !== null && (!Number.isSafeInteger(status.limit) || status.limit <= 0)) || typeof status.initialized !== "boolean"
        || !Number.isSafeInteger(status.active) || status.active < 0 || (status.limit !== null && status.active > status.limit) || !Number.isSafeInteger(status.queued) || status.queued < 0) return unavailable("authority returned invalid capacity status");
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
export interface AgentCapacityClientManifest {
  authorityUrl: string; owners: { uid: number; ownerId: string; tokenFile: string }[];
  migration?: { ownerId: string; ownerIds: string[] };
}
export function configuredAgentCapacitySettings(env: NodeJS.ProcessEnv = process.env, identity?: { uid: number }): Result<{ capacity: AgentCapacityStatusClient; ownerId: string }> {
  try {
    let url = env.PI_AGENT_CAPACITY_URL, ownerId = env.PI_AGENT_CAPACITY_OWNER, tokenFile = env.PI_AGENT_CAPACITY_TOKEN_FILE;
    if (identity && (!Number.isSafeInteger(identity.uid) || identity.uid < 0)) return unavailable("Agent capacity requires a valid registered Unix identity");
    if (identity && [url, ownerId, tokenFile].some(value => value !== undefined)) return unavailable("UID-bound capacity must select its owner from the host manifest, not environment credentials");
    const environmentConfigured = [url, ownerId, tokenFile].some(value => value !== undefined);
    if (!environmentConfigured) {
      const path = env.PI_AGENT_CAPACITY_CONFIG ?? AGENT_CAPACITY_CLIENT_CONFIG;
      if (!path.startsWith("/")) return unavailable("Agent capacity client manifest path must be absolute");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as AgentCapacityClientManifest;
      if (!manifest || !text(manifest.authorityUrl) || !Array.isArray(manifest.owners)
        || manifest.owners.some(owner => !owner || !Number.isSafeInteger(owner.uid) || owner.uid < 0 || !text(owner.ownerId) || !text(owner.tokenFile) || !owner.tokenFile.startsWith("/"))
        || new Set(manifest.owners.map(owner => owner.uid)).size !== manifest.owners.length || new Set(manifest.owners.map(owner => owner.ownerId)).size !== manifest.owners.length) return unavailable("Invalid explicit host agent capacity client manifest");
      const owner = manifest.owners.find(owner => owner.uid === (identity ? identity.uid : userInfo().uid));
      if (!owner) return unavailable("This Unix identity has no registered global agent capacity owner");
      url = manifest.authorityUrl; ownerId = owner.ownerId; tokenFile = owner.tokenFile;
    }
    if (!url || !ownerId || !tokenFile || !tokenFile.startsWith("/")) return unavailable("PI_AGENT_CAPACITY_URL, PI_AGENT_CAPACITY_OWNER and absolute PI_AGENT_CAPACITY_TOKEN_FILE must be configured together");
    return { ok: true, value: { ownerId, capacity: createAgentCapacityClient({ url, ownerId, token: readFileSync(tokenFile, "utf8").trim() }) } };
  } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
}

export function configuredCapacityRecovery(env: NodeJS.ProcessEnv, ownsAgent: (agentId: string) => boolean): CapacityRecovery {
  const clients = new Map<string, AgentCapacityStatusClient>();
  function manifest(): AgentCapacityClientManifest {
    if (userInfo().uid !== 0) throw Error("Original-owner recovery requires the privileged Core custodian");
    const path = env.PI_AGENT_CAPACITY_CONFIG ?? AGENT_CAPACITY_CLIENT_CONFIG;
    if (!path.startsWith("/")) throw Error("Original-owner manifest path must be absolute");
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw Error("Original-owner manifest requires protected root custody");
    const value = JSON.parse(readFileSync(path, "utf8")) as AgentCapacityClientManifest;
    if (!value || !Array.isArray(value.owners) || value.owners.some(owner => !owner || !Number.isSafeInteger(owner.uid) || owner.uid < 0
      || !text(owner.ownerId) || !text(owner.tokenFile) || !owner.tokenFile.startsWith("/"))
      || new Set(value.owners.map(owner => owner.uid)).size !== value.owners.length
      || new Set(value.owners.map(owner => owner.ownerId)).size !== value.owners.length) throw Error("Invalid original-owner manifest registration");
    return value;
  }
  function client(ownerId: string): Result<AgentCapacityStatusClient> {
    try {
      const registered = manifest();
      const grant = registered.migration;
      if (!grant || !text(grant.ownerId) || !Array.isArray(grant.ownerIds) || !grant.ownerIds.length
        || new Set(grant.ownerIds).size !== grant.ownerIds.length || !registered.owners.some(owner => owner.uid === 0 && owner.ownerId === grant.ownerId)
        || grant.ownerIds.some(id => !registered.owners.some(owner => owner.ownerId === id))) return unavailable("Original-owner recovery has no valid explicit host migration grant");
      if (ownerId !== grant.ownerId && !grant.ownerIds.includes(ownerId)) return unavailable("Original owner is outside the host migration grant");
      const registration = registered.owners.find(owner => owner.ownerId === ownerId);
      if (!registration) return unavailable("Original capacity owner is not registered");
      let value = clients.get(ownerId);
      if (!value) { value = createAgentCapacityClient({ url: registered.authorityUrl, ownerId, token: readFileSync(registration.tokenFile, "utf8").trim() }); clients.set(ownerId, value); }
      return { ok: true, value };
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
  }
  const allowed = (execution: AgentExecution) => isAgentExecution(execution) && ownsAgent(execution.agentId);
  return {
    async recordedOwner(execution) {
      if (!allowed(execution)) return unavailable("Execution is not owned by this adopted scope");
      try {
        const registered = manifest();
        if (!registered.migration) return unavailable("Original-owner lookup has no explicit host migration grant");
        const migration = client(registered.migration.ownerId);
        return migration.ok ? migration.value.recordedOwner(execution) : migration;
      } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
    },
    originalOwner(ownerId, execution) {
      if (!allowed(execution)) return unavailable("Execution is not owned by this adopted scope");
      const original = client(ownerId); if (!original.ok) return original;
      const exact = (value: AgentExecution) => allowed(value) && value.agentId === execution.agentId && value.executionId === execution.executionId;
      return { ok: true, value: {
        inspect: value => exact(value) ? original.value.inspect(value) : Promise.resolve(unavailable("Recovery execution mismatch")),
        release: value => exact(value) ? original.value.release(value) : Promise.resolve(unavailable("Recovery custody mismatch")),
        withdraw: value => exact(value) ? original.value.withdraw(value) : Promise.resolve(unavailable("Recovery withdrawal mismatch")),
      } };
    },
  };
}

export async function configuredAgentCapacityStatus(env: NodeJS.ProcessEnv = process.env): Promise<Result<AgentCapacityStatus>> {
  const configured = configuredAgentCapacitySettings(env);
  return configured.ok ? configured.value.capacity.status() : configured;
}

/** Missing configuration queues work. There is deliberately no local authority or fail-open path. */
export function configuredAgentCapacity(env: NodeJS.ProcessEnv = process.env, identity?: { uid: number }): AgentCapacity {
  let configured: ReturnType<typeof configuredAgentCapacitySettings> | undefined;
  const current = () => {
    if (!configured?.ok) configured = configuredAgentCapacitySettings(env, identity);
    return configured;
  };
  return {
    get ownerId() { const value = current(); return value.ok ? value.value.ownerId : undefined; },
    async acquire(execution) { const value = current(); return value.ok ? value.value.capacity.acquire(execution) : value; },
    async release(custody) { const value = current(); return value.ok ? value.value.capacity.release(custody) : value; },
    async inspect(execution) { const value = current(); return value.ok ? value.value.capacity.inspect(execution) : value; },
    async withdraw(execution) { const value = current(); return value.ok ? value.value.capacity.withdraw(execution) : value; },
  };
}
