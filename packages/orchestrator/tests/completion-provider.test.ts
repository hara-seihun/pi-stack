import { zstdDecompressSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import type { CompletionInput, CompletionFetch } from "../src/completion-contract.js";
import type { Run } from "../src/domain.js";
import { executeCompletion, type CompletionProviderOptions } from "../src/host/completion-provider.js";

const run = { id: "run-test", provider: "openai-codex", model: "gpt-6-luna", thinking: "max", accountId: "openai-codex-9" } as Run;
const input: CompletionInput = { model: "luna", prompt: "  original user\n", systemPrompt: "original system\n", responseFormat: { type: "json_schema", name: "answer", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } };
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
const options = (fetch: CompletionFetch, extra: Partial<CompletionProviderOptions> = {}): CompletionProviderOptions => ({ authPath: "/not-read", signal: new AbortController().signal, fetch, resolveAuth: async () => ({ apiKey: token }), ...extra });
const event = (type: string, fields: object) => `data: ${JSON.stringify({ type, ...fields })}\n\n`;
function events(complete = true, evidence = true): string {
  return event("response.created", { response: { id: "resp-native", model: "provider-reported-luna" } }) +
    event("response.output_item.added", { output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } }) +
    event("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) +
    event("response.output_text.delta", { output_index: 0, content_index: 0, delta: '{"ok":true}' }) +
    (complete ? event("response.completed", { response: { id: "resp-native", model: evidence ? "provider-reported-luna" : undefined, status: "completed", output: [], ...(evidence ? { usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } } } : {}) } }) : "");
}
function body(init: RequestInit): any {
  const headers = new Headers(init.headers);
  const bytes = typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
  return JSON.parse((headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
}

it("sends exact separate caller prompts and native strict schema, returning only native model/usage", async () => {
  let sent: any;
  const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { sent = body(init!); return new Response(events(), { headers: { "content-type": "text/event-stream" } }); });
  const outcome = await executeCompletion(input, run, options(transport));
  expect(outcome).toEqual({ state: "completed", result: { text: '{"ok":true}', provider: "openai-codex", model: "provider-reported-luna", responseId: "resp-native", usage: { input: 9, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 16, reasoning: 1 }, stopReason: "stop" } });
  expect(sent.instructions).toBe(input.systemPrompt);
  expect(sent.input).toEqual([{ role: "user", content: [{ type: "input_text", text: input.prompt }] }]);
  expect(sent.text.format).toEqual({ ...input.responseFormat, strict: true });
  expect(sent.tools).toEqual([]);
  expect(sent.tool_choice).toBe("none");
  expect(sent.max_output_tokens).toBeUndefined();
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  ["luna", "max", "max"],
  ["luna", "high", "high"],
  ["luna", "medium", "medium"],
  ["luna", "off", "none"],
  ["luna", undefined, "none"],
] as const)("sends admitted %s thinking %s without replacing recovery pins", async (model, thinking, effort) => {
  let sent: any;
  const transport = async (_url: unknown, init?: RequestInit) => { sent = body(init!); return new Response(events()); };
  expect((await executeCompletion({ ...input, model, thinkingLevel: "high" }, { ...run, model: `gpt-6-${model}`, thinking }, options(transport))).state).toBe("completed");
  expect(sent.reasoning?.effort).toBe(effort);
});

it("does not insert a system prompt when the caller supplies none or an empty string", async () => {
  for (const systemPrompt of [undefined, ""]) {
    let sent: any;
    const transport = async (_url: unknown, init?: RequestInit) => { sent = body(init!); return new Response(events()); };
    expect((await executeCompletion({ model: "luna", prompt: "user", systemPrompt }, run, options(transport))).state).toBe("completed");
    expect(sent.instructions).toBe("");
  }
});

it("does not spend on unsupported output caps or retry known provider rejection", async () => {
  const transport = vi.fn(async () => new Response('{"detail":"Unsupported parameter"}', { status: 400 }));
  expect(await executeCompletion({ ...input, maxOutputTokens: 128 }, run, options(transport))).toMatchObject({ state: "failed", error: { code: "unsupported-option" } });
  expect(transport).not.toHaveBeenCalled();
  expect(await executeCompletion(input, run, options(transport))).toMatchObject({ state: "failed", error: { code: "provider" } });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("retains authoritative HTTP429 and Retry-After without retrying inside the transport", async () => {
  const transport=vi.fn(async()=>new Response('{"detail":"Rate limit exceeded"}',{status:429,headers:{'retry-after':'2'}}));
  expect(await executeCompletion(input,run,options(transport))).toEqual({state:"failed",error:{code:"rate-limited",message:'{"detail":"Rate limit exceeded"}',httpStatus:429,retryAfterMs:2000}});
  expect(transport).toHaveBeenCalledTimes(1);
});

it("marks accepted stream loss indeterminate and never retries provider dispatch", async () => {
  const transport = vi.fn(async () => new Response(events(false), { headers: { "content-type": "text/event-stream" } }));
  expect(await executeCompletion(input, run, options(transport))).toMatchObject({ state: "indeterminate", error: { code: "indeterminate" } });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("refuses to invent token usage when a terminal provider response omits it", async () => {
  const transport = async () => new Response(events(true, false));
  expect(await executeCompletion(input, run, options(transport))).toMatchObject({ state: "failed", error: { code: "missing-provider-evidence" } });
});

it("distinguishes the bounded provider deadline from explicit caller cancellation", async () => {
  for (const callerCancelled of [false, true]) {
    const controller = new AbortController();
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      if (callerCancelled) controller.abort();
    }));
    const outcome = await executeCompletion(input, run, options(transport, { signal: controller.signal, deadlineMs: 10 }));
    expect(outcome.state).toBe(callerCancelled ? "cancelled" : "indeterminate");
    expect(transport).toHaveBeenCalledTimes(1);
  }
});
