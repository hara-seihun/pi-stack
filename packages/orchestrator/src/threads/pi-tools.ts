import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolveDelivery, THINKING_LEVELS, THREAD_AWAIT_TIMEOUT_MS, type PiSessionOptions, type Result, type ThreadApi } from "./contracts.js";
import { createThreadClient } from "./http.js";
import { historyPreview } from "./pi-history-preview.js";
import { finalText, readableNotificationText } from "./message-format.js";
import { DELEGATION_POLICY } from "../delegation-policy.js";
import { SUBAGENT_MODEL_DESCRIPTIONS } from "../catalog.js";

const delivery = Type.Union([Type.Literal("queue"), Type.Literal("steer"), Type.Literal("hardSteer")]);
const agentDelivery = Type.Union([Type.Literal("steer"), Type.Literal("hardSteer")]);
const settings = Type.Object({
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map(value => Type.Literal(value)))),
  speed: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("priority")])),
});
function result(value: Result<unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, isError: !value.ok };
}

export function threadTools(options: PiSessionOptions) {
  function api(signal?: AbortSignal): ThreadApi {
    signal?.throwIfAborted();
    if (options.threads) return options.threads;
    const url = options.env.PI_THREAD_API_URL;
    if (!url) throw new Error("Thread owner is unavailable: PI_THREAD_API_URL is not configured");
    return createThreadClient(url, fetch, { signal, token: options.env.PI_THREAD_TOKEN });
  }
  /** Whether an unavailable recipient is archived, and if so whether it sits below this unarchived thread. */
  async function archivedDescendant(threadId: string, signal?: AbortSignal): Promise<"descendant" | "other" | null> {
    const find = async (id: string) => {
      const page = await api(signal).list({ id, limit: 1 });
      return page.ok ? page.value.threads.find(thread => thread.id === id) : undefined;
    };
    const recipient = await find(threadId);
    if (!recipient?.metadata?.archived) return null;
    const caller = await find(options.threadId);
    if (!caller || caller.metadata?.archived) return "other";
    const seen = new Set([threadId]);
    for (let parentId: string | null | undefined = recipient.parentId; parentId && !seen.has(parentId); parentId = (await find(parentId))?.parentId) {
      if (parentId === options.threadId) return "descendant";
      seen.add(parentId);
    }
    return "other";
  }
  return [
    defineTool({
      name: "request_user_input_async", label: "Ask the user asynchronously",
      description: "Post a question for the human and continue working immediately. It stays pending after this turn ends and across restarts. Suggestions are optional and may be any number; optionally recommend one by its zero-based index. The human can choose any number of suggestions and add free text. Their answer arrives as a correlated ordinary user message at a safe turn boundary, without cancelling current work.",
      parameters: Type.Object({ question: Type.String({ minLength: 1 }), suggestions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), recommendedSuggestionIndex: Type.Optional(Type.Integer({ minimum: 0 })) }),
      execute: async (id, input, signal) => {
        const asked = await api(signal).ask({ ...input, threadId: options.threadId, requestId: `${options.threadId}:${id}` });
        return asked.ok ? { content: [{ type: "text" as const, text: JSON.stringify(asked.value) }], details: asked } : result(asked);
      },
    }),
    defineTool({
      name: "thread_spawn", label: "Start a thread",
      description: `${DELEGATION_POLICY}\n\nStart a fresh Orchestrator worker with its own context. Workers cannot spawn subagents; coordinate all delegation from this conversation. It returns immediately; completion arrives as a normal message. An ephemeral worker archives after its final assignment settles, but its work and filesystem effects persist. Set ephemeral:false if you expect to continue the conversation after its response. To continue an existing conversation use thread_send instead. Defaults: Sol, standard speed, high thinking; Luna defaults to max. Explicit settings override these defaults: Opus may be chosen explicitly, but Astra and Fable cannot be spawned. ${SUBAGENT_MODEL_DESCRIPTIONS}`,
      parameters: Type.Object({ message: Type.String(), title: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), ephemeral: Type.Optional(Type.Boolean({ default: true, description: "Archive after its last assignment settles. Set false when you plan to send follow-up work." })), settings: Type.Optional(Type.Object({
        ...settings.properties,
        model: Type.Optional(Type.String({ description: "Defaults to Sol. Opus may be chosen explicitly. Astra and Fable are not allowed, including provider-qualified names." })),
      })) }),
      execute: async (id, input, signal) => result(await api(signal).spawn({ ...input, ephemeral: input.ephemeral ?? true, requestId: `${options.threadId}:${id}`, parentId: options.threadId,
        cwd: input.cwd ?? options.cwd, admission: "force", settings: input.settings as Parameters<ThreadApi["spawn"]>[0]["settings"] })),
    }),
    defineTool({
      name: "thread_send", label: "Send to a thread",
      description: "Send to an existing accessible thread. Agents steer by default and may hard steer to cancel and confirm current local work before running the message. Sending explicitly resumes a held recipient. An archived descendant of this thread is restored first; any other archived recipient needs thread_control restore. It does not stop descendants.",
      parameters: Type.Object({ threadId: Type.String(), text: Type.String(), delivery: Type.Optional(Type.Union(agentDelivery.anyOf, { default: "steer", description: "Agents may steer or hard steer." })), replyTo: Type.Optional(Type.String()) }),
      execute: async (id, input, signal) => {
        if (input.threadId === options.threadId && input.delivery === "hardSteer") return result({ ok: false, error: { code: "invalid_request", message: "Hard steer cannot wait for the tool that requested it. Return and continue in this thread instead." } });
        const request = { ...input, requestId: `${options.threadId}:${id}`, senderId: options.threadId, delivery: resolveDelivery({ ...input, senderId: options.threadId }), source: "explicit" as const };
        const sent = await api(signal).send(request);
        // The owner words this refusal "Restore this archived thread …"; only then is the recipient worth inspecting.
        if (sent.ok || sent.error.code !== "unavailable" || !/archived/i.test(sent.error.message) || signal?.aborted) return result(sent);
        const archived = await archivedDescendant(input.threadId, signal).catch(() => null);
        if (archived === "other") return result({ ok: false, error: { ...sent.error, message: `${sent.error.message}. Use thread_control with action "restore" (descendants:true for its workers too, resume:true to continue work the archive interrupted), then send again.` } });
        if (archived !== "descendant") return result(sent);
        const restored = await api(signal).control({ threadId: input.threadId, action: "restore", descendants: false });
        if (!restored.ok) return result(restored);
        return result(await api(signal).send(request));
      },
    }),
    defineTool({
      name: "thread_await", label: "Await a child result",
      description: "Wait up to 25 seconds for the first settlement from direct children. A timeout returns settlement:null, timedOut:true, remaining IDs, after cursors and current child statuses; it does not settle or stop children. Use the statuses to decide whether to intervene, continue other work or call again with the returned after. Settlements include outcome and final text; native result metadata and thinking are omitted. Stop or hard steer cancels the wait; ordinary steer waits for this tool boundary.",
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
                const thread = page.value.threads.find(item => item.id === threadId && item.parentId === options.threadId);
                if (!thread) return { threadId, error: { code: "not_found", message: "Direct child status unavailable" } };
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
      description: "List accessible persistent threads without starting them. Select children to list this thread's direct children; otherwise list the current environment.",
      parameters: Type.Object({ children: Type.Optional(Type.Boolean()), parentId: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input, signal) => result(await api(signal).list({ parentId: input.children ? options.threadId : input.parentId, cursor: input.cursor, limit: input.limit })),
    }),
    defineTool({
      name: "thread_read", label: "Read thread history",
      description: "Read persisted native history without opening or starting the recipient. Text previews omit image bytes and signatures. Continue pages with cursor; read a large entry with its entryId and offset from nextOffset.",
      parameters: Type.Object({ threadId: Type.String(), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), entryId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      execute: async (_id, input, signal) => {
        const value = await api(signal).read(input.entryId ? { threadId: input.threadId, entryId: input.entryId }
          : { ...input, limit: Math.min(input.limit ?? 8, 8) });
        if (!value.ok) return result(value);
        const inspected = await api(signal).inspect(input.threadId);
        if (!inspected.ok) return result(inspected);
        return result({ ok: true, value: { ...historyPreview(value.value, input.entryId, input.entryId ? input.offset ?? 0 : 0),
          thread: inspected.value.thread, pending: inspected.value.pending.map(({ images: _images, text, ...receipt }) => ({ ...receipt, text: readableNotificationText({ ...receipt, text }).slice(0, 2000) })) } });
      },
    }),
    defineTool({
      name: "thread_control", label: "Control a thread",
      description: "Stop local execution and hold pending messages, resume held messages, restore archived threads, or change settings through the same thread owner humans use. Stop requires an explicit descendants choice. Resume with no held messages returns an error without changing state. Restore unarchives the thread, and with descendants:true every thread below it; resume:true also puts back what the archive took out of play, continuing cancelled turns and releasing held messages, while leaving threads that were already stopped stopped. Omit threadId for this thread. Thinking, model and speed use settings; pending receipts from thread_read can be cancelled or promoted.",
      parameters: Type.Union([
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("stop"), descendants: Type.Boolean() }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("resume") }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("restore"), descendants: Type.Boolean({ description: "Also restore every thread below it, such as workers archived with their conversation." }), resume: Type.Optional(Type.Boolean({ default: false, description: "Continue the work the archive interrupted." })) }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("settings"), settings }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("cancelMessage"), messageId: Type.String() }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("promoteMessage"), messageId: Type.String(), delivery }),
      ]),
      execute: async (_id, input, signal) => {
        const threadId = input.threadId ?? options.threadId;
        if (threadId === options.threadId && input.action === "stop") return result({ ok: false, error: { code: "invalid_request", message: "Return from this turn to stop your own work; stopping it inside a tool would wait on that same tool." } });
        return result(await api(signal).control({ ...input, threadId } as Parameters<ThreadApi["control"]>[0]));
      },
    }),
  ].filter(tool => tool.name !== "thread_spawn" || options.env.PI_THREAD_CAN_SPAWN !== "0");
}
