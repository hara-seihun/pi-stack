import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { patchCodexServiceRecovery } from "./patch-codex-service-recovery.mjs";
import { patchCodexSse } from "./patch-codex-sse.mjs";
import { compactionObserver } from "./extensions/codex-compaction/native.mjs";

const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses"));
const chunks = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/chunks");
const bundle = join(chunks, readdirSync(chunks).find(name => /^openai-codex-responses-[^.]+\.js$/u.test(name)));
const model = { api: "openai-codex-responses", provider: "openai-codex-11", id: "gpt-6-astra", baseUrl: "https://example.test/backend-api", reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c`;
const checkpoint = { type: "compaction", encrypted_content: "fixture-checkpoint" };
const created = { type: "response.created", response: { id: "resp_failed", status: "in_progress", output: [] } };
const failure = { type: "response.failed", response: { id: "resp_failed", error: { code: "server_error", message: "no_biscuit_no_service" }, output: [] } };
const completed = { type: "response.completed", response: { id: "resp_success", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };

for (const [name, path] of [["SDK", sdk], ["bundled CLI", bundle]]) test(`${name} bounded Codex service recovery`, async () => {
  const source = patchCodexServiceRecovery(patchCodexSse(readFileSync(path, "utf8")));
  assert.equal(patchCodexServiceRecovery(source), source);
  const temporary = join(dirname(path), `codex-service-test-${process.pid}.js`);
  writeFileSync(temporary, source);
  const provider = await import(pathToFileURL(temporary).href);
  const originalWebSocket = globalThis.WebSocket;
  try {
    for (const transport of ["sse", "websocket-cached"]) {
      for (const scenario of ["recovered", "twice", "other-error", "partial-output", "native-output", "failed-output", "usage", "aborted", "compaction-recovered"]) {
        let calls = 0, payloadCalls = 0;
        const requests = [], headers = [], events = [];
        const controller = new AbortController();
        const observer = compactionObserver();
        const plan = () => {
          calls++;
          if (scenario === "aborted") controller.abort();
          if (scenario === "other-error") return [{ ...failure, response: { ...failure.response, error: { message: "Not Found" } } }];
          if (scenario === "usage") return [{ ...failure, response: { ...failure.response, usage: { output_tokens: 1 } } }];
          if (scenario === "failed-output") return [{ ...failure, response: { ...failure.response, output: [checkpoint] } }];
          if (scenario === "native-output") return [{ type: "response.output_item.done", item: checkpoint, output_index: 0 }, failure];
          if (scenario === "partial-output") return [created,
            { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
            { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Visible" }, failure];
          return calls === 1 || scenario === "twice" ? [created, { type: "response.queued", response: { output: [] } }, failure] : scenario === "compaction-recovered" ? [
            { type: "response.output_item.done", output_index: 0, item: checkpoint },
            { ...completed, response: { ...completed.response, output: [checkpoint] } },
          ] : [completed];
        };
        globalThis.WebSocket = class extends EventTarget {
          readyState = 0;
          constructor(_url, options) {
            super(); headers.push(new Headers(options.headers));
            queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
          }
          send(body) {
            requests.push(JSON.parse(body));
            const planned = plan();
            queueMicrotask(() => { for (const event of planned) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); });
          }
          close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
        };
        const stream = provider.stream(model, { messages: [{ role: "user", content: "Continue", timestamp: 1 }] }, {
          transport, apiKey: token, sessionId: `fixture-${name}-${transport}-${scenario}`, signal: controller.signal,
          maxRetries: 0,
          onPayload(body) { payloadCalls++; body.input.unshift(checkpoint); return body; },
          fetch: async (_url, options) => {
            headers.push(new Headers(options.headers));
            requests.push(JSON.parse(options.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(options.body).toString() : options.body));
            return observer.wrap(new Response(plan().map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
          },
        });
        for await (const event of stream) events.push(event);
        const output = await stream.result();
        const recovered = scenario === "recovered" || scenario === "compaction-recovered";
        const retried = recovered || scenario === "twice";
        assert.equal(calls, retried ? 2 : 1, `${transport}/${scenario}: request count`);
        assert.equal(payloadCalls, 1);
        assert.ok(events.filter(event => event.type === "start").length <= 1, `${transport}/${scenario}: duplicate start`);
        assert.equal(events.filter(event => event.type === "done" || event.type === "error").length, 1);
        assert.equal(output.stopReason, recovered ? "stop" : scenario === "aborted" ? "aborted" : "error");
        assert.equal(output.diagnostics?.filter(item => item.type === "provider_service_retry").length ?? 0, retried ? 1 : 0);
        if (retried) {
          assert.deepEqual(requests[0], requests[1]);
          assert.equal(requests[1].previous_response_id, undefined);
          assert.deepEqual(requests[1].input[0], checkpoint);
          assert.deepEqual([...headers[0]], [...headers[1]]);
          assert.equal(output.diagnostics.at(-1).details.responseId, "resp_failed");
        }
        if (scenario === "twice") assert.equal(output.errorMessage, "no_biscuit_no_service");
        if (scenario === "partial-output") assert.equal(output.content[0].text, "Visible");
        if (scenario === "compaction-recovered" && transport === "sse") assert.deepEqual(observer.result(), { ok: true, value: checkpoint });
        provider.closeOpenAICodexWebSocketSessions();
      }
    }
  } finally { globalThis.WebSocket = originalWebSocket; provider.closeOpenAICodexWebSocketSessions(); unlinkSync(temporary); }
});
