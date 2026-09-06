import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const runtimeEntry = process.env.PI_TEST_RUNTIME_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, RpcClient, SessionManager, SettingsManager } = await import(runtimeEntry);

const provider = "anthropic";
const first = "claude-sonnet-4-5";
const second = "claude-opus-4-5";
const defaults = { defaultThinkingLevel: "low", modelThinkingLevels: { [`${provider}/${second}`]: "minimal" } };

function agentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-thinking-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "test-no-network" } }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(defaults));
  return dir;
}

test("SDK defaults only initialize thinking; saved levels survive resume and model changes", async (t) => {
  const dir = agentDir(t);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  const model = modelRuntime.getModel(provider, first);
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory(defaults);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  for (const saved of [undefined, "high", "off"]) {
    const sessionManager = SessionManager.inMemory(dir);
    if (saved !== undefined) sessionManager.appendThinkingLevelChange(saved);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, settingsManager, resourceLoader, sessionManager });
    try {
      assert.equal(session.thinkingLevel, saved ?? "low");
      await session.setModel(modelRuntime.getModel(provider, second));
      assert.equal(session.thinkingLevel, saved ?? "low");
      await session.setModel(model);
      assert.equal(session.thinkingLevel, saved ?? "low");
    } finally {
      session.dispose();
    }
  }
});

test("bundled RPC preserves session thinking over global and per-model defaults", async (t) => {
  const dir = agentDir(t);
  const cliPath = fileURLToPath(new URL("bundle/cli.js", runtimeEntry));
  const client = new RpcClient({ cliPath, cwd: dir, provider, model: first, env: { PI_CODING_AGENT_DIR: dir }, args: ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--thinking", "high"] });
  await client.start();
  try {
    assert.equal((await client.getState()).thinkingLevel, "high");
    await client.setModel(provider, second);
    assert.equal((await client.getState()).thinkingLevel, "high");
    await client.setThinkingLevel("off");
    await client.setModel(provider, first);
    assert.equal((await client.getState()).thinkingLevel, "off");
  } finally {
    await client.stop();
  }
});
