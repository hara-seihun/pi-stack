import { createHash } from "node:crypto";
import type { ArchivedThreadsQuery, ArchivedThreadsResult, Result, Thread, ThreadApi } from "./contracts.js";

export function validateArchivedQuery(input: unknown): Result<ArchivedThreadsQuery> {
  const invalid: Result<never> = { ok: false, error: { code: "invalid_request", message: "Invalid archived-thread query" } };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid;
  const value = input as ArchivedThreadsQuery;
  if (value.kind === "count") return Object.keys(value).length === 1 ? { ok: true, value } : invalid;
  if (value.kind !== "page" || Object.keys(value).some(key => !["kind", "offset", "limit", "query", "conversationsOnly", "order", "revision"].includes(key))
    || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000
    || typeof value.conversationsOnly !== "boolean" || !["activity", "archived"].includes(value.order)
    || value.query !== undefined && (typeof value.query !== "string" || value.query.length > 512)
    || value.revision !== undefined && (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision))) return invalid;
  return { ok: true, value };
}

export function archivedTime(thread: Pick<Thread, "metadata" | "updatedAt">): string {
  return typeof thread.metadata?.archivedAt === "string" ? thread.metadata.archivedAt : new Date(thread.updatedAt).toISOString();
}
export function compareArchivedThreads(left: Thread, right: Thread, order: "activity" | "archived"): number {
  return (order === "activity" ? right.updatedAt - left.updatedAt : archivedTime(right).localeCompare(archivedTime(left)))
    || left.id.localeCompare(right.id);
}

export async function archivedAcrossOwners(owners: readonly Pick<ThreadApi, "archived">[], input: ArchivedThreadsQuery): Promise<Result<ArchivedThreadsResult>> {
  const valid = validateArchivedQuery(input);
  if (!valid.ok) return valid;
  const batch = input.kind === "count" ? 0 : Math.min(1000, Math.max(input.limit, input.offset));
  const firstQuery: ArchivedThreadsQuery = input.kind === "count" ? input : {
    kind: "page", offset: 0, limit: batch, query: input.query, conversationsOnly: input.conversationsOnly, order: input.order,
  };
  const first = await Promise.all(owners.map(owner => owner.archived(firstQuery)));
  let total = 0;
  const buffers: Array<{ owner: Pick<ThreadApi, "archived">; threads: Thread[]; total: number; offset: number; index: number; revision: string }> = [];
  for (const [index, result] of first.entries()) {
    if (!result.ok) return result;
    if (result.value.kind !== input.kind || !Number.isSafeInteger(result.value.total) || result.value.total < 0)
      return { ok: false, error: { code: "unavailable", message: "Thread owner returned invalid archive metadata" } };
    total += result.value.total;
    if (result.value.kind === "page") {
      if (typeof result.value.revision !== "string" || !/^[a-f0-9]{64}$/.test(result.value.revision) || !Array.isArray(result.value.threads)
        || result.value.threads.length > batch || result.value.total > 0 && !result.value.threads.length)
        return { ok: false, error: { code: "unavailable", message: "Thread owner returned invalid archive page" } };
      buffers.push({ owner: owners[index]!, threads: result.value.threads, total: result.value.total, offset: 0, index: 0, revision: result.value.revision });
    }
  }
  if (input.kind === "count") return { ok: true, value: { kind: "count", total } };
  const revision = createHash("sha256").update(JSON.stringify(buffers.map(buffer => buffer.revision))).digest("hex");
  if (input.revision !== undefined && input.revision !== revision) return { ok: false, error: { code: "conflict", message: "Archived threads changed; retry the query" } };
  const threads: Thread[] = [];
  const seen = new Set<string>();
  for (let position = 0; position < Math.min(total, input.offset + input.limit); position++) {
    for (const buffer of buffers) {
      if (buffer.index < buffer.threads.length || buffer.offset + buffer.index >= buffer.total) continue;
      buffer.offset += buffer.index;
      const loaded = await buffer.owner.archived({ ...input, offset: buffer.offset, limit: batch, revision: buffer.revision });
      if (!loaded.ok) return loaded;
      if (loaded.value.kind !== "page" || loaded.value.total !== buffer.total || loaded.value.revision !== buffer.revision || !loaded.value.threads.length)
        return { ok: false, error: { code: "conflict", message: "Archived threads changed while paging; retry the query" } };
      buffer.threads = loaded.value.threads;
      buffer.index = 0;
    }
    const available = buffers.filter(buffer => buffer.index < buffer.threads.length);
    if (!available.length) return { ok: false, error: { code: "unavailable", message: "Thread owner returned an incomplete archive page" } };
    available.sort((left, right) => compareArchivedThreads(left.threads[left.index]!, right.threads[right.index]!, input.order));
    const selected = available[0]!;
    const thread = selected.threads[selected.index]!;
    if (seen.has(thread.id)) return { ok: false, error: { code: "conflict", message: `Archived thread ${thread.id} has two owners` } };
    seen.add(thread.id);
    if (position >= input.offset) threads.push(thread);
    selected.index++;
  }
  return { ok: true, value: { kind: "page", total, revision, threads } };
}
