import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolveDelivery, THINKING_LEVELS, THREAD_AWAIT_TIMEOUT_MS, type PiSessionOptions, type Result, type ThreadApi } from "./contracts.js";
import { createThreadClient } from "./http.js";
import { historyPreview } from "./pi-history-preview.js";
import { finalText, readableNotificationText } from "./message-format.js";
import { DELEGATION_POLICY } from "../delegation-policy.js";
import { SUBAGENT_MODEL_DESCRIPTIONS } from "../catalog.js";
import { threadMode } from "./modes.js";
import { SPEEDS } from "./speed.js";
import { threadWaitParameters } from "./wait-contract.js";
import { BACKGROUND_ATTENTION_POLICY } from "./attention-policy.js";

const delivery = Type.Union([Type.Literal("queue"), Type.Literal("steer"), Type.Literal("hardSteer")]);
const agentDelivery = Type.Union([Type.Literal("steer"), Type.Literal("hardSteer")]);
const watchFields = {
  what: Type.String({ minLength: 1, description: "What to check." }),
  why: Type.String({ minLength: 1, description: "Why it matters." }),
  how: Type.Optional(Type.String({ description: "Known way to check it." })),
  cadenceMs: Type.Optional(Type.Integer({ minimum: 60000, description: "Repeat interval in milliseconds; omitted uses the person's default." })),
  nextDueAt: Type.Optional(Type.Integer({ minimum: 0, description: "Next due time as Unix epoch milliseconds; new items default to now." })),
  destination: Type.Optional(Type.String({ minLength: 1, description: "Destination whose workspace and chosen context check this item, such as personal or home; omitted on add uses this thread's own destination." })),
};
const settings = Type.Object({
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map(value => Type.Literal(value)))),
  speed: Type.Optional(Type.Union(SPEEDS.map(value => Type.Literal(value)), { description: "Ultrafast is available for Astra and Sol with an entitled account." })),
});
function result(value: Result<unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, isError: !value.ok };
}

function spawnDefaults(mode: string | undefined): string {
  const declared = threadMode(mode);
  if (!declared) return "Defaults: Sol, standard speed, high thinking; Luna defaults to max.";
  const { model, thinkingLevel, speed } = declared.worker.settings;
  return `This is a ${mode} conversation, so workers default to ${model} at ${thinkingLevel} thinking and ${speed} speed and are admitted immediately; choose Sol only when a worker must synthesize or judge rather than gather.`;
}

export function threadTools(options: PiSessionOptions) {
  function api(signal?: AbortSignal): ThreadApi {
    signal?.throwIfAborted();
    if (options.threads) return options.threads;
    const url = options.env.PI_THREAD_API_URL;
    if (!url) throw new Error("Thread owner is unavailable: PI_THREAD_API_URL is not configured");
    return createThreadClient(url, fetch, { signal, token: options.env.PI_THREAD_TOKEN });
  }
  return [
    defineTool({
      name: "thread_attention", label: "Notify the person",
      description: `Send an explicit notification from your own thread, including while background or scheduled work is running. Attention only notifies: the human opens an agent to place it in the foreground. Durable receipt acceptance is not proof the person's device displayed it. ${BACKGROUND_ATTENTION_POLICY}`,
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 1000, description: "Renia-reduced notification: the important change and what the person needs to do, with deadline/timezone if relevant." }),
      }),
      execute: async (id, input, signal) => result(await api(signal).attention({ ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` })),
    }),
    defineTool({
      name: "thread_title", label: "Name this thread",
      description: "Name your own thread; nothing else names it. Call this during your first turn in a new thread with a short, specific topic title (about 3–7 words, no trailing punctuation) and taskDescription; keep a supplied title when it already fits. Call it again only when the conversation's topic has changed enough that the current title would mislead someone scanning their thread list, not for every new subtopic. If the person has renamed the thread themselves, their title stays and this tool refuses; leave it. Include taskDescription: one short sentence saying what you are trying to accomplish, so the Orchestrator shows the purpose as well as the title. Update both when the task changes. Your agent name is separate and never changes.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 80, description: "The thread's topic title." }), taskDescription: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "One sentence describing the task's intended outcome." })) }),
      execute: async (_id, input, signal) => result(await api(signal).control({ action: "title", threadId: options.threadId, title: input.title, ...(input.taskDescription !== undefined ? { taskDescription: input.taskDescription } : {}) })),
    }),
    defineTool({
      name: "thread_wait", label: "Wait for a named dependency",
      description: "Set or clear your own typed dependency wait as your final tool call; this ends the turn without polling. Name agents (nonempty accessible peer threadIds and optional after cursors), job (jobId), deployment (publicationId), or message (accessible collaborator fromThreadId). Child settlements or collaborator messages resume the same thread. For external jobs/deployments set thread_wake first as recovery. Having finished or being available for assignment is idle: do not set a wait. Messages and wakes may resume scheduling but do not release dependency protection. Both endpoints remain protected against close until you explicitly resolve/release with clear. Clear removes your wait and outgoing dependencies without creating work.",
      parameters: threadWaitParameters,
      execute: async (id, input, signal) => {
        const waited = await api(signal).agentWait({ ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` });
        return { ...result(waited), ...(waited.ok && input.action === "set" && waited.value.metadata?.agentWait ? { terminate: true } : {}) };
      },
    }),
    defineTool({
      name: "thread_wake", label: "Schedule own-thread wakes",
      description: "Set, list, change or cancel one durable periodic recovery check for your own existing thread. Set replaces reason/cadence and retimes nextDueAt (epoch milliseconds, default now+cadence). Due checks coalesce while busy and pause during Stop/archive. Restart-safe ordinary messages resume the same thread through normal model admission; no watch-list item or polling model is created. List shows next due and last durable delivery/landing. Cancel when resolved. Prefer agent settlement events; wakes are fallback checks.",
      parameters: Type.Union([
        Type.Object({ action: Type.Literal("set"), reason: Type.String({ minLength: 1 }), cadenceMs: Type.Integer({ minimum: 60000 }), nextDueAt: Type.Optional(Type.Integer({ minimum: 0 })) }),
        Type.Object({ action: Type.Literal("list") }),
        Type.Object({ action: Type.Literal("cancel") }),
      ]),
      execute: async (id, input, signal) => result(await api(signal).wakeSchedule(input.action === "list"
        ? { action: "list", threadId: options.threadId }
        : { ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` })),
    }),
    defineTool({
      name: "watch_list_add", label: "Add to watch list",
      description: "Add a persistent check to this person's shared encrypted watch list. The watch agent checks due items with its configured model and acts within the person's current life policy; it asks only for decisions that policy leaves with the person. An empty list makes no model calls.",
      parameters: Type.Object(watchFields),
      execute: async (id, item, signal) => result(await api(signal).watch({ action: "add", item, threadId: options.threadId, requestId: `${options.threadId}:${id}` })),
    }),
    defineTool({
      name: "watch_list_update", label: "Update a watch item",
      description: "Change a watch item's check, reason, method, timing or destination. List first to get its ID. Set how or cadenceMs to null to clear it; omitted fields stay unchanged. nextDueAt is epoch milliseconds.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), patch: Type.Object({
        what: Type.Optional(watchFields.what), why: Type.Optional(watchFields.why), nextDueAt: watchFields.nextDueAt, destination: watchFields.destination,
        how: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        cadenceMs: Type.Optional(Type.Union([Type.Integer({ minimum: 60000 }), Type.Null()])),
      }) }),
      execute: async (id, input, signal) => result(await api(signal).watch({ action: "update", ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` })),
    }),
    defineTool({
      name: "watch_list_remove", label: "Remove a watch item",
      description: "Remove a resolved or no-longer-needed check from this person's watch list. List first to get its ID. Any agent may maintain the list.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (id, input, signal) => result(await api(signal).watch({ action: "remove", ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` })),
    }),
    defineTool({
      name: "watch_list", label: "Read watch list",
      description: "List this person's persistent shared watch items, including due times, cadence, provenance and the last checking thread. Does not start an agent.",
      parameters: Type.Object({}),
      execute: async (_id, _input, signal) => result(await api(signal).watch({ action: "list", threadId: options.threadId })),
    }),
    defineTool({
      name: "request_user_input_async", label: "Ask the user asynchronously",
      description: "Post an array of questions for the human and continue working immediately. Put each independently answerable question in its own array item, with its own suggestions; use a one-item array for a single question. Each stays pending after this turn ends and across restarts. Suggestions are optional and may be any number; optionally recommend one by its zero-based index. The human can answer each question separately, choose any number of suggestions and add free text. Each answer arrives as a correlated ordinary user message at a safe turn boundary, without cancelling current work.",
      parameters: Type.Object({ questions: Type.Array(Type.Object({ question: Type.String({ minLength: 1, description: "One independently answerable question." }), suggestions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), recommendedSuggestionIndex: Type.Optional(Type.Integer({ minimum: 0 })) }), { minItems: 1 }) }),
      execute: async (id, input, signal) => {
        const asked = await api(signal).ask({ ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` });
        return asked.ok ? { content: [{ type: "text" as const, text: JSON.stringify(asked.value) }], details: asked } : result(asked);
      },
    }),
    defineTool({
      name: "thread_spawn", label: "Start a thread",
      description: `${DELEGATION_POLICY}\n\nStart a fresh agent peer with its own context. Every agent may spawn peers within the shared resource limit. parentId records creator provenance only. It returns immediately; assignment replies arrive as ordinary agent messages. Creating a peer is not a dependency: use thread_wait or explicit dependencies when you rely on its result. An ephemeral worker archives after its final assignment settles, but its work and filesystem effects persist. Set ephemeral:false if you expect to continue the conversation after its response. To continue an existing conversation use thread_send instead. ${spawnDefaults(options.env.PI_THREAD_MODE)} Explicit settings may select any available installed model. ${SUBAGENT_MODEL_DESCRIPTIONS}`,
      parameters: Type.Object({ message: Type.String(), title: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), ephemeral: Type.Optional(Type.Boolean({ default: true, description: "Archive after its last assignment settles. Set false when you plan to send follow-up work." })), settings: Type.Optional(Type.Object({
        ...settings.properties,
        model: Type.Optional(Type.String({ description: "Defaults to Sol; any available installed model may be selected." })),
      })) }),
      execute: async (id, input, signal) => result(await api(signal).spawn({ ...input, ephemeral: input.ephemeral ?? true, requestId: `${options.threadId}:${id}`, parentId: options.threadId,
        cwd: input.cwd ?? options.cwd, admission: "force", settings: input.settings as Parameters<ThreadApi["spawn"]>[0]["settings"] })),
    }),
    defineTool({
      name: "thread_send", label: "Send to a thread",
      description: "Send to an existing accessible thread. Agents steer by default and may hard steer to cancel and confirm current local work before running the message. A closed recipient needs an explicit thread_control reopen before sending. Reopen never continues discarded work.",
      parameters: Type.Object({ threadId: Type.String(), text: Type.String(), delivery: Type.Optional(Type.Union(agentDelivery.anyOf, { default: "steer", description: "Agents may steer or hard steer." })), replyTo: Type.Optional(Type.String()) }),
      execute: async (id, input, signal) => {
        if (input.threadId === options.threadId && input.delivery === "hardSteer") return result({ ok: false, error: { code: "invalid_request", message: "Hard steer cannot wait for the tool that requested it. Return and continue in this thread instead." } });
        const request = { ...input, requestId: `${options.threadId}:${id}`, senderId: options.threadId, delivery: resolveDelivery({ ...input, senderId: options.threadId }), source: "explicit" as const };
        return result(await api(signal).send(request));
      },
    }),
    defineTool({
      name: "thread_await", label: "Await a peer result",
      description: "Wait up to 25 seconds for the first completed assignment from accessible peers. A turn settled while the peer owns a wait, dependency or unanswered question is not an assignment result. A timeout returns settlement:null, timedOut:true, remaining IDs, after cursors and current child statuses; it does not settle or stop children. Use the statuses to decide whether to intervene, continue other work or call again with the returned after. Settlements include outcome and final text; native result metadata and thinking are omitted. Stop or hard steer cancels the wait; ordinary steer waits for this tool boundary.",
      parameters: Type.Object({
        threadIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100, uniqueItems: true }),
        after: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
      }),
      execute: async (_id, input, signal) => {
        const value = await api(signal).await({ ...input, parentId: options.threadId, timeoutMs: THREAD_AWAIT_TIMEOUT_MS }, signal);
        signal?.throwIfAborted();
        if (!value.ok) return result(value);
        const settlement = value.value.settlement;
        if (settlement) return result({ ok: true, value: { ...value.value, settlement: {
          threadId: settlement.threadId, outcome: settlement.outcome, finalText: finalText(settlement.finalMessage),
          ...(settlement.error ? { error: settlement.error } : {}),
        } } });

        const diagnostics = new AbortController();
        const timer = setTimeout(() => diagnostics.abort(), 2_000);
        const statusSignal = signal ? AbortSignal.any([signal, diagnostics.signal]) : diagnostics.signal;
        try {
          const statuses = await Promise.race([
            Promise.all(value.value.remainingThreadIds.map(async threadId => {
              try {
                const page = await api(statusSignal).list({ id: threadId, limit: 1 });
                if (!page.ok) return { threadId, error: page.error };
                const thread = page.value.threads.find(item => item.id === threadId);
                if (!thread) return { threadId, error: { code: "not_found", message: "Peer status unavailable" } };
                return { threadId, state: thread.state, held: thread.held, pendingMessages: thread.pendingMessages,
                  ...(thread.metadata?.admissionWait ? { admissionWait: thread.metadata.admissionWait } : {}),
                  ...(thread.metadata?.executionError ? { executionError: thread.metadata.executionError } : {}) };
              } catch (error) {
                return { threadId, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } };
              }
            })),
            new Promise<null>(resolve => statusSignal.addEventListener("abort", () => resolve(null), { once: true })),
          ]);
          signal?.throwIfAborted();
          return result({ ok: true, value: { ...value.value, timedOut: true,
            statuses: statuses ?? value.value.remainingThreadIds.map(threadId => ({ threadId, error: { code: "unavailable", message: "Status lookup timed out; use thread_read to inspect this child" } })) } });
        } finally {
          clearTimeout(timer);
          diagnostics.abort();
        }
      },
    }),
    defineTool({
      name: "thread_list", label: "List threads",
      description: "List accessible persistent threads without starting them. Select children to list this thread's direct children; otherwise list the current environment. Archived threads are omitted unless includeArchived is set.",
      parameters: Type.Object({ children: Type.Optional(Type.Boolean()), parentId: Type.Optional(Type.String()), includeArchived: Type.Optional(Type.Boolean({ description: "Also list archived threads, for example to find one to restore." })), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input, signal) => result(await api(signal).list({ parentId: input.children ? options.threadId : input.parentId, ...(input.includeArchived ? {} : { archived: false }), cursor: input.cursor, limit: input.limit })),
    }),
    defineTool({
      name: "thread_read", label: "Read thread history",
      description: "Read persisted thread history, including root-consent answer receipts, without opening or starting the recipient. Text previews omit image bytes and signatures. Continue pages with cursor; read a large entry with its entryId and offset from nextOffset.",
      parameters: Type.Object({ threadId: Type.String(), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), entryId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      execute: async (_id, input, signal) => {
        const value = await api(signal).read(input.entryId ? { threadId: input.threadId, entryId: input.entryId }
          : { ...input, limit: Math.min(input.limit ?? 8, 8) });
        if (!value.ok) return result(value);
        const inspected = await api(signal).inspect(input.threadId, { context: "omit" });
        if (!inspected.ok) return result(inspected);
        return result({ ok: true, value: { ...historyPreview(value.value, input.entryId, input.entryId ? input.offset ?? 0 : 0),
          thread: inspected.value.thread, pending: inspected.value.pending.map(({ images: _images, text, ...receipt }) => ({ ...receipt, text: readableNotificationText({ ...receipt, text }).slice(0, 2000) })) } });
      },
    }),
    defineTool({
      name: "thread_control", label: "Control a thread",
      description: "Close cancels and archives only the selected agent and discards pending input; unresolved peer dependencies protect both endpoints. Reopen unhides without replay or continuation. Cancel interrupts only local work without archiving. Dependencies replaces your own persistent outgoing peer dependencies (empty releases them); messages/wakes never release protection. Omit threadId for self. Settings save future preferences; retryWaiting moves dormant capacity waiting to the selected model without interrupting live work. Pending receipts can be cancelled or promoted.",
      parameters: Type.Union([
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Union([Type.Literal("close"), Type.Literal("reopen"), Type.Literal("cancel")]) }),
        Type.Object({ action: Type.Literal("dependencies"), threadIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100, uniqueItems: true }) }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("settings"), settings }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("retryWaiting") }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("cancelMessage"), messageId: Type.String() }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("promoteMessage"), messageId: Type.String(), delivery }),
      ]),
      execute: async (_id, input, signal) => {
        const threadId = "threadId" in input ? input.threadId ?? options.threadId : options.threadId;
        if (threadId === options.threadId && (input.action === "close" || input.action === "cancel")) return result({ ok: false, error: { code: "invalid_request", message: "Return from this turn to stop your own work; stopping it inside a tool would wait on that same tool." } });
        return result(await api(signal).control({ ...input, threadId } as Parameters<ThreadApi["control"]>[0]));
      },
    }),
  ].filter(tool => tool.name !== "thread_spawn" || options.env.PI_THREAD_CAN_SPAWN !== "0");
}
