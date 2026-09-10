import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { API } from "./api";

export const THREAD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

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
    name: "thread_delegate",
    label: "Delegate to a thread",
    description: "Start independent work in another Pi Stack thread with its regular tools. Returns immediately; the result arrives automatically in this thread. Model and reasoning effort are selectable. Meeting workers share the room and browser.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String({ description: "Pi Stack model ID, such as astra, fable or opus. Defaults to astra." })),
      thinkingLevel: Type.Optional(StringEnum(THREAD_THINKING_LEVELS, { description: "Defaults to high." })),
    }),
    async execute(toolCallId, params, signal) {
      const parentSessionId = process.env.PI_REMOTE_SESSION_ID!;
      const hash = createHash("sha256").update(`${parentSessionId}:${toolCallId}`).digest("hex");
      const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
      const response = await fetch(new URL(API.createSession.path(), process.env.PI_REMOTE_SERVER_URL!), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...params, requestId, parentSessionId, model: params.model ?? "astra", thinkingLevel: params.thinkingLevel ?? "high" }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || `Thread delegation failed: HTTP ${response.status}`);
      return result(value);
    },
  });
}
