import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  routing: { type: "string", default: fileURLToPath(new URL("../src/extension/routing.ts", import.meta.url)) },
  output: { type: "string" }, model: { type: "string", default: "gpt-image-2.5-flare" },
  expect: { type: "string", default: "enabled" },
} });
assert.ok(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(values.model));
assert.ok(["enabled", "disabled"].includes(values.expect));
const routing = resolve(values.routing);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const cwd = process.cwd();
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [routing],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
try {
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  const enabled = session.getActiveToolNames().includes("image_generation");
  assert.equal(enabled, values.expect === "enabled");
  const result = { enabled, routing };
  if (values.output) {
    assert.ok(enabled);
    const tool = session.extensionRunner.getAllRegisteredTools().find(tool => tool.definition.name === "image_generation").definition;
    const generated = await tool.execute(crypto.randomUUID(), {
      prompt: "A solid blue circle centered on a white background, no text.",
      outputPath: resolve(values.output), model: values.model, quality: "low", size: "1024x1024",
    }, AbortSignal.timeout(45000), undefined, session.extensionRunner.createContext());
    assert.equal(generated.content[1].type, "image");
    Object.assign(result, generated.details);
  }
  console.log(JSON.stringify(result));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
