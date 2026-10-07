import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { configuredAgentCapacitySettings, type AgentCapacity, type CapacityCustody, type CapacityLease } from "./agent-capacity.js";
import type { Result, ThreadError } from "./threads/contracts.js";

type Identity = { version: 1; ownerId: string; agentId: string; executionId: string; pid: number; processStart: string };
export type StandaloneCapacityRecord = Identity & (
  | { state: "acquiring" }
  | { state: "held" | "settled" | "released"; leaseId: string }
);
export interface StandaloneAgent { settle(): Promise<Result<void>> }
export interface StandaloneAgentOptions { recordPath: string; agentId: string; executionId: string; env?: NodeJS.ProcessEnv; capacity?: AgentCapacity }
const failure = <T>(message: string): Result<T> => ({ ok: false, error: { code: "unavailable", message: `Standalone agent custody: ${message}` } });

function persist(path: string, record: StandaloneCapacityRecord) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function readRecord(path: string): StandaloneCapacityRecord {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.version !== 1 || !["acquiring", "held", "settled", "released"].includes(record.state)
    || ![record.ownerId, record.agentId, record.executionId, record.processStart].every(value => typeof value === "string" && value.length > 0)
    || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || record.state !== "acquiring" && (typeof record.leaseId !== "string" || !record.leaseId)) throw new Error("Invalid durable capacity record");
  return record;
}
function processStart(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function standaloneRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PI_STACK_AGENT_EXECUTIONS_DIR ?? join(homedir(), ".local/state/pi-stack-agent-executions");
  if (!isAbsolute(root)) throw new Error("PI_STACK_AGENT_EXECUTIONS_DIR must be absolute");
  return join(root, randomUUID(), "capacity.json");
}

/** A held record is never recovered by a clock or by an exception. Only its executing owner can settle it. */
export async function beginStandaloneAgent(options: StandaloneAgentOptions): Promise<Result<StandaloneAgent>> {
  const env = options.env ?? process.env;
  const settings = options.capacity
    ? { ok: true as const, value: { capacity: options.capacity, ownerId: env.PI_AGENT_CAPACITY_OWNER } }
    : configuredAgentCapacitySettings(env);
  if (!settings.ok) return settings;
  const { capacity, ownerId } = settings.value;
  if (!ownerId || !options.agentId || !options.executionId || !isAbsolute(options.recordPath)) return failure("explicit owner, agent, execution and absolute record path are required");
  let locked = false;
  const lock = `${options.recordPath}.lock`;
  try {
    mkdirSync(dirname(options.recordPath), { recursive: true, mode: 0o700 });
    if (existsSync(lock) && existsSync(options.recordPath)) {
      const record = readRecord(options.recordPath);
      const holder = JSON.parse(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.processStart !== "string" || !holder.processStart) return failure("invalid lock owner; custody retained");
      if ((record.state === "settled" || record.state === "released") && processStart(holder.pid) !== holder.processStart) unlinkSync(lock);
    }
    const started = processStart(process.pid);
    if (!started) return failure("cannot establish the executing process identity");
    const lockFd = openSync(lock, "wx", 0o600);
    locked = true;
    try { writeFileSync(lockFd, JSON.stringify({ pid: process.pid, processStart: started }) + "\n"); fsyncSync(lockFd); }
    finally { closeSync(lockFd); }
    if (existsSync(options.recordPath)) {
      const prior = readRecord(options.recordPath);
      if (prior.ownerId !== ownerId || prior.agentId !== options.agentId) return failure("agent identity changed; prior custody retained");
      if (prior.state === "held" || prior.state === "acquiring" && prior.executionId !== options.executionId) return failure("prior execution has no settlement proof; custody retained");
      if (prior.state === "settled") {
        const result = await capacity.release(prior);
        if (!result.ok) return result;
        persist(options.recordPath, { ...prior, state: "released" });
      }
      if (prior.state !== "acquiring" && prior.executionId === options.executionId) return failure("execution is already settled; replay its durable output instead of executing again");
    }
    const identity: Identity = { version: 1, ownerId, agentId: options.agentId, executionId: options.executionId, pid: process.pid, processStart: started };
    persist(options.recordPath, { ...identity, state: "acquiring" });
    const acquired = await capacity.acquire({ agentId: identity.agentId, executionId: identity.executionId });
    if (!acquired.ok) return acquired;
    const lease: CapacityLease = acquired.value;
    const custody: CapacityCustody = { agentId: lease.agentId, executionId: lease.executionId, leaseId: lease.leaseId };
    persist(options.recordPath, { ...identity, ...custody, state: "held" });
    locked = false;
    let settled = false;
    let settlement: Promise<Result<void>> | undefined;
    return { ok: true, value: {
      settle() {
        if (settled) return Promise.resolve({ ok: true, value: undefined });
        if (settlement) return settlement;
        const operation = (async (): Promise<Result<void>> => {
          let proven = false;
          try {
            const current = readRecord(options.recordPath);
            if (current.ownerId !== identity.ownerId || current.agentId !== identity.agentId || current.executionId !== identity.executionId) return failure("a later execution owns this record; prior settlement cannot overwrite its custody");
            persist(options.recordPath, { ...identity, ...custody, state: "settled" });
            proven = true;
            const result = await lease.release();
            if (!result.ok) return result;
            persist(options.recordPath, { ...identity, ...custody, state: "released" });
            settled = true;
            return { ok: true, value: undefined };
          } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
          finally { if (proven && existsSync(lock)) unlinkSync(lock); }
        })().catch(error => failure<void>(error instanceof Error ? error.message : String(error)));
        settlement = operation;
        void operation.then(() => { if (settlement === operation) settlement = undefined; });
        return operation;
      },
    } };
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  finally {
    if (locked) {
      try { unlinkSync(lock); }
      catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
    }
  }
}

export function nextStandaloneExecutionId(recordPath: string): string {
  if (!existsSync(recordPath)) return randomUUID();
  const record = readRecord(recordPath);
  return record.state === "acquiring" ? record.executionId : randomUUID();
}

export class StandaloneAdmissionError extends Error {
  constructor(readonly admissionError: ThreadError) { super(admissionError.message); }
}
export async function requireStandaloneAgent(options: StandaloneAgentOptions): Promise<StandaloneAgent> {
  const result = await beginStandaloneAgent(options);
  if (!result.ok) throw new StandaloneAdmissionError(result.error);
  return result.value;
}
export async function settleStandaloneAgent(agent: StandaloneAgent): Promise<void> {
  const result = await agent.settle();
  if (!result.ok) throw new Error(result.error.message);
}
export async function abortAndSettleStandaloneSession(session: { abort(): Promise<void>; isIdle: boolean; isStreaming: boolean; isCompacting: boolean; isRetrying: boolean; dispose(): void }, agent: StandaloneAgent): Promise<void> {
  await session.abort();
  if (!session.isIdle || session.isStreaming || session.isCompacting || session.isRetrying) throw new Error("Native session has not settled; global custody retained");
  session.dispose();
  await settleStandaloneAgent(agent);
}
