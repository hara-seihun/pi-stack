import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import codexCompaction from "./index.mjs";
import { KIND } from "./native.mjs";
import { readFileSync } from "node:fs";
import { patchCompactionErrors, patchContextErrors } from "../../patch-compaction-errors.mjs";

const agentSessionUrl = new URL("core/agent-session.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const patchedSource = patchCompactionErrors(readFileSync(agentSessionUrl, "utf8")).replace(/from "([^"]+)"/gu, (_match, specifier) => `from "${specifier.startsWith(".") ? new URL(specifier, agentSessionUrl).href : import.meta.resolve(specifier)}"`);
const { AgentSession: PatchedSession } = await import(`data:text/javascript;base64,${Buffer.from(patchedSource).toString("base64")}`);
const runnerUrl = new URL("core/extensions/runner.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const runnerSource = patchContextErrors(readFileSync(runnerUrl, "utf8")).replace(/from "([^"]+)"/gu, (_match, specifier) => `from "${specifier.startsWith(".") ? new URL(specifier, runnerUrl).href : import.meta.resolve(specifier)}"`);
const { ExtensionRunner: PatchedRunner } = await import(`data:text/javascript;base64,${Buffer.from(runnerSource).toString("base64")}`);

for (const outcome of ["success", "failure", "post-failure", "cancel"]) test(`Pi completes parallel tools and handles native compaction ${outcome}`, { timeout: 4000 }, async () => {
  const failFirst = outcome !== "success", cancelFirst = outcome === "cancel";
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-lifecycle-"));
  let calls = 0, tools = 0, compacted = 0;
  const bodies = [], failures = [];
  const encrypted = { type: "compaction", id: "cp_test", encrypted_content: "checkpoint" };
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString());
      bodies.push(body);
      let output, inputTokens;
      if (body.input.at(-1)?.type === "compaction_trigger") {
        assert.equal(tools, 2);
        assert.equal(body.input.filter(item => item.type === "function_call_output").length, 2);
        compacted++;
        if (cancelFirst && compacted === 1) { void session.abort(); response.end(); return; }
        if (failFirst && compacted === 1) { response.writeHead(503); response.end("fixture unavailable: fetch failed"); return; }
        output = [encrypted]; inputTokens = 100;
      } else if (++calls === 1) {
        output = [1, 2].map(n => ({ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "probe", arguments: "{}", status: "completed" }));
        inputTokens = 9500;
      } else {
        assert.equal(compacted, failFirst ? 2 : 1);
        assert.equal(body.input.filter(item => item.type === "compaction").length, 1);
        assert.equal(body.input.filter(item => item.type === "function_call_output").length, 0);
        output = [{ type: "message", id: "msg_final", role: "assistant", content: [{ type: "output_text", text: "finished", annotations: [] }], status: "completed" }];
        inputTokens = 100;
      }
      const events = output.map((item, output_index) => ({ type: "response.output_item.done", item, output_index }));
      events.push({ type: "response.completed", response: { id: `resp_${bodies.length}`, status: "completed", output, usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 } } });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) { failures.push(error); response.writeHead(500); response.end("fixture failed"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let session;
  try {
    const family = openaiCodexProvider();
    const model = { ...family.getModels().find(model => model.id === "gpt-5.6-luna"), provider: "openai-codex-42", baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 10000, maxTokens: 1000 };
    const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.c`;
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
    modelRuntime.registerNativeProvider({ ...family, id: model.provider, baseUrl: model.baseUrl, auth: { apiKey: { name: "fixture", check: async () => ({ type: "api_key", source: "fixture" }), resolve: async () => ({ auth: { apiKey: token }, source: "fixture" }), login: async () => ({ type: "api_key", key: token }) } }, getModels: () => [model], stream: (m, context, options) => family.stream(m, context, { ...options, transport: "sse" }), streamSimple: (m, context, options) => family.streamSimple(m, context, { ...options, transport: "sse" }) });
    await modelRuntime.refresh({ providers: [model.provider], allowNetwork: false });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 8 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [codexCompaction, pi => pi.registerTool({ name: "probe", label: "Probe", description: "Return fixture data", parameters: Type.Object({}), async execute() { tools++; return { content: [{ type: "text", text: "tool result" }], terminate: outcome === "post-failure" }; } })] });
    await resourceLoader.reload();
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, resourceLoader, settingsManager, sessionManager, tools: ["probe"], thinkingLevel: "minimal" }));
    Object.setPrototypeOf(session, PatchedSession.prototype);
    const events = [];
    session.subscribe(event => events.push(event));
    await session.bindExtensions({ mode: "print", onError: error => failures.push(error) });
    Object.setPrototypeOf(session.extensionRunner, PatchedRunner.prototype);
    await session.prompt("fixture ".repeat(128));
    if (failFirst) {
      assert.equal(calls, 1, "no chat request after the failed checkpoint");
      assert.equal(compacted, 1);
      assert.equal(tools, 2);
      assert.equal(sessionManager.getBranch().some(entry => entry.type === "compaction"), false);
      assert.ok(events.some(event => event.type === "compaction_end" && (cancelFirst ? event.aborted : !event.aborted && /fixture unavailable/.test(event.errorMessage))));
      let last = session.messages.at(-1);
      assert.equal(last.stopReason, cancelFirst ? "aborted" : "error");
      if (!cancelFirst) assert.match(last.errorMessage, /fixture unavailable: fetch failed/);
      assert.equal(sessionManager.getBranch().filter(entry => entry.customType === "codex-compaction-attempt").at(-1).data.state, cancelFirst ? "cancelled" : "failed");
      await session.prompt("attempt automatic recovery");
      last = session.messages.at(-1);
      assert.equal(last.stopReason, "error");
      assert.match(last.errorMessage, cancelFirst ? /Context rejected: Native compaction cancelled:/ : /Context rejected: Native compaction failed: fixture unavailable: fetch failed/);
      assert.equal(events.filter(event => event.type === "auto_retry_start").length, 0);
      assert.equal(compacted, 1, "new prompts cannot bypass the persisted fence");
      assert.equal(calls, 1);
      await session.compact();
      await session.prompt("continue after explicit recovery");
    }
    assert.deepEqual(failures, []);
    assert.equal(calls, 2);
    assert.equal(compacted, failFirst ? 2 : 1);
    assert.equal(events.filter(event => event.type === "agent_start").length, outcome === "post-failure" ? 4 : failFirst ? 3 : 1);
    assert.equal(events.filter(event => event.type === "agent_end").length, outcome === "post-failure" ? 4 : failFirst ? 3 : 1);
    const branch = sessionManager.getBranch();
    assert.equal(branch.filter(entry => entry.type === "message" && entry.message.role === "user").length, failFirst ? 3 : 1);
    assert.equal(branch.filter(entry => entry.type === "message" && entry.message.role === "toolResult").length, 2);
    assert.equal(branch.find(entry => entry.type === "compaction").details.kind, KIND);
    assert.equal(SessionManager.open(sessionManager.getSessionFile()).getBranch().find(entry => entry.type === "compaction").details.replacementHistory.at(-1).encrypted_content, "checkpoint");
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
