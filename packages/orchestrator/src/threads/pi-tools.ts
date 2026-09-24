import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolveDelivery, THINKING_LEVELS, THREAD_AWAIT_TIMEOUT_MS, type PiSessionOptions, type Result, type ThreadApi } from "./contracts.js";
import { createThreadClient } from "./http.js";
import { historyPreview, visibleEntry } from "./pi-history-preview.js";
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
    return createThreadClient(url, fetch, { signal });
  }
  return [
    defineTool({
      name: "thread_spawn", label: "Start a thread",
      description: `${DELEGATION_POLICY}\n\nStart a fresh Orchestrator worker with its own context. Workers cannot spawn subagents; coordinate all delegation from this conversation. It returns immediately; completion arrives as a normal message. To continue an existing conversation use thread_send instead. Defaults: Sol for OpenAI parents, Opus for Anthropic parents, standard speed, high thinking; Luna defaults to max. Explicit settings override these defaults, but Astra and Fable cannot be spawned. ${SUBAGENT_MODEL_DESCRIPTIONS}`,
      parameters: Type.Object({ message: Type.String(), title: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), settings: Type.Optional(Type.Object({
        ...settings.properties,
        model: Type.Optional(Type.String({ description: "Defaults to Sol, or Opus for Anthropic parents. Astra and Fable are not allowed, including provider-qualified names." })),
      })) }),
      execute: async (id, input, signal) => result(await api(signal).spawn({ ...input, requestId: `${options.threadId}:${id}`, parentId: options.threadId,
        cwd: input.cwd ?? options.cwd, admission: "force", settings: input.settings as Parameters<ThreadApi["spawn"]>[0]["settings"] })),
    }),
    defineTool({
      name: "thread_send", label: "Send to a thread",
      description: "Send to an existing accessible thread. Agents steer by default and may hard steer to cancel and confirm current local work before running the message. Sending explicitly resumes a held recipient. It does not stop descendants.",
      parameters: Type.Object({ threadId: Type.String(), text: Type.String(), delivery: Type.Optional(Type.Union(agentDelivery.anyOf, { default: "steer", description: "Agents may steer or hard steer." })), replyTo: Type.Optional(Type.String()) }),
      execute: async (id, input, signal) => {
        if (input.threadId === options.threadId && input.delivery === "hardSteer") return result({ ok: false, error: { code: "invalid_request", message: "Hard steer cannot wait for the tool that requested it. Return and continue in this thread instead." } });
        return result(await api(signal).send({ ...input, requestId: `${options.threadId}:${id}`, senderId: options.threadId, delivery: resolveDelivery({ ...input, senderId: options.threadId }), source: "explicit" }));
      },
    }),
    defineTool({
      name: "thread_await", label: "Await a child result",
      description: "Wait for the first settlement from one or more direct children without polling. Returns its outcome and final text, remaining thread IDs and per-thread after cursors. Pass the returned after when waiting again, including after resuming the same worker, to skip results already seen. Other children keep running. Native result metadata and thinking are omitted. Stop or hard steer cancels the wait; ordinary steer waits for this tool boundary.",
      parameters: Type.Object({
        threadIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100, uniqueItems: true }),
        after: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
      }),
      execute: async (_id, input, signal) => {
        const owner = api(signal);
        let after = input.after;
        while (true) {
          signal?.throwIfAborted();
          const value = await owner.await({ ...input, parentId: options.threadId, after, timeoutMs: THREAD_AWAIT_TIMEOUT_MS }, signal);
          signal?.throwIfAborted();
          if (!value.ok) return result(value);
          const settlement = value.value.settlement;
          if (settlement) return result({ ok: true, value: { ...value.value, settlement: {
            threadId: settlement.threadId, outcome: settlement.outcome, finalText: finalText(settlement.finalMessage),
            ...(settlement.error ? { error: settlement.error } : {}),
          } } });
          after = value.value.after;
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
      description: "Stop local execution and hold pending messages, resume held messages, or change settings through the same thread owner humans use. Stop requires an explicit descendants choice. Resume with no held messages returns an error without changing state. Omit threadId for this thread. Thinking, model and speed use settings; pending receipts from thread_read can be cancelled or promoted.",
      parameters: Type.Union([
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("stop"), descendants: Type.Boolean() }),
        Type.Object({ threadId: Type.Optional(Type.String()), action: Type.Literal("resume") }),
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
