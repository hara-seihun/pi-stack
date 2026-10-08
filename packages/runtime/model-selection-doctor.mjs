#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function modelSelectionDoctor(runtimeEntry = process.env.PI_TEST_RUNTIME_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent")) {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(runtimeEntry);
  const sessions = new Set();
  const dir = await mkdtemp(join(tmpdir(), "pi-model-selection-"));
  let requests = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, "explicit-model");
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"id":"doctor","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"explicit-provider-worked"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = "doctor-explicit";
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
  const cli = fileURLToPath(new URL("bundle/cli.js", runtimeEntry));
  const flags = ["--print", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-tools", "--offline"];
  const run = args => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...flags, ...args, "doctor"], { cwd: dir, env, timeout: 12000 }, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.end();
  });
  const defaults = { defaultProvider: "openai-codex", defaultModel: "gpt-6-astra", defaultThinkingLevel: "low" };
  let settings = defaults;
  let runtime;
  const settingsPath = join(dir, "settings.json");
  async function open(model, factories = [], manager = SessionManager.inMemory(dir)) {
    const settingsManager = SettingsManager.inMemory(settings);
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: factories });
    await resourceLoader.reload();
    const opened = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager: manager, model, tools: [] });
    sessions.add(opened.session);
    return opened;
  }
  try {
    await writeFile(join(dir, "auth.json"), "{}");
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { [provider]: { explicitOnly: true, baseUrl, api: "openai-completions", apiKey: "doctor-not-a-credential", models: [{ id: "explicit-model", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 128 }] } } }));
    runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false });
    assert.equal(runtime.getError(), undefined);
    assert.equal(runtime.isExplicitOnly(provider), true);
    assert.ok(runtime.getAvailableSnapshot().some(model => model.provider === provider), "manual catalog must retain explicit-only provider");
    let result = await open();
    assert.equal(result.session.model.provider, defaults.defaultProvider);
    assert.equal(result.session.model.id, defaults.defaultModel);
    result.session.dispose();
    settings = {};
    result = await open();
    assert.notEqual(result.session.model?.provider, provider, "automatic selection must exclude explicit-only provider");
    result.session.dispose();
    settings = { ...defaults, defaultModel: "unavailable-requested-model" };
    await assert.rejects(open(), /Configured model .* not found/);
    settings = { defaultProvider: provider, defaultModel: "explicit-model" };
    await assert.rejects(open(), /requires explicit model selection/);
    const explicit = runtime.getModel(provider, "explicit-model");
    settings = {};
    const saved = SessionManager.inMemory(dir);
    saved.appendModelChange(provider, explicit.id);
    saved.appendMessage({ role: "user", content: "saved selection", timestamp: Date.now() });
    result = await open(undefined, [], saved);
    assert.equal(result.session.model.provider, provider, "saved manual selection remains eligible");
    result.session.dispose();
    saved.appendModelChange(provider, "unavailable-saved-model");
    await assert.rejects(open(undefined, [], saved), /Saved model .* not found/);
    settings = { defaultProvider: "doctor-registered", defaultModel: "late-model" };
    result = await open(undefined, [pi => pi.registerProvider("doctor-registered", { baseUrl, api: "openai-completions", apiKey: "doctor-not-a-credential", models: [{ id: "late-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 128 }] })]);
    assert.equal(result.session.model.provider, "doctor-registered", "SDK selection must see pending extension providers");
    result.session.dispose();
    for (const event of ["session_start", "before_agent_start", "before_provider_request", "before_provider_headers"]) {
      result = await open(explicit, [pi => pi.on(event, () => { throw new Error("requested-route-unavailable"); })]);
      try {
        if (event === "session_start") await assert.rejects(result.session.bindExtensions({ mode: "print" }), /requested-route-unavailable/);
        else {
          await result.session.bindExtensions({ mode: "print" });
          if (event === "before_agent_start") await assert.rejects(result.session.prompt("doctor"), /requested-route-unavailable/);
          else {
            await result.session.prompt("doctor");
            assert.equal(result.session.messages.at(-1).stopReason, "error");
            assert.match(result.session.messages.at(-1).errorMessage, /requested-route-unavailable/);
          }
        }
        assert.equal(requests, 0, `${event} must veto inference`);
      } finally { result.session.dispose(); }
    }
    settings = { ...defaults, defaultModel: "unavailable-requested-model" };
    await writeFile(settingsPath, JSON.stringify(settings));
    let cliResult = await run([]);
    assert.notEqual(cliResult.code, 0);
    assert.match(cliResult.stderr, /Configured model .* not found/);
    assert.equal(requests, 0);
    cliResult = await run(["--list-models", "doctor-explicit"]);
    assert.equal(cliResult.code, 0, cliResult.stderr);
    assert.match(cliResult.stdout + cliResult.stderr, /doctor-explicit/);
    cliResult = await run(["--model", "openai-codex/unavailable-requested-model"]);
    assert.notEqual(cliResult.code, 0);
    assert.match(cliResult.stderr, /not found/);
    assert.equal(requests, 0);
    await writeFile(settingsPath, JSON.stringify(defaults));
    for (const event of ["session_start", "before_agent_start", "before_provider_request", "before_provider_headers"]) {
      const extension = join(dir, "gate.mjs");
      await writeFile(extension, `export default pi => { pi.on(${JSON.stringify(event)}, () => { throw new Error('requested-route-unavailable'); }); };`);
      cliResult = await run(["--model", `${provider}/explicit-model`, "--extension", extension]);
      assert.notEqual(cliResult.code, 0, `${event}: ${cliResult.stdout} ${cliResult.stderr}`);
      assert.match(cliResult.stderr + cliResult.stdout, /requested-route-unavailable/);
      assert.equal(requests, 0);
    }
    const probe = join(dir, "default-probe.mjs");
    await writeFile(probe, `export default pi => { pi.on('session_start', (_event, ctx) => { if(ctx.model.provider!=='openai-codex'||ctx.model.id!=='gpt-6-astra')throw new Error('default-substituted');throw new Error('requested-default-retained'); }); };`);
    cliResult = await run(["--extension", probe]);
    assert.notEqual(cliResult.code, 0);
    assert.match(cliResult.stderr, /requested-default-retained/);
    assert.equal(requests, 0);
    cliResult = await run(["--model", `${provider}/explicit-model`]);
    assert.equal(cliResult.code, 0, cliResult.stderr);
    assert.match(cliResult.stdout, /explicit-provider-worked/);
    assert.equal(requests, 1, "only the explicit successful selection may dispatch");
    return { sdk: true, bundledCli: true, requestedDefaultRetained: true, explicitOnlyCatalog: true, automaticExclusion: true, savedSelectionRetained: true, extensionProvidersBeforeSelection: true, admissionFailuresVetoInference: true, explicitProviderRequests: requests };
  } finally {
    for (const session of sessions) {
      await session.abort();
      assert.ok(session.isIdle && !session.isStreaming && !session.isCompacting && !session.isRetrying, "Doctor fixture session did not settle");
      session.dispose();
    }
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await modelSelectionDoctor())); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
