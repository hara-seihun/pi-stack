import { randomUUID } from "node:crypto";
import type { CoreAccountUsage } from "./account.js";
import { createParser } from "eventsource-parser";
import { AnthropicAdapterError, encodeThinking, object, string, type AnthropicBlock, type AnthropicRequest, type JsonObject } from "./codex-anthropic-request.js";

interface BlockState {
  block: AnthropicBlock;
  item: JsonObject;
  outputIndex: number;
  json: string;
  hasJsonDelta: boolean;
  stopped: boolean;
}
export type EmitResponsesEvent = (type: string, fields: JsonObject) => Promise<void>;
export type AnthropicResponseUsage = Omit<CoreAccountUsage, "sessionId" | "nativeThreadId" | "turnId"> & { providerResponseId: string };

export async function streamAnthropicResponse(response: Response, request: AnthropicRequest, emit: EmitResponsesEvent, signal: AbortSignal,
  recordUsage?: (usage: AnthropicResponseUsage) => void | Promise<void>): Promise<void> {
  if (!response.body) throw new AnthropicAdapterError("Anthropic returned no response body", 502, "upstream_protocol_error");
  const output: JsonObject[] = [];
  const blocks = new Map<number, BlockState>();
  const usage: Record<string, number> = {};
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;
  let hasMessageDelta = false;
  let providerResponseId: string | undefined;
  const reportUsage = async () => {
    if (!providerResponseId || usage.input_tokens === undefined || usage.output_tokens === undefined) return;
    const input = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    await recordUsage?.({ providerResponseId, model: request.model, inputTokens: input,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0, cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
      outputTokens: usage.output_tokens, reasoningOutputTokens: usage.thinking_tokens ?? 0, totalTokens: input + usage.output_tokens });
  };
  const responseObject = (status: string): JsonObject => ({ id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: request.model, status, output });
  const protocolError = (message: string): never => { throw new AnthropicAdapterError(message, 502, "upstream_protocol_error"); };
  const updateUsage = (raw: unknown) => {
    const value = object(raw, "Anthropic usage");
    for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
      if (value[key] === undefined) continue;
      const count = value[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) protocolError(`Invalid Anthropic usage.${key}`);
      usage[key] = count as number;
    }
    if (value.output_tokens_details !== undefined && value.output_tokens_details !== null) {
      const details = object(value.output_tokens_details, "Anthropic output token details");
      if (details.thinking_tokens !== undefined) {
        const count = details.thinking_tokens;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) protocolError("Invalid Anthropic thinking token usage");
        usage.thinking_tokens = count as number;
      }
    }
  };
  const handle = async (raw: unknown) => {
    signal.throwIfAborted();
    const event = object(raw, "Anthropic event");
    if (event.type === "error") {
      const error = object(event.error, "Anthropic error");
      throw new AnthropicAdapterError(`Anthropic ${String(error.type)}: ${String(error.message)}`, 502, String(error.type ?? "upstream_error"));
    }
    if (event.type === "ping") return;
    if (stopped) protocolError("Anthropic sent data after message_stop");
    if (event.type === "message_start") {
      if (started) protocolError("Anthropic sent duplicate message_start");
      started = true;
      const message = object(event.message, "Anthropic message");
      if (message.role !== "assistant") protocolError("Anthropic returned a non-assistant message");
      if (Array.isArray(message.content) && message.content.length) protocolError("Anthropic message_start unexpectedly contained content");
      providerResponseId = string(message.id, "Anthropic response ID");
      updateUsage(message.usage);
      await reportUsage();
      await emit("response.created", { response: responseObject("in_progress") });
      await emit("response.in_progress", { response: responseObject("in_progress") });
      return;
    }
    if (!started) protocolError(`Anthropic ${String(event.type)} preceded message_start`);
    if (event.type === "message_delta") {
      const delta = object(event.delta, "Anthropic message delta");
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) stopReason = string(delta.stop_reason, "stop_reason");
      updateUsage(event.usage);
      await reportUsage();
      hasMessageDelta = true;
      return;
    }
    if (event.type === "message_stop") {
      if (!hasMessageDelta || !stopReason || [...blocks.values()].some(state => !state.stopped)) protocolError("Anthropic stopped before completing its blocks/usage/stop reason");
      if (!["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal"].includes(stopReason!)) protocolError(`Unsupported Anthropic stop reason: ${stopReason}`);
      if (usage.input_tokens === undefined || usage.output_tokens === undefined) protocolError("Anthropic did not report input/output usage");
      const input = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const incomplete = stopReason === "max_tokens";
      const result = responseObject(incomplete ? "incomplete" : "completed");
      result.usage = {
        input_tokens: input,
        input_tokens_details: { cached_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_tokens: usage.cache_creation_input_tokens ?? 0 },
        output_tokens: usage.output_tokens,
        output_tokens_details: { reasoning_tokens: usage.thinking_tokens ?? 0 },
        total_tokens: input + usage.output_tokens,
      };
      if (incomplete) result.incomplete_details = { reason: "max_output_tokens" };
      await emit(incomplete ? "response.incomplete" : "response.completed", { response: result });
      stopped = true;
      return;
    }
    const index = event.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) protocolError(`Invalid Anthropic block index on ${String(event.type)}`);
    if (event.type === "content_block_start") {
      if (blocks.has(index as number)) protocolError("Anthropic reused a content block index");
      const block = object(event.content_block, "Anthropic content block") as AnthropicBlock;
      const id = randomUUID().replaceAll("-", "");
      let item: JsonObject;
      if (block.type === "text") {
        if (Array.isArray(block.citations) && block.citations.length) protocolError("Anthropic citation blocks are not supported by this transport");
        item = { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] };
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        if (block.type === "redacted_thinking") string(block.data, "redacted thinking data");
        item = { type: "reasoning", id: `rs_${id}`, summary: [] };
      }
      else if (block.type === "tool_use") {
        const name = string(block.name, "tool name");
        const binding = request.tools.get(name);
        if (!binding) protocolError(`Anthropic called undeclared tool: ${name}`);
        const common = { id: `fc_${id}`, call_id: string(block.id, "tool id"), name: binding!.name, ...(binding!.namespace ? { namespace: binding!.namespace } : {}), status: "in_progress" };
        item = binding!.type === "custom" ? { ...common, type: "custom_tool_call", input: "" } : { ...common, type: "function_call", arguments: "" };
      } else protocolError(`Unsupported Anthropic content block: ${String(block.type)}`);
      const state: BlockState = { block: { ...block }, item: item!, outputIndex: output.length, json: "", hasJsonDelta: false, stopped: false };
      blocks.set(index as number, state);
      output.push(state.item);
      await emit("response.output_item.added", { output_index: state.outputIndex, item: state.item });
      if (block.type === "text") {
        const text = string(block.text, "text");
        await emit("response.content_part.added", { item_id: state.item.id, output_index: state.outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        if (text) await emit("response.output_text.delta", { item_id: state.item.id, output_index: state.outputIndex, content_index: 0, delta: text });
      } else if (block.type === "thinking") {
        const thinking = string(block.thinking, "thinking");
        state.block.signature ??= "";
        await emit("response.reasoning_summary_part.added", { item_id: state.item.id, output_index: state.outputIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
        if (thinking) await emit("response.reasoning_summary_text.delta", { item_id: state.item.id, output_index: state.outputIndex, summary_index: 0, delta: thinking });
      }
      return;
    }
    const state = blocks.get(index as number);
    if (!state || state.stopped) protocolError("Anthropic referenced a missing or completed content block");
    const current = state!;
    const common = { item_id: current.item.id, output_index: current.outputIndex };
    if (event.type === "content_block_delta") {
      const delta = object(event.delta, "Anthropic content delta");
      if (delta.type === "text_delta" && current.block.type === "text") {
        const text = string(delta.text, "text delta");
        current.block.text = string(current.block.text, "text") + text;
        await emit("response.output_text.delta", { ...common, content_index: 0, delta: text });
      } else if (delta.type === "thinking_delta" && current.block.type === "thinking") {
        const text = string(delta.thinking, "thinking delta");
        current.block.thinking = string(current.block.thinking, "thinking") + text;
        await emit("response.reasoning_summary_text.delta", { ...common, summary_index: 0, delta: text });
      } else if (delta.type === "signature_delta" && current.block.type === "thinking") {
        current.block.signature = string(current.block.signature, "signature") + string(delta.signature, "signature delta");
      } else if (delta.type === "input_json_delta" && current.block.type === "tool_use") {
        current.hasJsonDelta = true;
        const fragment = string(delta.partial_json, "tool JSON delta");
        current.json += fragment;
        if (current.item.type === "function_call") await emit("response.function_call_arguments.delta", { ...common, delta: fragment });
      } else protocolError(`Unsupported Anthropic delta ${String(delta.type)} for ${current.block.type}`);
      return;
    }
    if (event.type !== "content_block_stop") protocolError(`Unsupported Anthropic event: ${String(event.type)}`);
    current.stopped = true;
    if (current.block.type === "text") {
      const part = { type: "output_text", text: current.block.text, annotations: [] };
      current.item.content = [part];
      current.item.status = "completed";
      await emit("response.output_text.done", { ...common, content_index: 0, text: current.block.text });
      await emit("response.content_part.done", { ...common, content_index: 0, part });
    } else if (current.block.type === "thinking" || current.block.type === "redacted_thinking") {
      if (current.block.type === "thinking") {
        if (typeof current.block.signature !== "string" || !current.block.signature) protocolError("Anthropic thinking has no replay signature");
        const part = { type: "summary_text", text: current.block.thinking };
        current.item.summary = [part];
        await emit("response.reasoning_summary_text.done", { ...common, summary_index: 0, text: current.block.thinking });
        await emit("response.reasoning_summary_part.done", { ...common, summary_index: 0, part });
      }
      current.item.encrypted_content = encodeThinking(current.block);
    } else {
      if (current.hasJsonDelta && Object.keys(object(current.block.input, "initial tool input")).length) protocolError("Anthropic mixed initial tool input with streamed JSON input");
      let input: JsonObject;
      try { input = object(current.hasJsonDelta ? JSON.parse(current.json) : current.block.input, "tool input"); }
      catch { protocolError("Anthropic returned malformed tool input JSON"); }
      if (current.item.type === "custom_tool_call") {
        if (typeof input!.input !== "string" || Object.keys(input!).some(key => key !== "input")) protocolError("Anthropic custom tool input must be an object containing only an input string");
        current.item.input = input!.input;
        await emit("response.custom_tool_call_input.delta", { ...common, delta: input!.input });
        await emit("response.custom_tool_call_input.done", { ...common, input: input!.input });
      } else {
        current.item.arguments = current.hasJsonDelta ? current.json : JSON.stringify(input!);
        if (!current.hasJsonDelta) await emit("response.function_call_arguments.delta", { ...common, delta: current.item.arguments });
        await emit("response.function_call_arguments.done", { ...common, arguments: current.item.arguments });
      }
      current.item.status = "completed";
    }
    await emit("response.output_item.done", { output_index: current.outputIndex, item: current.item });
  };
  const queue: string[] = [];
  const parser = createParser({ onEvent: event => queue.push(event.data), onError: error => { throw new AnthropicAdapterError(`Invalid Anthropic SSE: ${error.message}`, 502, "upstream_protocol_error"); } });
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!stopped) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length) {
        const data = queue.shift()!;
        let event: unknown;
        try { event = JSON.parse(data); } catch { protocolError("Anthropic sent malformed SSE JSON"); }
        await handle(event);
      }
    }
    signal.throwIfAborted();
    if (!stopped) protocolError("Anthropic stream ended before message_stop; model call will not be retried");
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
