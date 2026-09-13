import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { channel } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import { EventEmitter, once } from "node:events";
import { startCodexAnthropicAdapter, type CodexAnthropicAdapter } from "../src/cores/codex-anthropic.js";
import type { AnthropicResponseUsage } from "../src/cores/codex-anthropic-stream.js";
import { openCodexRpc, type CodexRpc, type Json } from "../src/cores/codex-rpc.js";
import { openCodexProcess } from "../src/cores/codex-process.js";
import type { ThreadTokenUsage } from "../src/cores/codex-protocol/v2/ThreadTokenUsage.js";

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

it("pinned Codex 0.154 executes a native tool, replays signed thinking, and counts each upstream response once", async () => {
  const binary = join(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")), "bin", "codex.js");
  expect(execFileSync(process.execPath, [binary, "--version"], { encoding: "utf8", timeout: 5_000 }).trim()).toBe("codex-cli 0.154.0");
  const root = mkdtempSync(join(tmpdir(), "codex-anthropic-native-"));
  mkdirSync(join(root, "codex"));
  let diagnostics = "";
  const thinking = { type: "thinking", thinking: "Run the native tool before answering.", signature: "native-signed-thinking-envelope" };
  const marker = "native-tool-executed";
  const nativeRequests: Json[] = [];
  const nativePaths: string[] = [];
  const events = new EventEmitter();
  const nativeRequestChannel = channel("http.server.request.start");
  const captureRequest = (event: unknown) => {
    const request = (event as { request: IncomingMessage }).request;
    nativePaths.push(request.url ?? "");
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => nativeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  };
  nativeRequestChannel.subscribe(captureRequest);
  const requests: Json[] = [];
  const providerUsage = new Map<string, AnthropicResponseUsage>();
  const notifications: { method: string; params: Json }[] = [];
  const serverRequests: string[] = [];
  let selectedTool: string | undefined;
  let toolInput: Json | undefined;
  let rpc: CodexRpc | undefined;
  let adapter: CodexAnthropicAdapter | undefined;
  let phase: "roundtrip" | "compact" | "error" | "max_tokens" = "roundtrip";
  const completed = () => once(events, "native:turn/completed", { signal: AbortSignal.timeout(10_000) }).then(([params]) => params as Json);
  const upstream = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init!.body));
    requests.push(request);
    if (phase === "error") return sse([
      { type: "message_start", message: { id: "msg_failure", role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "error", error: { type: "overloaded_error", message: "native-visible-upstream-overload" } },
    ]);
    const first = requests.length === 1;
    const begin = { type: "message_start", message: { id: `msg_native_${requests.length}`, role: "assistant", content: [], usage: {
      input_tokens: first ? 7 : 13, output_tokens: 1, cache_read_input_tokens: first ? 20 : 30, cache_creation_input_tokens: first ? 11 : 17,
    } } };
    const end = [{ type: "message_delta", delta: { stop_reason: first ? "tool_use" : phase === "max_tokens" ? "max_tokens" : "end_turn" }, usage: { output_tokens: first ? 9 : 15 } }, { type: "message_stop" }];
    if (!first) return sse([begin,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Native tool completed." } },
      { type: "content_block_stop", index: 0 }, ...end,
    ]);
    const tool = request.tools.find((candidate: any) => candidate.input_schema?.properties?.cmd || candidate.input_schema?.properties?.command);
    if (!tool) throw new Error(`Native command tool missing: ${JSON.stringify(request.tools)}`);
    selectedTool = tool.name;
    const command = `printf '${marker}' > native-tool-result.txt; printf '${marker}'`;
    toolInput = tool.input_schema.properties.cmd ? { cmd: command } : { command };
    return sse([begin,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinking.thinking } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinking.signature } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_native", name: selectedTool, input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } },
      { type: "content_block_stop", index: 1 }, ...end,
    ]);
  });
  try {
    adapter = await startCodexAnthropicAdapter({ sessionId: "native-integration", credentials: async () => ({ accessToken: "fake-native-token" }), fetch: upstream as unknown as typeof fetch,
      recordUsage: usage => { providerUsage.set(usage.providerResponseId, usage); } });
    rpc = openCodexRpc({ cwd: root, binary,
      launchProcess(options) {
        const owner = openCodexProcess(options);
        owner.child.stderr.on("data", chunk => { diagnostics += chunk; });
        return owner;
      },
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, "codex"), RUST_LOG: "error" },
      args: ["-c", 'model_provider="pistack-anthropic"', "-c",
        `model_providers.pistack-anthropic={name="Anthropic",base_url=${JSON.stringify(adapter.baseUrl)},wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
        "-c", 'web_search="disabled"', "-c", 'cli_auth_credentials_store="ephemeral"'],
      sanitizeError: message => message,
      notification(method, params) {
        notifications.push({ method, params });
        events.emit(`native:${method}`, params);
      },
      async serverRequest(method) { serverRequests.push(method); return { ok: false, error: `Unexpected client request ${method}` }; },
      exit() {},
    });
    const call = async (method: string, params: Json) => {
      const result = await rpc!.request(method, params);
      if (!result.ok) throw new Error(`${result.error}\n${diagnostics}`);
      return result.value;
    };
    await call("initialize", { clientInfo: { name: "native-anthropic-test", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const started = await call("thread/start", { cwd: root, model: "claude-fable-5-1", modelProvider: "pistack-anthropic", approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true });
    const threadId = (started.thread as Json).id;
    const finished = completed();
    await call("turn/start", { threadId, input: [{ type: "text", text: "Run the native command tool, then report completion.", text_elements: [] }] });
    const turn = await finished;
    expect(turn, JSON.stringify({ errors: notifications.filter(event => event.method === "error"), nativeRequests })).toMatchObject({ threadId, turn: { status: "completed" } });
    expect(serverRequests).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, "native-tool-result.txt"), "utf8")).toBe(marker);
    const messages = requests[1].messages as any[];
    const assistant = messages.find(message => message.role === "assistant" && message.content.some((block: any) => block.type === "tool_use"));
    expect(assistant.content).toEqual(expect.arrayContaining([thinking, { type: "tool_use", id: "toolu_native", name: selectedTool, input: toolInput }]));
    const result = messages.flatMap(message => message.content).find(block => block.type === "tool_result" && block.tool_use_id === "toolu_native");
    expect(result.is_error).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(marker);
    expect(notifications.some(event => event.method === "item/completed" && (event.params.item as Json)?.type === "commandExecution")).toBe(true);
    const usage = notifications.filter(event => event.method === "thread/tokenUsage/updated").map(event => event.params.tokenUsage as ThreadTokenUsage);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ total: { inputTokens: 38, cachedInputTokens: 20, outputTokens: 9, totalTokens: 47 } });
    expect(usage[1]).toMatchObject({
      last: { inputTokens: 60, cachedInputTokens: 30, outputTokens: 15, totalTokens: 75 },
      total: { inputTokens: 98, cachedInputTokens: 50, outputTokens: 24, totalTokens: 122 },
    });

    phase = "compact";
    const compacted = completed();
    await call("thread/compact/start", { threadId });
    expect(await compacted, JSON.stringify({ notifications, nativePaths })).toMatchObject({ threadId, turn: { status: "completed" } });
    expect(nativePaths).toEqual(["/responses", "/responses", "/responses"]);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(notifications.some(event => event.method === "item/completed" && (event.params.item as Json)?.type === "contextCompaction")).toBe(true);

    phase = "error";
    const failed = completed();
    await call("turn/start", { threadId, input: [{ type: "text", text: "Trigger the fake upstream overload.", text_elements: [] }] });
    const failedTurn = await failed;

    phase = "max_tokens";
    const limited = completed();
    await call("turn/start", { threadId, input: [{ type: "text", text: "Trigger the fake output limit.", text_elements: [] }] });
    const limitedTurn = await limited;
    expect({ failedTurn, limitedTurn }, JSON.stringify({ failedTurn, limitedTurn, usage: notifications.filter(event => event.method === "thread/tokenUsage/updated").map(event => event.params.tokenUsage) })).toMatchObject({
      failedTurn: { threadId, turn: { status: "failed", error: { message: expect.stringContaining("native-visible-upstream-overload") } } },
      limitedTurn: { threadId, turn: { status: "failed", error: { message: expect.stringContaining("max_output_tokens") } } },
    });
    expect([...providerUsage.values()].reduce((total, usage) => total + usage.totalTokens, 0)).toBe(274);
    expect(providerUsage.get("msg_native_5")).toMatchObject({ inputTokens: 60, cachedInputTokens: 30, cacheWriteInputTokens: 17, outputTokens: 15, totalTokens: 75 });
    expect(providerUsage.get("msg_failure")).toMatchObject({ inputTokens: 2, outputTokens: 0 });
  } finally {
    nativeRequestChannel.unsubscribe(captureRequest);
    await rpc?.close();
    await adapter?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
