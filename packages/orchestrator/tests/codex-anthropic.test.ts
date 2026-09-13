import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexAnthropicAdapter, type CodexAnthropicAdapter } from "../src/cores/codex-anthropic.js";
import { encodeThinking, translateAnthropicRequest } from "../src/cores/codex-anthropic-request.js";

const model = "claude-fable-5-1";
const adapters: CodexAnthropicAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const start = async (fetch: typeof globalThis.fetch, credentials = vi.fn(async () => ({ accessToken: "subscription-token" }))) => {
  const adapter = await startCodexAnthropicAdapter({ sessionId: "codex-session", credentials, fetch });
  adapters.push(adapter);
  return adapter;
};
function stream(events: unknown[]) {
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    // Include fragmented UTF-8 and SSE records, not just one event per read.
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const begin = { type: "message_start", message: { id: "msg_upstream", role: "assistant", content: [], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 11 } } };
const end = (reason = "end_turn") => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } } }, { type: "message_stop" }];
const textEvents = () => [begin, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello π 🌸" } }, { type: "content_block_stop", index: 0 }, ...end()];
const request = (input: unknown = [{ role: "user", content: "hello" }], extra = {}) => ({ model, stream: true, instructions: "Codex instructions. Keep pi, pi-coding-agent and @earendil-works/pi-coding-agent unchanged.\n\nSecond paragraph.", input, ...extra });
async function post(adapter: CodexAnthropicAdapter, body: unknown) {
  return fetch(`${adapter.baseUrl}/responses`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
async function readEvents(response: Response): Promise<Record<string, any>[]> {
  return (await response.text()).split("\n\n").filter(Boolean).map(record => JSON.parse(record.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
}

describe("Codex Anthropic Responses adapter", () => {
  it("keeps Codex's prompt, fingerprints via the subscription package, and emits usage once", async () => {
    const originalFetch = globalThis.fetch;
    const upstream = vi.fn(async () => stream(textEvents()));
    const adapter = await start(upstream as unknown as typeof fetch);
    const body = request(undefined, { client_metadata: { "x-codex-turn-metadata": '{"turn_id":"native-turn"}', session_id: "native-session" } });
    const events = await readEvents(await post(adapter, body));
    expect(globalThis.fetch).toBe(originalFetch);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const payload = JSON.parse(String(init.body));
    expect(payload.system[0].text).toMatch(/x-anthropic-billing-header:.*cch=[0-9a-f]{5}/);
    expect(payload.system[0].text).not.toContain("cch=00000");
    expect(payload.system.at(-1).text).toBe(body.instructions);
    expect(payload.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(payload.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } }] }]);
    expect(JSON.parse(payload.metadata.user_id).session_id).toBe("codex-session");
    expect(payload.client_metadata).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer subscription-token");
    expect(new Headers(init.headers).get("user-agent")).toContain("claude-cli/");
    expect(new Headers(init.headers).get("x-claude-code-session-id")).toBe("codex-session");
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.filter(event => event.type === "response.completed")).toHaveLength(1);
    expect(events.at(-1)!.response.usage).toEqual({ input_tokens: 38, input_tokens_details: { cached_tokens: 20, cache_creation_tokens: 11 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 47 });
    expect(events.at(-1)!.response.output[0].content[0].text).toBe("Hello π 🌸");
  });

  it("round-trips function/custom tools, images, instruction updates and signed/redacted thinking", async () => {
    const thinking = { type: "thinking", thinking: "Check the file", signature: "signed-byte-string" };
    const redacted = { type: "redacted_thinking", data: "opaque-signed-block" };
    const toolInput = "*** Begin Patch\n*** End Patch\n";
    const tools = [{ type: "function", name: "exec_command", description: "Run command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }, { type: "custom", name: "apply_patch", description: "Edit", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }];
    const upstream = vi.fn(async () => stream(upstream.mock.calls.length === 1 ? [
      begin,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinking.thinking } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinking.signature } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: redacted }, { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_exec", name: "exec_command", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"cmd":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"pwd"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_patch", name: "apply_patch", input: {} } },
      { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: JSON.stringify({ input: toolInput }) } },
      { type: "content_block_stop", index: 3 }, ...end("tool_use"),
    ] : textEvents()));
    const adapter = await start(upstream as unknown as typeof fetch);
    const input = [{ role: "user", content: [{ type: "input_text", text: "Edit this" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "original" }] }, { role: "developer", content: "Keep current working directory." }];
    const first = await readEvents(await post(adapter, request(input, { tools, reasoning: { effort: "xhigh" } })));
    const output = first.at(-1)!.response.output;
    expect(output[0].encrypted_content).toBe(encodeThinking(thinking));
    expect(output[1].encrypted_content).toBe(encodeThinking(redacted));
    expect(output[2]).toMatchObject({ type: "function_call", name: "exec_command", call_id: "toolu_exec", arguments: '{"cmd":"pwd"}' });
    expect(output[3]).toMatchObject({ type: "custom_tool_call", name: "apply_patch", call_id: "toolu_patch", input: toolInput });
    await readEvents(await post(adapter, request([...input, ...output, { type: "function_call_output", call_id: "toolu_exec", output: "/work" }, { type: "custom_tool_call_output", call_id: "toolu_patch", output: [{ type: "input_text", text: "Applied" }, { type: "input_image", image_url: "https://example.com/image.png" }] }], { tools })));
    const payload = JSON.parse(String((upstream.mock.calls[1] as unknown as [unknown, RequestInit])[1].body));
    expect(payload.messages[0].content[1].source).toEqual({ type: "base64", media_type: "image/png", data: "aGVsbG8=" });
    expect(payload.messages[1]).toEqual({ role: "system", content: [{ type: "text", text: "Keep current working directory." }] });
    expect(payload.messages[2].content).toEqual([thinking, redacted, { type: "tool_use", name: "exec_command", id: "toolu_exec", input: { cmd: "pwd" } }, { type: "tool_use", name: "apply_patch", id: "toolu_patch", input: { input: toolInput } }]);
    expect(payload.messages[3].content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_exec", content: [{ type: "text", text: "/work" }] });
    expect(payload.tools[1].description).toContain("start: /.+/");
    const firstPayload = JSON.parse(String((upstream.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    expect(firstPayload.output_config.effort).toBe("xhigh");
  });

  it("refreshes only an explicit 401 and never retries 429 or uncertain failures", async () => {
    const credentials = vi.fn(async ({ refresh }: { refresh: boolean }) => ({ accessToken: refresh ? "fresh-token" : "expired-token" }));
    const upstream = vi.fn(async () => upstream.mock.calls.length === 1 ? new Response('{"error":{"type":"authentication_error","message":"expired"}}', { status: 401 }) : stream(textEvents()));
    const adapter = await start(upstream as unknown as typeof fetch, credentials);
    await readEvents(await post(adapter, request()));
    expect(credentials.mock.calls.map(([value]) => value.refresh)).toEqual([false, true]);
    expect(new Headers((upstream.mock.calls[1] as unknown as [unknown, RequestInit])[1].headers).get("authorization")).toBe("Bearer fresh-token");
    upstream.mockImplementation(async () => new Response('{"error":{"type":"rate_limit_error","message":"quota exhausted"}}', { status: 429, headers: { "retry-after": "30" } }));
    const limited = await post(adapter, request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(await limited.text()).toContain("quota exhausted");
    expect(upstream).toHaveBeenCalledTimes(3);
    upstream.mockImplementation(async () => { throw new Error("socket reset after upload"); });
    const failed = await post(adapter, request());
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("socket reset after upload");
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("keeps stream errors and truncation visible rather than reporting completion", async () => {
    const upstream = vi.fn(async () => stream(textEvents().slice(0, -1)));
    const adapter = await start(upstream as unknown as typeof fetch);
    const truncated = await readEvents(await post(adapter, request()));
    expect(truncated.at(-1)).toMatchObject({ type: "response.failed", response: { error: { code: "upstream_protocol_error" } } });
    expect(truncated.some(event => event.type === "response.completed")).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockImplementation(async () => stream([begin, { type: "error", error: { type: "overloaded_error", message: "busy" } }]));
    expect((await readEvents(await post(adapter, request()))).at(-1)).toMatchObject({ type: "response.failed", response: { error: { code: "overloaded_error", message: "Anthropic overloaded_error: busy" } } });
  });

  it("disconnect and close cancel pending upstream reads; close is idempotent", async () => {
    let upstreamSignal!: AbortSignal;
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const upstream = vi.fn(async (_url, init) => {
      upstreamSignal = init!.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(begin)}\n\n`)); }, cancel }), { headers: { "content-type": "text/event-stream" } });
    });
    const adapter = await start(upstream as unknown as typeof fetch);
    const result = await post(adapter, request());
    await result.body!.cancel();
    await cancelled;
    expect(upstreamSignal.aborted).toBe(true);
    let closeSignal!: AbortSignal;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    upstream.mockImplementation(async (_url, init) => {
      closeSignal = init!.signal as AbortSignal;
      entered();
      return await new Promise((_resolve, reject) => closeSignal.addEventListener("abort", () => reject(closeSignal.reason), { once: true }));
    });
    const pending = post(adapter, request()).catch(error => error);
    await entering;
    const firstClose = adapter.close();
    expect(adapter.close()).toBe(firstClose);
    await firstClose;
    expect(closeSignal.aborted).toBe(true);
    await pending;
    await expect(post(adapter, request())).rejects.toThrow();
  });

  it("rejects unsupported history and hosted tools before requesting credentials", async () => {
    const credentials = vi.fn(async () => ({ accessToken: "token" }));
    const upstream = vi.fn();
    const adapter = await start(upstream as unknown as typeof fetch, credentials);
    for (const body of [request([{ type: "reasoning", encrypted_content: "openai-ciphertext", summary: [] }]), request(undefined, { tools: [{ type: "web_search" }] }), request(undefined, { previous_response_id: "resp_previous" }), request([{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }])]) {
      const response = await post(adapter, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBeTruthy();
    }
    expect(credentials).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("close releases a request waiting for credentials even if the broker ignores cancellation", async () => {
    let entered!: () => void;
    let credentialSignal!: AbortSignal;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const upstream = vi.fn();
    const adapter = await startCodexAnthropicAdapter({ sessionId: "credentials-pending", fetch: upstream as unknown as typeof fetch, credentials: async ({ signal }) => {
      credentialSignal = signal;
      entered();
      return new Promise(() => {});
    } });
    adapters.push(adapter);
    const pending = post(adapter, request()).catch(error => error);
    await entering;
    await adapter.close();
    expect(credentialSignal.aborted).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
    await pending;
  });

  it("reports max-token exhaustion and refuses unsigned thinking or malformed custom calls", async () => {
    const upstream = vi.fn(async () => stream([...textEvents().slice(0, -2), ...end("max_tokens")]));
    const adapter = await start(upstream as unknown as typeof fetch);
    const incomplete = (await readEvents(await post(adapter, request()))).at(-1)!;
    expect(incomplete).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { total_tokens: 47 } } });
    upstream.mockImplementation(async () => stream([begin, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Unverifiable", signature: "" } }, { type: "content_block_stop", index: 0 }, ...end()]));
    const unsigned = await readEvents(await post(adapter, request()));
    expect(unsigned.at(-1)).toMatchObject({ type: "response.failed", response: { error: { message: "Anthropic thinking has no replay signature" } } });
    expect(unsigned.some(event => event.type === "response.output_item.done")).toBe(false);
    upstream.mockImplementation(async () => stream([begin, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bad", name: "apply_patch", input: { command: "wrong shape" } } }, { type: "content_block_stop", index: 0 }, ...end("tool_use")]));
    const malformed = await readEvents(await post(adapter, request(undefined, { tools: [{ type: "custom", name: "apply_patch" }] })));
    expect(malformed.at(-1)).toMatchObject({ type: "response.failed", response: { error: { message: "Anthropic custom tool input must be an object containing only an input string" } } });
    expect(malformed.some(event => event.type === "response.output_item.done")).toBe(false);
  });

  it("uses catalog effort capabilities and keeps namespace calls reversible", () => {
    for (const [effort, mapped] of [["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]]) {
      const translated = translateAnthropicRequest(request(undefined, { reasoning: { effort } }));
      expect(translated.payload.output_config).toEqual({ effort: mapped });
    }
    expect(() => translateAnthropicRequest(request(undefined, { reasoning: { effort: "none" } }))).toThrow("cannot disable thinking");
    const translated = translateAnthropicRequest(request(undefined, { tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "tools/run", parameters: { type: "object" } }] }] }));
    expect([...translated.tools.values()]).toEqual([{ type: "function", name: "tools/run", namespace: "functions" }]);
    expect((translated.payload.tools as any[])[0].name).toMatch(/^codex_[a-f0-9]+$/);
  });
});
