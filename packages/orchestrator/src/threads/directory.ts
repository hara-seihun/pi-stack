import { validateThreadAwait } from "./contracts.js";
import type { AwaitThreads, ThreadAwaitResult, Result, ThreadApi, ThreadControl, ThreadHistory, ThreadInspection, ThreadSettlements, PiCommand, ThreadList, ThreadMessage, ThreadPage, ThreadRead, SendThread, SpawnThread, Thread } from "./contracts.js";

export interface ThreadOwner { id: string; api: ThreadApi }
const error = (code: "not_found" | "invalid_request" | "conflict", message: string): Result<never> => ({ ok: false, error: { code, message } });

export class ThreadDirectory implements ThreadApi {
  readonly owners: readonly ThreadOwner[];
  constructor(local: ThreadOwner, peers: readonly ThreadOwner[] = []) {
    this.owners = [local, ...peers];
    if (new Set(this.owners.map(owner => owner.id)).size !== this.owners.length) throw new Error("Thread owner IDs must be unique");
  }
  async owner(threadId: string): Promise<Result<ThreadOwner>> {
    if (!threadId) return error("invalid_request", "A thread ID is required");
    for (const owner of this.owners) {
      const result = await owner.api.list({ id: threadId, limit: 1 });
      if (!result.ok) return result;
      if (result.value.threads.some(thread => thread.id === threadId)) return { ok: true, value: owner };
    }
    return error("not_found", `Thread ${threadId} was not found`);
  }
  async spawn(input: SpawnThread): Promise<Result<Thread>> {
    if (!input.parentId) return this.owners[0]!.api.spawn(input);
    const owner = await this.owner(input.parentId);
    return owner.ok ? owner.value.api.spawn(input) : owner;
  }
  async send(input: SendThread): Promise<Result<ThreadMessage>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.send(input) : owner;
  }
  async read(input: ThreadRead): Promise<Result<ThreadHistory>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.read(input) : owner;
  }
  async control(input: ThreadControl): Promise<Result<Thread>> {
    const owner = await this.owner(input.threadId);
    if (!owner.ok) return owner;
    const cascade = input.action === "stop" && input.descendants ? { ...input, descendants: false } as const
      : input.action === "update" && input.archived ? { threadId: input.threadId, action: "update", archived: true } as const
      : null;
    if (!cascade) return owner.value.api.control(input);
    // The parent first: holding it closes admission, archiving it stops its own
    // workers, before children in other owners are discovered. An archived
    // conversation takes its workers with it; a finished worker with no
    // conversation above it would otherwise sit in every list for good.
    const root = await owner.value.api.control(input.action === "stop" ? cascade : input);
    let failure: Result<Thread> | undefined = root.ok ? undefined : root;
    const seen = new Set([input.threadId]), queue = [input.threadId];
    for (const parentId of queue) {
      let cursor: string | undefined;
      do {
        const page = await this.list({ parentId, cursor, limit: 100 });
        if (!page.ok) { failure ??= page; break; }
        const children = page.value.threads.filter(thread => !seen.has(thread.id));
        for (const child of children) { seen.add(child.id); queue.push(child.id); }
        const results = await Promise.all(children.map(child => this.owner(child.id).then(childOwner => childOwner.ok ? childOwner.value.api.control({ ...cascade, threadId: child.id }) : childOwner)));
        failure ??= results.find(result => !result.ok);
        cursor = page.value.nextCursor;
      } while (cursor);
    }
    return failure ?? root;
  }
  async inspect(threadId: string): Promise<Result<ThreadInspection>> {
    const owner = await this.owner(threadId);
    return owner.ok ? owner.value.api.inspect(threadId) : owner;
  }
  async command(threadId: string, command: PiCommand): Promise<Result<unknown>> {
    const owner = await this.owner(threadId);
    return owner.ok ? owner.value.api.command(threadId, command) : owner;
  }
  async await(input: AwaitThreads, signal?: AbortSignal): Promise<Result<ThreadAwaitResult>> {
    const valid = validateThreadAwait(input);
    if (!valid.ok) return valid;
    const controller = new AbortController();
    const cancelled: Result<never> = { ok: false, error: { code: "unavailable", message: "Thread await cancelled" } };
    let onAbort: () => void = () => {};
    const aborted = new Promise<Result<ThreadAwaitResult>>(resolve => {
      onAbort = () => { controller.abort(); resolve(cancelled); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const wait = async (): Promise<Result<ThreadAwaitResult>> => {
      if (controller.signal.aborted) return cancelled;
      const resolved = await Promise.all(input.threadIds.map(async threadId => {
        const owner = await this.owner(threadId);
        if (!owner.ok || controller.signal.aborted) return owner.ok ? cancelled : owner;
        const page = await owner.value.api.list({ id: threadId, limit: 1 });
        if (!page.ok) return page;
        const thread = page.value.threads.find(thread => thread.id === threadId);
        if (!thread) return error("not_found", `Thread ${threadId} was not found`);
        if (thread.parentId !== input.parentId) return error("invalid_request", `Thread ${threadId} is not a direct child of ${input.parentId}`);
        return { ok: true as const, value: { owner: owner.value, threadId } };
      }));
      if (controller.signal.aborted) return cancelled;
      const groups = new Map<ThreadOwner, string[]>();
      for (const item of resolved) {
        if (!item.ok) return item;
        const ids = groups.get(item.value.owner) ?? [];
        ids.push(item.value.threadId);
        groups.set(item.value.owner, ids);
      }
      const after = Object.fromEntries([
        ...Object.entries(input.after ?? {}),
        ...input.threadIds.map(threadId => [threadId, input.after && Object.hasOwn(input.after, threadId) ? input.after[threadId]! : 0] as const),
      ]);
      const waits = new Map([...groups].map(([owner, threadIds]) => [owner, owner.api.await({ ...input, threadIds, after }, controller.signal)
        .then(result => ({ owner, result }))]));
      while (waits.size) {
        const { owner, result } = await Promise.race(waits.values());
        waits.delete(owner);
        if (!result.ok) return result;
        if (result.value.settlement) {
          const settlement = result.value.settlement;
          after[settlement.threadId] = settlement.seq;
          return { ok: true, value: { settlement, after, remainingThreadIds: input.threadIds.filter(id => id !== settlement.threadId) } };
        }
      }
      return { ok: true, value: { settlement: null, after, remainingThreadIds: [...input.threadIds] } };
    };
    try { return await Promise.race([wait(), aborted]); }
    finally {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
  async settlements(after = 0, limit = 100): Promise<Result<ThreadSettlements>> {
    return this.owners[0]!.api.settlements(after, limit);
  }
  async list(input: ThreadList = {}): Promise<Result<ThreadPage>> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error("invalid_request", "List limit must be 1..100");
    const query = JSON.stringify({ id: input.id, parentId: input.parentId, state: input.state, owners: this.owners.map(owner => owner.id) });
    let position: { owner: number; cursor?: string; query: string } = { owner: 0, query };
    if (input.cursor) {
      try { position = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); }
      catch { return error("invalid_request", "Invalid directory cursor"); }
      if (!position || position.query !== query || !Number.isInteger(position.owner) || position.owner < 0 || position.owner >= this.owners.length) {
        return error("invalid_request", "Cursor does not match this directory query");
      }
    }
    const threads: Thread[] = [];
    while (position.owner < this.owners.length && threads.length < limit) {
      const result = await this.owners[position.owner]!.api.list({ ...input, cursor: position.cursor, limit: limit - threads.length });
      if (!result.ok) return result;
      threads.push(...result.value.threads);
      if (result.value.nextCursor) { position.cursor = result.value.nextCursor; break; }
      position = { owner: position.owner + 1, query };
    }
    return { ok: true, value: { threads, ...(position.owner < this.owners.length
      ? { nextCursor: Buffer.from(JSON.stringify(position)).toString("base64url") } : {}) } };
  }
}
