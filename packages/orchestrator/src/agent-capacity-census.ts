import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { openSqlite } from "./sqlite.js";
import { isAgentExecution, configuredAgentCapacityStatus } from "./agent-capacity.js";
import { AgentCapacityAuthority, readAgentCapacityAuthorityConfig, runAgentCapacityAuthority, type CensusEntry } from "./agent-capacity-authority.js";

export interface CapacityCensusPlan {
  host: string;
  barrierId: string;
  owners: { ownerId: string; threadDatabases: string[]; standaloneDirectories: string[]; standaloneRecords: string[] }[];
}
export interface CapacityCensus {
  version: 1; barrierId: string;
  hosts: { host: CapacityCensusPlan["host"]; capturedAt: string; owners: string[] }[];
  entries: (CensusEntry & { source: string; uncertain: boolean })[];
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(path => typeof path === "string" && path.startsWith("/"));
function planFrom(path: string): CapacityCensusPlan {
  const plan = JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8")) as CapacityCensusPlan;
  if (!plan || typeof plan.host !== "string" || !plan.host || typeof plan.barrierId !== "string" || !plan.barrierId
    || !Array.isArray(plan.owners) || !plan.owners.length || plan.owners.some(owner => !owner || typeof owner.ownerId !== "string" || !owner.ownerId
      || !strings(owner.threadDatabases) || !strings(owner.standaloneDirectories) || !strings(owner.standaloneRecords))
    || new Set(plan.owners.map(owner => owner.ownerId)).size !== plan.owners.length) throw new Error("Census plan needs an explicit host, admission barrier identity and every owner/source path");
  return plan;
}
function standaloneRecords(root: string): string[] {
  const records: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) records.push(...standaloneRecords(path));
    else if (entry.isFile() && entry.name === "capacity.json") records.push(path);
  }
  return records;
}
function runnerStatus(control: string): Promise<{ activeSessions: number; activeThreadIds?: string[] } | undefined> {
  return new Promise(resolve => {
    const socket = createConnection(control); let input = "", finished = false;
    const finish = (value?: { activeSessions: number; activeThreadIds?: string[] }) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(), 2_000);
    socket.on("connect", () => socket.write('{"type":"status"}\n'));
    socket.on("error", () => finish()); socket.on("close", () => finish());
    socket.on("data", chunk => {
      input += chunk.toString(); const end = input.indexOf("\n"); if (end < 0) return;
      try {
        const value = JSON.parse(input.slice(0, end));
        if (value.ok !== true || !Number.isSafeInteger(value.activeSessions) || value.activeSessions < 0
          || value.activeThreadIds !== undefined && (!Array.isArray(value.activeThreadIds) || value.activeThreadIds.some((id: unknown) => typeof id !== "string"))) finish();
        else finish(value);
      } catch { finish(); }
    });
  });
}

/** Reads execution receipts, never the misleading thread state='running' projection. Run inside each owner's authorized namespace. */
export async function collectAgentCapacityCensus(plan: CapacityCensusPlan): Promise<CapacityCensus> {
  const entries: CapacityCensus["entries"] = [], controls = new Map<string, Promise<Awaited<ReturnType<typeof runnerStatus>>>>();
  let authorityStatus: ReturnType<typeof configuredAgentCapacityStatus> | undefined;
  const put = (entry: CapacityCensus["entries"][number]) => {
    const prior = entries.find(other => other.agentId === entry.agentId || other.executionId === entry.executionId);
    if (prior && (prior.agentId !== entry.agentId || prior.executionId !== entry.executionId || prior.ownerId !== entry.ownerId)) throw new Error(`Overlapping census execution identities at ${entry.source}; reconcile native custody before cutover`);
    if (!prior) entries.push(entry);
  };
  for (const owner of plan.owners) {
    for (const path of owner.threadDatabases) {
      const db = openSqlite(path, true);
      try {
        const active = db.prepare(`SELECT e.id AS executionId,e.thread_id AS agentId,t.metadata FROM thread_execution e JOIN thread t ON t.id=e.thread_id WHERE e.ended_at IS NULL`).all() as { executionId: string; agentId: string; metadata: string }[];
        for (const row of active) {
          const metadata = JSON.parse(row.metadata);
          // Provider waiting has a durable idle retirement receipt; unfinished work itself is not execution.
          if (metadata.providerWait && !metadata.runnerReference) continue;
          const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_capacity'").get();
          const capacity = table ? db.prepare("SELECT execution_id AS executionId,entered_native,lease_id FROM thread_capacity WHERE thread_id=? AND logical_execution_id=? AND state!='released'").get(row.agentId, row.executionId) as { executionId: string; entered_native: number; lease_id: string | null } | undefined : undefined;
          if (capacity && capacity.entered_native === 0 && capacity.lease_id === null && !metadata.runnerReference) continue;
          put({ agentId: row.agentId, executionId: capacity?.executionId ?? row.executionId, ownerId: owner.ownerId, source: path, uncertain: true });
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_capacity'").get()) {
          const capacity = db.prepare("SELECT thread_id AS agentId,execution_id AS executionId FROM thread_capacity WHERE state!='released' AND (entered_native=1 OR lease_id IS NOT NULL)").all() as { agentId: string; executionId: string }[];
          for (const row of capacity) put({ ...row, ownerId: owner.ownerId, source: path, uncertain: true });
        }
        const retained = db.prepare("SELECT id,metadata FROM thread WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL").all() as { id: string; metadata: string }[];
        for (const row of retained) {
          if (entries.some(entry => entry.agentId === row.id)) continue;
          const reference = JSON.parse(row.metadata).runnerReference;
          if (!reference || typeof reference.control !== "string") throw new Error(`Invalid retained native reference at ${path}`);
          if (!controls.has(reference.control)) controls.set(reference.control, runnerStatus(reference.control));
          const status = await controls.get(reference.control)!;
          if (status?.activeSessions === 0 || status?.activeThreadIds && !status.activeThreadIds.includes(row.id)) continue;
          put({ agentId: row.id, executionId: `native-census:${row.id}`, ownerId: owner.ownerId, source: path, uncertain: true });
        }
      } finally { db.close(); }
    }
    const records = new Set([...owner.standaloneRecords, ...owner.standaloneDirectories.flatMap(standaloneRecords)]);
    for (const path of records) {
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (record.version !== 1 || !isAgentExecution(record) || record.ownerId !== owner.ownerId || typeof record.state !== "string" || !["acquiring", "held", "settled", "released"].includes(record.state)) throw new Error(`Invalid or wrong-owner standalone capacity record at ${path}`);
      if (record.state === "released") continue;
      if (record.state === "acquiring") {
        authorityStatus ??= configuredAgentCapacityStatus();
        const status = await authorityStatus;
        if (status.ok && !status.value.initialized && status.value.active === 0) continue;
      }
      put({ agentId: record.agentId, executionId: record.executionId, ownerId: owner.ownerId, source: path, uncertain: record.state !== "settled" });
    }
  }
  return { version: 1, barrierId: plan.barrierId, hosts: [{ host: plan.host, capturedAt: new Date().toISOString(), owners: plan.owners.map(owner => owner.ownerId) }], entries };
}
function readCensus(path: string): CapacityCensus {
  const census = JSON.parse(readFileSync(path, "utf8")) as CapacityCensus;
  if (!census || census.version !== 1 || typeof census.barrierId !== "string" || !census.barrierId || !Array.isArray(census.hosts) || !census.hosts.length
    || census.hosts.some(host => !host || typeof host.host !== "string" || !host.host || typeof host.capturedAt !== "string" || !Number.isFinite(Date.parse(host.capturedAt)) || !Array.isArray(host.owners) || host.owners.some(id => typeof id !== "string" || !id))
    || !Array.isArray(census.entries) || census.entries.some(entry => !isAgentExecution(entry) || typeof entry.ownerId !== "string" || !entry.ownerId || typeof entry.source !== "string" || typeof entry.uncertain !== "boolean")) throw new Error("Invalid capacity census receipt");
  return census;
}
export function mergeAgentCapacityCensuses(censuses: CapacityCensus[]): CapacityCensus {
  if (!censuses.length || censuses.some(census => census.barrierId !== censuses[0]!.barrierId)) throw new Error("Both hosts must be captured under the same admission barrier");
  const merged: CapacityCensus = { version: 1, barrierId: censuses[0]!.barrierId, hosts: censuses.flatMap(census => census.hosts), entries: censuses.flatMap(census => census.entries) };
  if (new Set(merged.hosts.map(host => host.host)).size !== merged.hosts.length || new Set(merged.entries.map(entry => entry.agentId)).size !== merged.entries.length || new Set(merged.entries.map(entry => entry.executionId)).size !== merged.entries.length) throw new Error("Duplicate host or overlapping census custody");
  return merged;
}
export async function agentCapacityCommand(args: string[]): Promise<void> {
  const [operation, configOrPlan, ...paths] = args;
  const usage = "Usage: pi-agent-capacity serve CONFIG | census PLAN_OR_- | merge HOST_CENSUS HOST_CENSUS | initialize CONFIG GLOBAL_CENSUS";
  if (args.some(arg => arg === "--help" || arg === "-h") || operation === "help") { console.log(usage); return; }
  if (operation === "serve" && configOrPlan && !paths.length) return runAgentCapacityAuthority(configOrPlan);
  if (operation === "census" && configOrPlan && !paths.length) { console.log(JSON.stringify(await collectAgentCapacityCensus(planFrom(configOrPlan)), null, 2)); return; }
  if (operation === "merge" && configOrPlan && paths.length) { console.log(JSON.stringify(mergeAgentCapacityCensuses([configOrPlan, ...paths].map(readCensus)), null, 2)); return; }
  if (operation === "initialize" && configOrPlan && paths.length === 1) {
    const config = readAgentCapacityAuthorityConfig(configOrPlan), census = readCensus(paths[0]!);
    const expectedHosts = new Set(config.owners.map(owner => owner.host));
    if (census.hosts.length !== expectedHosts.size || new Set(census.hosts.map(host => host.host)).size !== expectedHosts.size || census.hosts.some(host => !expectedHosts.has(host.host))) throw new Error("Initial cutover requires every configured host's census receipt");
    const covered = census.hosts.flatMap(host => host.owners.map(id => ({ id, host: host.host })));
    if (covered.length !== config.owners.length || config.owners.some(owner => !covered.some(entry => entry.id === owner.id && entry.host === owner.host))
      || census.entries.some(entry => !config.owners.some(owner => owner.id === entry.ownerId))) throw new Error("Census must explicitly cover every configured owner on both hosts");
    const authority = new AgentCapacityAuthority(config.databasePath);
    try { const result = authority.initialize(census.entries); if (!result.ok) throw new Error(result.error.message); console.log(JSON.stringify(authority.status())); }
    finally { authority.close(); }
    return;
  }
  throw new Error(usage);
}
