import { normalizeContext, type Api, type Context, type Model, type Provider, type ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createParser } from "eventsource-parser";
import { providerOAuth } from "../auth/shared-oauth.js";
import type { CompletionExecution, CompletionFetch, CompletionInput, CompletionUsage } from "../completion-contract.js";
import type { Run } from "../domain.js";

interface NativeResponse {
  id?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
  output?: Array<{ content?: Array<{ type?: string; refusal?: string }> }>;
}
export interface CompletionProviderOptions {
  readonly authPath: string;
  readonly signal: AbortSignal;
  readonly fetch?: CompletionFetch;
  readonly deadlineMs?: number;
  readonly provider?: Provider;
  readonly resolveAuth?: (accountId: string, signal: AbortSignal) => Promise<{ apiKey: string; headers?: Record<string, string | null> }>;
}

export function completionPayload(payload: unknown, input: CompletionInput): Record<string, unknown> {
  const { service_tier: _inheritedTier, ...body } = payload as Record<string, unknown>;
  return {
    ...body,
    ...(input.speed === "priority" ? { service_tier: "priority" } : {}),
    instructions: input.systemPrompt ?? "",
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    text: { ...(body.text as object), ...(input.responseFormat ? { format: { ...input.responseFormat, strict: input.responseFormat.strict ?? true } } : {}) },
  };
}

function usage(response: NativeResponse): CompletionUsage | undefined {
  const native = response.usage;
  if (!native || ![native.input_tokens, native.output_tokens, native.total_tokens].every(value => Number.isSafeInteger(value) && value! >= 0)) return undefined;
  const cacheRead = native.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = native.input_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = native.output_tokens_details?.reasoning_tokens;
  if (![cacheRead, cacheWrite, ...(reasoning === undefined ? [] : [reasoning])].every(value => Number.isSafeInteger(value) && value >= 0) || cacheRead + cacheWrite > native.input_tokens!) return undefined;
  return { input: native.input_tokens! - cacheRead - cacheWrite, output: native.output_tokens!, cacheRead, cacheWrite, totalTokens: native.total_tokens!, ...(reasoning === undefined ? {} : { reasoning }) };
}

export async function executeCompletion(input: CompletionInput, run: Run, options: CompletionProviderOptions): Promise<CompletionExecution> {
  if (input.maxOutputTokens !== undefined) return { state: "failed", error: { code: "unsupported-option", message: "OpenAI Codex rejects max_output_tokens for Luna. No provider request was sent." } };
  const provider = options.provider ?? builtinProviders().find(provider => provider.id === "openai-codex");
  const model = provider?.getModels().find(model => model.id === run.model);
  if (!provider || !model || !run.accountId || run.provider !== provider.id) return { state: "failed", error: { code: "provider", message: "Completion model does not match an admitted OpenAI account." } };
  let dispatched = false, phase: "authentication" | "provider" = "authentication";
  let native: NativeResponse = {}, responseStatus: number | undefined, nativeTerminal = false, retryAfterMs: number | undefined;
  const rateLimited = (message: string): CompletionExecution => ({ state: "failed", error: { code: "rate-limited", message, httpStatus: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });
  const fetchProvider = options.fetch ?? globalThis.fetch;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? 300_000);
  const signal = AbortSignal.any([options.signal, deadline]);
  const interrupted = (): CompletionExecution => options.signal.aborted
    ? { state: "cancelled", error: { code: "cancelled", message: "Completion cancelled; an in-flight request may have spent tokens." } }
    : { state: dispatched ? "indeterminate" : "failed", error: { code: dispatched ? "indeterminate" : "provider", message: "Completion provider deadline elapsed. An accepted request will not be sent again." } };
  try {
    const resolveAuth = options.resolveAuth ?? ((accountId: string, signal: AbortSignal) => providerOAuth(provider, options.authPath).resolve(accountId, signal));
    const auth = await resolveAuth(run.accountId, signal);
    phase = "provider";
    const observedFetch = (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      dispatched = true;
      const response = await fetchProvider(url, init);
      responseStatus = response.status;
      if (response.status === 429) {
        const after = response.headers.get("retry-after");
        if (after !== null) {
          const delay = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
          if (Number.isFinite(delay)) retryAfterMs = Math.max(0, Math.ceil(delay));
        }
      }
      if (!response.ok || !response.body) return response;
      const decoder = new TextDecoder();
      const parser = createParser({ onEvent(event) {
        if (event.data === "[DONE]") return;
        const value = JSON.parse(event.data) as { type?: string; response?: NativeResponse };
        if (value.response && ["response.created", "response.completed", "response.incomplete", "response.failed"].includes(value.type ?? "")) {
          native = { ...native, ...value.response };
          if (value.type !== "response.created") nativeTerminal = true;
        }
      } });
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { parser.feed(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
        flush() { parser.feed(decoder.decode()); },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    }) as typeof globalThis.fetch;
    const context: Context = { systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }], tools: [] };
    const message = await provider.stream(model as Model<Api>, normalizeContext(context), {
      ...auth,
      signal,
      transport: "sse",
      reasoningEffort: run.thinking === "off" ? "none" : run.thinking as ThinkingLevel | undefined,
      maxRetries: 0,
      fetch: observedFetch,
      onPayload: payload => completionPayload(payload, input),
    }).result();
    if (signal.aborted) return interrupted();
    if (message.stopReason === "aborted") return { state: "indeterminate", error: { code: "indeterminate", message: "Provider aborted without a terminal response." } };
    if (message.stopReason === "error") {
      if (responseStatus === 429 && !nativeTerminal) return rateLimited(message.errorMessage ?? "Provider rejected the request with HTTP 429.");
      const uncertain = dispatched && !nativeTerminal && (responseStatus === undefined || responseStatus < 400);
      return { state: uncertain ? "indeterminate" : "failed", error: { code: uncertain ? "indeterminate" : "provider", message: message.errorMessage ?? "Provider did not complete the request." } };
    }
    if (!nativeTerminal) return { state: "indeterminate", error: { code: "indeterminate", message: "Provider connection ended before a terminal response. This request will not be sent again." } };
    const refusal = native.output?.flatMap(item => item.content ?? []).find(item => item.type === "refusal");
    if (refusal) return { state: "failed", error: { code: "provider", message: refusal.refusal ?? "Provider refused the completion." } };
    const tokens = usage(native);
    if (!tokens || !native.model || !["stop", "length"].includes(message.stopReason)) return { state: "failed", error: { code: "missing-provider-evidence", message: "Provider response did not contain a completed text result with native model and token usage." } };
    return { state: "completed", result: {
      text: message.content.filter(part => part.type === "text").map(part => part.text).join(""),
      provider: provider.id, model: native.model, responseId: native.id,
      usage: tokens, stopReason: message.stopReason as "stop" | "length",
    } };
  } catch (cause) {
    if (signal.aborted) return interrupted();
    const message = cause instanceof Error ? cause.message : String(cause);
    if (responseStatus === 429 && !nativeTerminal) return rateLimited(message);
    return dispatched
      ? { state: "indeterminate", error: { code: "indeterminate", message: `Provider transport ended without a durable result: ${message}` } }
      : { state: "failed", error: { code: phase, message } };
  }
}
