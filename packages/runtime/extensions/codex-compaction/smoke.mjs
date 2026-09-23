import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { findCheckpoint } from "./native.mjs";

const { values } = parseArgs({ options: { "history-file": { type: "string" }, "continuation-file": { type: "string" }, "routing-entry": { type: "string" }, "switch-account": { type: "boolean", default: false } } });
for (const key of ["history-file", "continuation-file", "routing-entry"]) if (!values[key]) throw new Error(`Required: --${key}`);
const history = await readFile(values["history-file"], "utf8");
const continuation = await readFile(values["continuation-file"], "utf8");
if (!history.trim() || !continuation.trim()) throw new Error("Smoke input files must contain user-supplied text");
for (const key of Object.keys(process.env)) if (/^PI_REMOTE_|^PI_SESSION_|^PI_ORCHESTRATOR_RUN_ID$|^PI_SUBAGENT_MODEL$|^PI_PROVIDER$|^PI_MODEL$|^PI_REASONING_LEVEL$/u.test(key)) delete process.env[key];
process.env.PI_ORCHESTRATOR_ASSIGNED = "0";
const root = await mkdtemp(join(tmpdir(), "pi-codex-compaction-smoke-"));
let session, deadline;
try {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 2048 } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [join(dirname(values["routing-entry"]), `usage-logger${extname(values["routing-entry"])}`), values["routing-entry"], fileURLToPath(new URL("index.mjs", import.meta.url))] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, sessionManager, model: modelRuntime.getModel("openai-codex", "gpt-5.6-luna"), thinkingLevel: "minimal", tools: [] }));
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  assert.match(session.model.provider, /^openai-codex-\d+$/u);
  deadline = setTimeout(() => { session.abortCompaction(); void session.abort(); }, 50_000);
  sessionManager.appendMessage({ role: "user", content: history, timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: history.slice(0, 100) }], api: session.model.api, provider: session.model.provider, model: session.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  sessionManager.appendMessage({ role: "user", content: `${history}\n${continuation}`, timestamp: Date.now() });
  sessionManager.appendMessage({ role: "user", content: continuation, timestamp: Date.now() });
  session.agent.state.messages = sessionManager.buildSessionContext().messages;
  await session.compact();
  const checkpoint = findCheckpoint(sessionManager.getBranch());
  assert.equal(checkpoint.ok, true);
  assert.ok(checkpoint.value);
  const saved = SessionManager.open(sessionManager.getSessionFile());
  assert.deepEqual(findCheckpoint(saved.getBranch()).value.details, checkpoint.value.details);
  const fork = SessionManager.forkFrom(sessionManager.getSessionFile(), root, join(root, "forks"));
  assert.deepEqual(findCheckpoint(fork.getBranch()).value.details, checkpoint.value.details);
  const producer = session.model.provider;
  if (values["switch-account"]) {
    const alternate = (await modelRuntime.getAvailable()).find(model => model.id === session.model.id && model.api === session.model.api && model.provider !== producer && /^openai-codex-\d+$/u.test(model.provider));
    assert.ok(alternate, "No second shared account is available for the smoke check");
    await session.setModel(alternate);
    assert.equal(session.model.provider, alternate.provider);
  }
  await session.prompt(continuation);
  const response = sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1).message;
  assert.equal(response.stopReason, "stop", response.errorMessage);
  if (values["switch-account"]) assert.notEqual(session.model.provider, producer, "Continuation returned to the checkpoint's producing account");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ producer, provider: session.model.provider, model: session.model.id, checkpointEntry: checkpoint.value.entry.id, nativeItemCount: checkpoint.value.details.replacementHistory.filter(item => item.type === "compaction").length, compactionUsage: checkpoint.value.entry.usage, continuationUsage: response.usage, resumed: true, forked: true, answer: response.content.filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 2000) }));
} finally {
  clearTimeout(deadline);
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(root, { recursive: true, force: true });
}
