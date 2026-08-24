import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeInKernelBrowser } from "./browser.mjs";

const PROVIDER = "chatgpt-pro";
const MODEL_ID = "gpt-5-6-pro";
const LITERAL_MODEL_ID = "gpt-5-6-pro-literal";

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image") return `[Image omitted from the ChatGPT Pro text bridge: ${part.mimeType || "image"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function contextToPrompt(context: Context, literal = false): string {
  const messages: Array<{ role: string; content: string }> = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textFromContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text) parts.push(part.text);
        if (part.type === "toolCall") {
          parts.push(`<pi_tool_call>${JSON.stringify({ name: part.name, arguments: part.arguments })}</pi_tool_call>`);
        }
      }
      if (parts.length) messages.push({ role: "assistant", content: parts.join("\n") });
      continue;
    }
    messages.push({
      role: "tool",
      content: `<pi_tool_result>${JSON.stringify({
        id: message.toolCallId,
        name: message.toolName,
        isError: message.isError,
        content: textFromContent(message.content),
      })}</pi_tool_result>`,
    });
  }

  if (literal && messages.length === 1 && messages[0].role === "user") return messages[0].content;

  const system = literal
    ? ""
    : [
        context.systemPrompt || "You are a helpful coding assistant.",
        "This ChatGPT subscription bridge is text-only. Do not claim that you executed a local tool or accessed the local filesystem.",
      ].join("\n\n");
  const transcript = messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`).join("\n\n");
  return system ? `<pi_agent_instructions>\n${system}\n</pi_agent_instructions>\n\n${transcript}` : transcript;
}

function estimatedTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function streamChatGPTPro(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    // A Pro turn runs for minutes to hours; stream transport phases as a
    // thinking block so interactive sessions and transcripts show live state.
    let thinking = "";
    const think = (line: string) => {
      const delta = `${new Date().toISOString().slice(11, 19)}Z ${line}\n`;
      thinking += delta;
      output.content = [{ type: "thinking", thinking }];
      stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output });
    };
    try {
      stream.push({ type: "start", partial: output });
      output.content = [{ type: "thinking", thinking }];
      stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
      const prompt = contextToPrompt(context, model.id === LITERAL_MODEL_ID);
      const completion = await completeInKernelBrowser(prompt, {
        signal: options?.signal,
        onStatus: (status: any) => {
          if (status.phase === "running" || status.phase === "retrying-after-fallback") {
            const capacity = status.capacity;
            think(`${status.phase} on ${status.browserProfile}${capacity ? ` (${capacity.inFlight}/${capacity.maxParallel} machine-wide)` : ""}`);
          } else if (status.phase === "submitted") {
            think(`submitted on ${status.browserProfile}; ChatGPT reasons server-side, next persisted check in ${Math.round((status.nextCheckMs ?? 0) / 60000)}min`);
          }
        },
      });
      think(`verified GPT-5.6 Pro execution on ${completion.browserProfile}`);
      const text = completion.text;
      stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: output });
      output.content = [{ type: "thinking", thinking }, { type: "text", text }];
      output.usage.input = estimatedTokens(prompt);
      output.usage.output = estimatedTokens(text);
      output.usage.totalTokens = output.usage.input + output.usage.output;
      output.stopReason = "stop";

      stream.push({ type: "text_start", contentIndex: 1, partial: output });
      if (text) stream.push({ type: "text_delta", contentIndex: 1, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 1, content: text, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER, {
    name: "ChatGPT Pro (Kernel browser)",
    baseUrl: "https://chatgpt.com/",
    apiKey: "managed-by-kernel-browser-profile",
    api: "openai-responses",
    streamSimple: streamChatGPTPro,
    models: [
      {
        id: MODEL_ID,
        name: "GPT-5.6 Sol Pro (ChatGPT browser; text-only)",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: "pro",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      },
      {
        id: LITERAL_MODEL_ID,
        name: "GPT-5.6 Sol Pro literal solver (ChatGPT browser; text-only)",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: "pro",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      },
    ],
  });
}
