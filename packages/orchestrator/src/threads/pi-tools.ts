import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolveDelivery, type PiSessionOptions, type Result, type ThreadApi } from "./contracts.js";
import { createThreadClient } from "./http.js";
import { historyPreview } from "./pi-history-preview.js";
import { DELEGATION_POLICY } from "../delegation-policy.js";
import { SUBAGENT_MODEL_DESCRIPTIONS } from "../catalog.js";

const delivery = Type.Union([Type.Literal("queue"), Type.Literal("steer"), Type.Literal("hardSteer")]);
const settings = Type.Object({
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => Type.Literal(value)))),
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
    return createThreadClient(url, ((input, init) => fetch(input, { ...init,
      signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal,
    })) as typeof fetch);
  }
  return [
    defineTool({
      name: "thread_spawn", label: "Start a thread",
      description: `${DELEGATION_POLICY}\n\nStart a fresh Orchestrator worker with its own context. Workers cannot spawn subagents; coordinate all delegation from this conversation. It returns immediately; completion arrives as a normal message. To continue an existing conversation use thread_send instead. Defaults: Astra, standard speed, high thinking; Luna defaults to max. Explicit settings override these defaults. ${SUBAGENT_MODEL_DESCRIPTIONS}`,
      parameters: Type.Object({ message: Type.String(), title: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), settings: Type.Optional(settings) }),
      execute: async (id, input, signal) => result(await api(signal).spawn({ ...input, requestId: `${options.threadId}:${id}`, parentId: options.threadId,
        cwd: input.cwd ?? options.cwd, admission: "force", settings: input.settings as Parameters<ThreadApi["spawn"]>[0]["settings"] })),
    }),
    defineTool({
      name: "thread_send", label: "Send to a thread",
      description: "Send to an existing accessible thread. Defaults to steer; an explicit delivery mode overrides the default. Queue waits for current execution; steer waits for current tools; hardSteer cancels and confirms local work stopped before running the message. Sending explicitly resumes a stopped recipient. It does not stop descendants.",
      parameters: Type.Object({ threadId: Type.String(), text: Type.String(), delivery: Type.Optional(Type.Union(delivery.anyOf, { default: "steer", description: "Defaults to steer. Explicit queue, steer or hardSteer is preserved." })), replyTo: Type.Optional(Type.String()) }),
      execute: async (id, input, signal) => {
        if (input.threadId === options.threadId && input.delivery === "hardSteer") return result({ ok: false, error: { code: "invalid_request", message: "Hard steer cannot wait for the tool that requested it. Return and continue in this thread instead." } });
        return result(await api(signal).send({ ...input, requestId: `${options.threadId}:${id}`, senderId: options.threadId, delivery: resolveDelivery({ ...input, senderId: options.threadId }), source: "explicit" }));
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
          thread: inspected.value.thread, pending: inspected.value.pending.map(({ images: _images, text, ...receipt }) => ({ ...receipt, text: text.slice(0, 2000) })) } });
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
