import { archivedAcrossOwners } from "./archived.js";
import type { ArchivedThreadsQuery, ArchivedThreadsResult } from "./contracts.js";
import { validateInspectOptions, validateThreadAwait } from "./contracts.js";
import type { ManagerQuestionsRequest, ManagerQuestionsResponse, AnswerThreadQuestion, AskThreadQuestions, QuestionsReceipt, QuestionReceipt, QuestionEvents, QuestionState, ThreadQuestion, AwaitThreads, ThreadAwaitResult, Result, ThreadApi, ThreadControl, ThreadHistory, ThreadInspection, InspectOptions, ThreadSettlements, PiCommand, ThreadList, ThreadMessage, ThreadPage, ThreadRead, SendThread, SpawnThread, Thread } from "./contracts.js";

export interface ThreadOwner { id: string; api: ThreadApi }
const error = (code: "not_found" | "invalid_request" | "conflict", message: string): Result<never> => ({ ok: false, error: { code, message } });

export class ThreadDirectory implements ThreadApi {
  readonly owners: readonly ThreadOwner[];
  constructor(local: ThreadOwner, peers: readonly ThreadOwner[] = []) {
    this.owners = [local, ...peers];
    if (new Set(this.owners.map(owner => owner.id)).size !== this.owners.length) throw new Error("Thread owner IDs must be unique");
  }
  async attention(input: import("./contracts.js").ThreadAttentionRequest): Promise<Result<import("./contracts.js").ThreadAttentionReceipt>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.attention(input) : owner;
  }
  async attentionEvents(after = 0, limit = 100): Promise<Result<import("./contracts.js").ThreadAttentionEvents>> {
    return this.owners[0]!.api.attentionEvents(after, limit);
  }
  async agentWait(input: import("./contracts.js").AgentWaitRequest): Promise<Result<import("./contracts.js").AgentWaitResult>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.agentWait(input) : owner;
  }
  async wakeSchedule(input: import("./contracts.js").ThreadWakeRequest): Promise<Result<import("./contracts.js").ThreadWakeSchedule | null>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.wakeSchedule(input) : owner;
  }
  async watch(input: import("./watch-list.js").WatchRequest): Promise<Result<import("./watch-list.js").WatchResponse>> {
    const person = this.owners.find(owner => owner.id === "person");
    return person ? person.api.watch(input) : { ok: false, error: { code: "unavailable", message: "This person has no unlocked watch list owner" } };
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
  async ask(input: AskThreadQuestions): Promise<Result<QuestionsReceipt>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.ask(input) : owner;
  }
  async questions(threadId: string): Promise<Result<ThreadQuestion[]>> {
    const owner = await this.owner(threadId);
    return owner.ok ? owner.value.api.questions(threadId) : owner;
  }
  async managerQuestions(input: ManagerQuestionsRequest): Promise<Result<ManagerQuestionsResponse>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.managerQuestions(input) : owner;
  }
  async pendingQuestions(input: import("./contracts.js").PendingQuestionsQuery): Promise<Result<import("./contracts.js").PendingQuestions>> {
    const results = await Promise.all(this.owners.map(owner => owner.api.pendingQuestions(input)));
    const value: import("./contracts.js").PendingQuestions = { questions: [], threads: [], errors: [] };
    for (const result of results) {
      if (!result.ok) return result;
      value.questions.push(...result.value.questions);
      value.threads.push(...result.value.threads);
      value.errors.push(...result.value.errors);
    }
    return { ok: true, value };
  }
  async questionState(threadId: string, questionId: string): Promise<Result<QuestionState>> {
    const owner = await this.owner(threadId);
    return owner.ok ? owner.value.api.questionState(threadId, questionId) : owner;
  }
  async answer(input: AnswerThreadQuestion): Promise<Result<QuestionReceipt>> {
    const owner = await this.owner(input.threadId);
    return owner.ok ? owner.value.api.answer(input) : owner;
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
    return owner.value.api.control(input);
  }
  async inspect(threadId: string, options?: InspectOptions): Promise<Result<ThreadInspection>> {
    const valid = validateInspectOptions(options);
    if (!valid.ok) return valid;
    const owner = await this.owner(threadId);
    return owner.ok ? owner.value.api.inspect(threadId, valid.value) : owner;
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
  async questionEvents(after = 0, limit = 100): Promise<Result<QuestionEvents>> {
    return this.owners[0]!.api.questionEvents(after, limit);
  }
  async settlements(after = 0, limit = 100): Promise<Result<ThreadSettlements>> {
    return this.owners[0]!.api.settlements(after, limit);
  }
  archived(input: ArchivedThreadsQuery): Promise<Result<ArchivedThreadsResult>> {
    return archivedAcrossOwners(this.owners.map(owner => owner.api), input);
  }
  async list(input: ThreadList = {}): Promise<Result<ThreadPage>> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return error("invalid_request", "List limit must be 1..1000");
    const query = JSON.stringify({ id: input.id, parentId: input.parentId, state: input.state, archived: input.archived, owners: this.owners.map(owner => owner.id) });
    let position: { owner: number; cursor?: string; query: string } = { owner: 0, query };
    if (input.cursor) {
      try { position = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); }
      catch { return error("invalid_request", "Invalid directory cursor"); }
      if (!position || position.query !== query || !Number.isInteger(position.owner) || position.owner < 0 || position.owner >= this.owners.length) {
        return error("invalid_request", "Cursor does not match this directory query");
      }
    }
    if (input.parentId) {
      const parent = await this.owner(input.parentId);
      if (!parent.ok) return parent;
    }
    const threads: Thread[] = [];
    while (position.owner < this.owners.length && threads.length < limit) {
      const result = await this.owners[position.owner]!.api.list({ ...input, cursor: position.cursor, limit: limit - threads.length });
      if (!result.ok) return result;
      threads.push(...result.value.threads.map(thread => ({ ...thread, ownerId: this.owners[position.owner]!.id })));
      if (input.id && threads.some(thread => thread.id === input.id)) return { ok: true, value: { threads } };
      if (result.value.nextCursor) { position.cursor = result.value.nextCursor; break; }
      position = { owner: position.owner + 1, query };
    }
    return { ok: true, value: { threads, ...(position.owner < this.owners.length
      ? { nextCursor: Buffer.from(JSON.stringify(position)).toString("base64url") } : {}) } };
  }
}
