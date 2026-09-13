import { createHash } from "node:crypto";
import { anthropicModels } from "./codex-models.js";

export type JsonObject = Record<string, unknown>;
export type AnthropicBlock = JsonObject & { type: string };
export interface ToolBinding { name: string; namespace?: string; type: "function" | "custom" }
export interface AnthropicRequest {
  payload: JsonObject;
  tools: Map<string, ToolBinding>;
  model: string;
}
export class AnthropicAdapterError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "unsupported_request") { super(message); }
}
export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnthropicAdapterError(`${label} must be an object`);
  return value as JsonObject;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AnthropicAdapterError(`${label} must be a string`);
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new AnthropicAdapterError(`${label} must be an array`);
  return value;
}
function fields(value: JsonObject, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key) && value[key] !== undefined && value[key] !== null) {
    throw new AnthropicAdapterError(`Unsupported ${label} field: ${key}`);
  }
}
export function toolName(name: string, namespace?: string): string {
  if (!namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith("codex_")) return name;
  return `codex_${createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 48)}`;
}
function callId(id: unknown): string {
  const value = string(id, "call_id");
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return value;
  return `call_${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}
const THINKING_PREFIX = "anthropic-thinking-v1:";
export function encodeThinking(block: AnthropicBlock): string {
  return THINKING_PREFIX + Buffer.from(JSON.stringify(block)).toString("base64url");
}
function decodeThinking(value: unknown): AnthropicBlock {
  const encoded = string(value, "reasoning.encrypted_content");
  if (!encoded.startsWith(THINKING_PREFIX)) throw new AnthropicAdapterError("Cannot replay foreign encrypted reasoning through Anthropic", 400, "unsupported_history");
  let block: JsonObject;
  try { block = object(JSON.parse(Buffer.from(encoded.slice(THINKING_PREFIX.length), "base64url").toString("utf8")), "thinking envelope"); }
  catch { throw new AnthropicAdapterError("Malformed Anthropic thinking envelope", 400, "unsupported_history"); }
  if (block.type === "thinking") {
    fields(block, ["type", "thinking", "signature"], "thinking envelope");
    string(block.thinking, "thinking"); string(block.signature, "thinking signature");
  } else if (block.type === "redacted_thinking") {
    fields(block, ["type", "data"], "thinking envelope"); string(block.data, "redacted thinking data");
  } else throw new AnthropicAdapterError("Unsupported Anthropic thinking envelope", 400, "unsupported_history");
  return block as AnthropicBlock;
}
function content(value: unknown): AnthropicBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value, "content").map(raw => {
    const part = object(raw, "content part");
    switch (part.type) {
      case "input_text": case "output_text": case "text":
        fields(part, ["type", "text", "annotations", "logprobs"], "text content");
        if (Array.isArray(part.annotations) && part.annotations.length) throw new AnthropicAdapterError("Annotated text history is not supported");
        return { type: "text", text: string(part.text, "text") };
      case "input_image": {
        fields(part, ["type", "image_url", "detail"], "image content");
        const url = string(part.image_url, "image_url");
        const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
        if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
        if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
        throw new AnthropicAdapterError("Anthropic images require an HTTP URL or PNG/JPEG/GIF/WebP base64 data URL");
      }
      default: throw new AnthropicAdapterError(`Unsupported content type: ${String(part.type)}`);
    }
  });
}
function jsonArguments(value: unknown): JsonObject {
  try { return object(JSON.parse(string(value, "function arguments")), "function arguments"); }
  catch { throw new AnthropicAdapterError("Function arguments must contain a JSON object", 400, "unsupported_history"); }
}

export function translateAnthropicRequest(raw: unknown): AnthropicRequest {
  const request = object(raw, "Responses request");
  fields(request, ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "stream", "store", "include", "max_output_tokens", "temperature", "top_p", "service_tier", "prompt_cache_key", "metadata", "client_metadata", "previous_response_id", "truncation", "background", "stream_options", "prompt_cache_retention", "safety_identifier"], "Responses request");
  if (request.client_metadata !== undefined) {
    const metadata = object(request.client_metadata, "client_metadata");
    for (const [key, value] of Object.entries(metadata)) string(value, `client_metadata.${key}`);
  }
  if (request.stream !== true) throw new AnthropicAdapterError("This Codex transport requires stream=true");
  if (request.previous_response_id) throw new AnthropicAdapterError("previous_response_id is not supported; Codex must send full history");
  if (request.background) throw new AnthropicAdapterError("Background Responses are not supported");
  if (request.store === true) throw new AnthropicAdapterError("Stored Responses are not supported; Codex must own the transcript");
  if (request.prompt_cache_retention && request.prompt_cache_retention !== "in_memory") throw new AnthropicAdapterError("Anthropic subscription caching does not support Responses prompt_cache_retention");
  if (request.truncation && request.truncation !== "disabled") throw new AnthropicAdapterError("Server-side Responses truncation is not supported");
  if (request.service_tier && !["auto", "default"].includes(String(request.service_tier))) throw new AnthropicAdapterError(`Unsupported service_tier: ${request.service_tier}`);
  if (request.include && array(request.include, "include").some(item => item !== "reasoning.encrypted_content")) throw new AnthropicAdapterError("Only reasoning.encrypted_content is supported in include");
  if (request.stream_options) fields(object(request.stream_options, "stream_options"), ["include_obfuscation"], "stream_options");
  const modelId = string(request.model, "model");
  const model = anthropicModels().find(model => model.id === modelId);
  if (!model) throw new AnthropicAdapterError(`Unknown Anthropic model: ${modelId}`, 400, "model_not_found");
  const tools = new Map<string, ToolBinding>();
  const toolDefinitions: JsonObject[] = [];
  const addTool = (rawTool: unknown, namespace?: string, namespaceDescription?: string) => {
    const tool = object(rawTool, "tool");
    if (tool.type !== "function" && tool.type !== "custom") throw new AnthropicAdapterError(`Unsupported tool type: ${String(tool.type)}. Disable provider-hosted tools for this provider.`);
    fields(tool, ["type", "name", "description", "parameters", "strict", "format", "defer_loading"], "tool");
    if (tool.defer_loading) throw new AnthropicAdapterError("Deferred tool loading is not supported");
    const name = string(tool.name, "tool name");
    const wireName = toolName(name, namespace);
    if (tools.has(wireName)) throw new AnthropicAdapterError(`Duplicate tool: ${name}`);
    tools.set(wireName, { type: tool.type, name, ...(namespace ? { namespace } : {}) });
    let description = [namespaceDescription, tool.description === undefined ? undefined : string(tool.description, "tool description")].filter(Boolean).join("\n\n");
    let schema: JsonObject;
    if (tool.type === "custom") {
      if (tool.format) {
        const format = object(tool.format, "custom tool format");
        if (format.type === "grammar") {
          fields(format, ["type", "syntax", "definition"], "custom tool grammar");
          if (format.syntax !== "lark" && format.syntax !== "regex") throw new AnthropicAdapterError("Unsupported custom tool grammar syntax");
          description += `\n\nThe input string must follow this ${format.syntax} grammar:\n${string(format.definition, "grammar definition")}`;
        } else if (format.type !== "text") throw new AnthropicAdapterError(`Unsupported custom tool format: ${String(format.type)}`);
      }
      schema = { type: "object", properties: { input: { type: "string", description: "The complete raw input to the custom tool, without JSON encoding or markdown fences." } }, required: ["input"], additionalProperties: false };
    } else schema = tool.parameters === undefined ? { type: "object", properties: {} } : object(tool.parameters, "tool parameters");
    if (tool.strict === true && !model.compat?.supportsStrictTools) throw new AnthropicAdapterError(`Model ${modelId} does not support strict tools`);
    toolDefinitions.push({ name: wireName, description, input_schema: schema, ...(tool.strict === true ? { strict: true } : {}) });
  };
  for (const rawTool of array(request.tools ?? [], "tools")) {
    const tool = object(rawTool, "tool");
    if (tool.type === "namespace") {
      fields(tool, ["type", "name", "description", "tools"], "tool namespace");
      for (const child of array(tool.tools, "namespace tools")) addTool(child, string(tool.name, "namespace name"), tool.description as string | undefined);
    } else addTool(tool);
  }
  const system: AnthropicBlock[] = [];
  if (request.instructions !== undefined && request.instructions !== null) system.push({ type: "text", text: string(request.instructions, "instructions") });
  const messages: { role: string; content: AnthropicBlock[] }[] = [];
  const append = (role: string, blocks: AnthropicBlock[]) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : array(request.input, "input");
  for (const rawItem of input) {
    const item = object(rawItem, "input item");
    switch (item.type ?? "message") {
      case "message": {
        fields(item, ["type", "role", "content", "id", "status", "phase"], "message");
        const role = string(item.role, "message role");
        if (role === "system" || role === "developer") {
          const blocks = content(item.content);
          if (blocks.some(block => block.type !== "text")) throw new AnthropicAdapterError("Instruction messages must contain text");
          // Anthropic's mid-conversation-system beta keeps instruction updates in
          // position instead of hoisting them ahead of earlier user messages.
          if (!messages.length) system.push(...blocks);
          else append("system", blocks);
        } else if (role === "user" || role === "assistant") append(role, content(item.content));
        else throw new AnthropicAdapterError(`Unsupported message role: ${role}`);
        break;
      }
      case "function_call": case "custom_tool_call": {
        fields(item, ["type", "id", "call_id", "name", "namespace", "arguments", "input", "status"], "tool call");
        const name = toolName(string(item.name, "tool call name"), item.namespace == null ? undefined : string(item.namespace, "tool namespace"));
        append("assistant", [{ type: "tool_use", id: callId(item.call_id), name, input: item.type === "custom_tool_call" ? { input: string(item.input, "custom tool input") } : jsonArguments(item.arguments) }]);
        break;
      }
      case "function_call_output": case "custom_tool_call_output":
        fields(item, ["type", "id", "call_id", "output", "status"], "tool result");
        append("user", [{ type: "tool_result", tool_use_id: callId(item.call_id), content: content(item.output) }]);
        break;
      case "reasoning":
        fields(item, ["type", "id", "summary", "content", "encrypted_content", "status"], "reasoning");
        if (!item.encrypted_content) throw new AnthropicAdapterError("Reasoning history has no signed Anthropic envelope", 400, "unsupported_history");
        append("assistant", [decodeThinking(item.encrypted_content)]);
        break;
      default: throw new AnthropicAdapterError(`Unsupported input item type: ${String(item.type)}`, 400, "unsupported_history");
    }
  }
  if (!messages.length) throw new AnthropicAdapterError("At least one user message is required");
  const maxTokens = request.max_output_tokens === undefined ? model.maxTokens : request.max_output_tokens;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > model.maxTokens) throw new AnthropicAdapterError(`max_output_tokens must be between 1 and ${model.maxTokens}`);
  const payload: JsonObject = { model: modelId, system, messages, max_tokens: maxTokens, stream: true };
  if (toolDefinitions.length) payload.tools = toolDefinitions;
  if (request.tool_choice !== undefined || request.parallel_tool_calls !== undefined) {
    const choice = request.tool_choice ?? "auto";
    let selection: JsonObject;
    if (choice === "auto" || choice === "none") selection = { type: choice };
    else if (choice === "required") selection = { type: "any" };
    else {
      const selected = object(choice, "tool_choice");
      if (selected.type !== "function" && selected.type !== "custom") throw new AnthropicAdapterError("Unsupported tool_choice");
      const name = toolName(string(selected.name, "tool_choice.name"), selected.namespace as string | undefined);
      if (!tools.has(name)) throw new AnthropicAdapterError("tool_choice refers to an unknown tool");
      selection = { type: "tool", name };
    }
    if (selection.type !== "none" && request.parallel_tool_calls === false) selection.disable_parallel_tool_use = true;
    if (toolDefinitions.length) payload.tool_choice = selection;
    else if (selection.type !== "none" && selection.type !== "auto") throw new AnthropicAdapterError("tool_choice requires tools");
  }
  const reasoning = request.reasoning === undefined ? {} : object(request.reasoning, "reasoning");
  fields(reasoning, ["effort", "summary"], "reasoning");
  const effort = reasoning.effort ?? "high";
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(effort))) throw new AnthropicAdapterError(`Unsupported reasoning effort: ${String(effort)}`);
  if (effort !== "none") {
    if (model.compat?.forceAdaptiveThinking) {
      payload.thinking = { type: "adaptive" };
      const mapped = model.thinkingLevelMap?.[effort as "low" | "medium" | "high" | "xhigh" | "max" | "minimal"];
      payload.output_config = { effort: typeof mapped === "string" ? mapped : effort === "minimal" ? "low" : effort === "xhigh" || effort === "max" ? "high" : effort };
    } else {
      const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 32768 };
      const budget = Math.min(budgets[String(effort)], maxTokens - 1);
      if (budget < 1024) throw new AnthropicAdapterError("Thinking requires max_output_tokens greater than 1024");
      payload.thinking = { type: "enabled", budget_tokens: budget };
    }
  } else if (model.thinkingLevelMap?.off === null) throw new AnthropicAdapterError(`Model ${modelId} cannot disable thinking`);
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.top_p !== undefined) payload.top_p = request.top_p;
  if (request.text) {
    const text = object(request.text, "text");
    fields(text, ["format", "verbosity"], "text");
    if (text.verbosity !== undefined) throw new AnthropicAdapterError("Anthropic does not support Responses text.verbosity");
    if (text.format) {
      const format = object(text.format, "text.format");
      if (format.type === "json_schema") {
        fields(format, ["type", "name", "description", "schema", "strict"], "text.format");
        payload.output_config = { ...(payload.output_config as JsonObject), format: { type: "json_schema", schema: object(format.schema, "output schema") } };
      } else if (format.type !== "text") throw new AnthropicAdapterError(`Unsupported output format: ${String(format.type)}`);
    }
  }
  // Cache only existing prompt content. Do not add synthetic conversation turns.
  if (system.length) system[system.length - 1].cache_control = { type: "ephemeral" };
  const lastContent = messages.at(-1)!.content;
  if (lastContent.length && !["thinking", "redacted_thinking"].includes(lastContent.at(-1)!.type)) lastContent[lastContent.length - 1].cache_control = { type: "ephemeral" };
  return { payload, tools, model: modelId };
}
