import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SUBAGENT_MODEL_DESCRIPTIONS } from "pi-orchestrator/api";
import { API } from "./api";

export const THREAD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

const execReader = promisify(execFile);
async function readThread(args: string[], signal?: AbortSignal) {
  try {
    const { stdout } = await execReader("read-thread", args, { signal, timeout: 15_000, maxBuffer: 2_000_000 });
    return result(JSON.parse(stdout));
  } catch (cause) {
    const failure = cause as Error & { stderr?: string };
    return { ...result({ error: failure.stderr?.trim() || failure.message }), isError: true };
  }
}

export function registerThreadTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "thread_thinking",
    label: "Thread thinking",
    description: "Choose reasoning effort for subsequent replies and tool calls in this thread. Off is fastest; higher levels spend longer thinking.",
    parameters: Type.Object({ level: StringEnum(THREAD_THINKING_LEVELS) }),
    async execute(_id, params) {
      pi.setThinkingLevel(params.level);
      return result({ thinkingLevel: pi.getThinkingLevel() });
    },
  });

  pi.registerTool({
    name: "thread_read",
    label: "Read a thread",
    description: "Read another agent's conversation and actions without a model call. Accepts a title, UUID or unique ID prefix, including settled threads. Starts at the newest page; nextCursor reads older entries. Truncated entries can be read completely with entryId and successive nextOffset values. Deliberation is omitted.",
    parameters: Type.Object({
      thread: Type.String({ minLength: 1 }),
      includeTools: Type.Optional(Type.Boolean({ description: "Include tool results. Defaults to true." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      cursor: Type.Optional(Type.String()),
      entryId: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 48000 })),
    }),
    async execute(_id, params, signal) {
      const args = ["--json"];
      if (params.includeTools !== false) args.push("--work");
      for (const [key, value] of Object.entries({ limit: params.limit, cursor: params.cursor, entry: params.entryId, offset: params.offset, "max-chars": params.maxChars })) {
        if (value !== undefined) args.push(`--${key}`, String(value));
      }
      args.push(params.thread);
      return readThread(args, signal);
    },
  });

  pi.registerTool({
    name: "thread_subagents",
    label: "List a thread's subagents",
    description: "List a thread's direct subagents, sorted by most recent user or assistant message. Defaults to this thread and active children only. includeIdle also returns settled and archived children with their transcript IDs. nextCursor continues the same snapshot; use the same thread and includeIdle value on later pages.",
    parameters: Type.Object({
      thread: Type.Optional(Type.String({ minLength: 1 })),
      includeIdle: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      const args = ["--subagents"];
      if (params.includeIdle) args.push("--include-idle");
      if (params.limit !== undefined) args.push("--limit", String(params.limit));
      if (params.cursor) args.push("--cursor", params.cursor);
      args.push(params.thread ?? process.env.PI_REMOTE_SESSION_ID!);
      return readThread(args, signal);
    },
  });

  if (process.env.PI_SUBAGENT_MODEL) return;

  pi.registerTool({
    name: "thread_delegate",
    label: "Delegate to a thread",
    description: "Delegate work to a Pi Stack thread. Reuses the previous suitable worker by default, including for follow-ups. Set threadId to continue a particular worker; set newThread only when a separate concurrent worker is needed. Returns immediately and brings the result back here. Meeting workers receive the meeting transcript they have not already seen, including the latest speech, and share the room and browser.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      threadId: Type.Optional(Type.String({ description: "An existing worker thread to continue." })),
      newThread: Type.Optional(Type.Boolean({ description: "Create a separate worker instead of reusing one. Defaults to false." })),
      model: Type.Optional(Type.String({ description: `Optional model constraint, such as astra, sol, terra or luna. Existing workers keep their model; a new worker defaults to astra. ${SUBAGENT_MODEL_DESCRIPTIONS}` })),
      thinkingLevel: Type.Optional(StringEnum(THREAD_THINKING_LEVELS, { description: "Reasoning effort for a new worker. Existing workers keep their level. Defaults to high." })),
    }),
    async execute(toolCallId, params, signal) {
      const parentSessionId = process.env.PI_REMOTE_SESSION_ID!;
      const hash = createHash("sha256").update(`${parentSessionId}:${toolCallId}`).digest("hex");
      const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
      const response = await fetch(new URL(API.createSession.path(), process.env.PI_REMOTE_SERVER_URL!), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...params, requestId, parentSessionId }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || `Thread delegation failed: HTTP ${response.status}`);
      const accepted = value as any;
      const receipt = { threadId: accepted.session.id, name: accepted.session.name, reused: Boolean(accepted.reused),
        workId: accepted.delegation.workId, state: accepted.session.activity, notification: accepted.delegation.notification };
      return { content: [{ type: "text" as const, text: `${receipt.reused ? "Continuing" : "Started"} thread ${receipt.name} (${receipt.threadId}). Work ${receipt.workId} is ${receipt.state.toLowerCase()}. Its result will arrive here automatically.` }], details: receipt };
    },
  });
}
