import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
const biscuitFailure = { type: "response.failed", response: { id: "resp_failed", error: { code: "server_error", message: "no_biscuit_no_service" }, output: [] } };
const accessFailure = { type: "error", message: "The access_programs parameter is not enabled for this organization." };
const completed = { type: "response.completed", response: { id: "resp_success", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };

for (const [name, path, packageRoot] of [
  ["SDK", sdk, dirname(dirname(dirname(sdk)))],
  ["bundled CLI", bundle, dirname(dirname(dirname(chunks)))],
]) test(`${name} bounded Codex service recovery`, async (t) => {
  const installedSource = readFileSync(path, "utf8");
  const installedFiles = readdirSync(dirname(path));
  const source = patchCodexServiceRecovery(patchCodexSse(installedSource));
  assert.equal(patchCodexServiceRecovery(source), source);
  assert.equal(patchCodexServiceRecovery(source.replace("access_programs_not_enabled", "stale-recovery-helper")), source);
  const fixture = mkdtempSync(join(tmpdir(), "pi-codex-service-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const fixturePackage = join(fixture, "provider");
  cpSync(packageRoot, fixturePackage, { recursive: true });
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
  const temporary = join(fixturePackage, relative(packageRoot, path));
  writeFileSync(temporary, source);
  const provider = await import(pathToFileURL(temporary).href);
  assert.deepEqual(readdirSync(dirname(path)), installedFiles, "provider fixtures must not enter the installed module directory");
  assert.equal(readFileSync(path, "utf8"), installedSource, "provider fixtures must not modify installed source");
  const originalWebSocket = globalThis.WebSocket;
  try {
    for (const transport of ["sse", "websocket-cached"]) {
      for (const failure of [biscuitFailure, accessFailure]) for (const scenario of ["recovered", "twice", "other-error", "auth-error", "partial-output", "native-output", "failed-output", "usage", "aborted", "compaction-recovered", ...(failure === accessFailure ? ["client-parameter", "auth-code"] : [])]) {
        let calls = 0, payloadCalls = 0;
        const requests = [], headers = [], events = [];
        const controller = new AbortController();
        const observer = compactionObserver();
        const plan = () => {
          calls++;
          if (scenario === "aborted") controller.abort();
          if (scenario === "other-error") return [{ type: "error", message: "Not Found" }];
          if (scenario === "auth-error") return [{ type: "error", code: "invalid_api_key", message: "Provided authentication token is expired." }];
          if (scenario === "auth-code") return [{ ...accessFailure, code: "invalid_api_key" }];
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
          maxRetries: 0, serviceTier: "priority",
          onPayload(body) { payloadCalls++; body.input.unshift(checkpoint); if (scenario === "client-parameter") body.access_programs = []; return body; },
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
        assert.equal(requests[0].service_tier, "priority");
        assert.equal(Object.hasOwn(requests[0], "access_programs"), scenario === "client-parameter");
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
          assert.equal(output.diagnostics.at(-1).details.reason, failure === accessFailure ? "access_programs_not_enabled" : "no_biscuit_no_service");
        }
        if (scenario === "twice") assert.equal(output.errorMessage, failure === accessFailure ? `Codex error: ${failure.message}` : "no_biscuit_no_service");
        if (scenario === "partial-output") assert.equal(output.content[0].text, "Visible");
        if (scenario === "compaction-recovered" && transport === "sse") assert.deepEqual(observer.result(), { ok: true, value: checkpoint });
        provider.closeOpenAICodexWebSocketSessions();
      }
    }
  } finally { globalThis.WebSocket = originalWebSocket; provider.closeOpenAICodexWebSocketSessions(); }
});
