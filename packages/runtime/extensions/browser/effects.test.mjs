import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { classifyBrowserEffect, installBrowserEffectFence } from "./effects.mjs";
const clientSource = buildSync({ entryPoints: [fileURLToPath(new URL("../../../kenan-memory/src/action-http-client.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "esm" }).outputFiles[0].text;
const { ActionHttpClient } = await import(`data:text/javascript;base64,${Buffer.from(clientSource).toString("base64")}`);

const require = createRequire(import.meta.url);
const native = dirname(require.resolve("pi-agent-browser-native/package.json"));
const contract = Object.assign({}, ...await Promise.all([
  "argv-descriptor.js", "orchestration/batch-stdin.js", "input-modes/semantic-action.js", "input-modes/job.js",
].map(path => import(pathToFileURL(join(native, "dist/extensions/agent-browser/lib", path)).href))));
const actions = fileURLToPath(new URL("../../../kenan-memory/src/actions.ts", import.meta.url));
const declaration = { intentKey: "fixture:send-one", recipients: ["mailto:synthetic@example.invalid"] };

async function fixture(run, mode = "normal") {
  const directory = mkdtempSync(join(tmpdir(), "browser-effect-fence-"));
  const child = spawn("bun", ["-e", `
    import {ActionStore, actionRequest} from ${JSON.stringify(actions)};
    const store = new ActionStore(${JSON.stringify(directory)}, "synthetic-owner");
    let count = 0;
    const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/external-actions") {
        const body = await req.json();
        const result = actionRequest(store,body.operation,body.input);
        if (body.operation === ${JSON.stringify(mode === "lost-dispatch" ? "dispatch" : mode === "lost-finish" ? "finish" : "no-drop")}) return new Response('synthetic lost receipt');
        return Response.json(result);
      }
      if (path === "/effect") { count++; return Response.json({accepted:true}); }
      if (path === "/count") return Response.json(count);
      return new Response(${JSON.stringify(`<title>Synthetic browser effects</title><button id="send" onclick="fetch('/effect',{method:'POST'}).then(()=>document.querySelector('output').textContent='sent')">Send</button><button id="browse">Expand</button><output>ready</output>`)}, {headers:{"content-type":"text/html"}});
    }});
    console.log(server.url.origin);
    process.on("SIGTERM",()=>{ server.stop(true); store.close(); process.exit(0); });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => errors += chunk);
  try {
    const url = await Promise.race([
      once(child.stdout, "data").then(([bytes]) => bytes.toString().trim()),
      once(child, "exit").then(() => { throw new Error(errors); }),
    ]);
    await run(url);
  } finally {
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    rmSync(directory, { recursive: true, force: true });
  }
}

function toolFor(url, execute) {
  const env = { PI_REMOTE_SERVER_URL: url, PI_THREAD_ID: "fixture-thread" };
  const tool = { description: "fixture", parameters: { type: "object", properties: {} }, execute };
  let authorityCalls = 0;
  installBrowserEffectFence(tool, {
    env, loadContract: async () => contract,
    createAuthority: () => { authorityCalls++; return new ActionHttpClient(env); },
  });
  return { tool, authorityCalls: () => authorityCalls };
}

const count = async url => (await fetch(`${url}/count`)).json();

test("classification uses native effective args across flags, semantic/job/batch and leaves browsing unclassified", () => {
  for (const params of [
    { args: ["--session", "fixture", "chat", "hello"] },
    { args: ["webmcp", "invoke", "send"] },
    { args: ["confirm", "fixture-id"] },
    { semanticAction: { action: "click", locator: "role", role: "button", name: "Send" } },
    { job: { steps: [{ action: "click", locator: "text", value: "Submit" }] } },
    { args: ["batch", "--bail", "find role button click --name 'Place order'"] },
    { args: ["batch"], stdin: JSON.stringify([["chat", "hello"]]) },
  ]) assert.equal(classifyBrowserEffect(params, contract), true, JSON.stringify(params));
  for (const params of [
    { args: ["open", "https://example.invalid"] }, { args: ["snapshot", "-i"] },
    { args: ["click", "@e1"] }, { args: ["eval", "fetch('/mutation')"] },
    { semanticAction: { action: "click", locator: "text", value: "Expand" } },
    { args: ["batch", "get title"], stdin: JSON.stringify([["chat", "ignored"]]) },
  ]) assert.equal(classifyBrowserEffect(params, contract), false, JSON.stringify(params));
});

test("loopback dispatch crosses canonical authority once; retries, rephrasing, concurrency and payload conflict never re-arm", { timeout: 15000 }, async () => fixture(async url => {
  let nativeCalls = 0;
  const { tool, authorityCalls } = toolFor(url, async (_id, params) => {
    nativeCalls++;
    if (params.args[0] === "click") await fetch(`${url}/effect`, { method: "POST" });
    return { content: [{ type: "text", text: "gesture sent" }], details: { resultCategory: "success" } };
  });
  const read = await tool.execute("read", { args: ["get", "title"] });
  assert.equal(read.details.resultCategory, "success");
  assert.equal(authorityCalls(), 0);
  assert.equal(await count(url), 0);
  nativeCalls = 0;
  const baseline = await count(url);
  const missing = await tool.execute("missing", { args: ["chat", "hello"] });
  assert.equal(missing.isError, true);
  assert.equal(nativeCalls, 0);
  const input = { args: ["click", "#send"], externalAction: declaration };
  const pair = await Promise.all([tool.execute("uuid-one", input), tool.execute("uuid-two", input)]);
  assert.equal(nativeCalls, 1);
  assert.equal(await count(url), baseline + 1);
  assert.ok(pair.some(result => result.details.externalAction?.state === "uncertain"));
  const retry = await tool.execute("new-uuid", input);
  assert.equal(retry.details.externalAction.dispatched, false);
  const rephrased = await tool.execute("new-purpose", { ...input, externalAction: { ...declaration, intentKey: "fixture:reworded-purpose" } });
  assert.equal(rephrased.details.externalAction.dispatched, false);
  const conflict = await tool.execute("new-payload", { ...input, args: ["click", "#different-send"] });
  assert.equal(conflict.details.actionResult.error, "payload-conflict");
  assert.equal(nativeCalls, 1);
  assert.equal(await count(url), baseline + 1);
}));

test("post-effect exception retains uncertainty without replay", { timeout: 15000 }, async () => fixture(async url => {
  const { tool } = toolFor(url, async () => {
    await fetch(`${url}/effect`, { method: "POST" });
    throw new Error("synthetic timeout after provider acceptance");
  });
  const input = { args: ["click", "#send"], externalAction: declaration };
  const first = await tool.execute("first", input);
  assert.equal(first.isError, true);
  assert.equal(first.details.externalAction.state, "uncertain");
  await tool.execute("replacement", input);
  assert.equal(await count(url), 1);
}));

test("lost dispatch/finish responses never authorize a replacement native call", { timeout: 15000 }, async () => {
  for (const mode of ["lost-dispatch", "lost-finish"]) await fixture(async url => {
    let calls = 0;
    const { tool } = toolFor(url, async () => {
      calls++;
      await fetch(`${url}/effect`, { method: "POST" });
      return { content: [], details: { resultCategory: "success" } };
    });
    const input = { args: ["click", "#send"], externalAction: declaration };
    const result = await tool.execute("first", input);
    assert.equal(result.isError, true);
    assert.equal(result.details.actionResult.error, "unavailable");
    await tool.execute("replacement", input);
    assert.equal(calls, mode === "lost-dispatch" ? 0 : 1);
    assert.equal(await count(url), calls);
  }, mode);
});

test("unavailable authority prevents declared execution but does not disable ordinary reads", async () => {
  let calls = 0;
  const { tool } = toolFor("http://127.0.0.1:1", () => { calls++; return { content: [], details: { resultCategory: "success" } }; });
  const refused = await tool.execute("declared", { args: ["click", "#send"], externalAction: declaration });
  assert.equal(refused.details.actionResult.error, "unavailable");
  assert.equal(calls, 0);
  assert.notEqual((await tool.execute("read", { args: ["get", "title"] })).isError, true);
  assert.equal(calls, 1);
});

test("declared aggregate modes fail before authority or native execution", async () => {
  let nativeCalls = 0;
  const { tool, authorityCalls } = toolFor("http://127.0.0.1:1", () => { nativeCalls++; });
  for (const input of [{ args: ["batch"], stdin: '[["chat","hello"]]' }, { script: "emit('hello')" }, { job: { steps: [{ action: "click", selector: "#send" }] } }]) {
    assert.equal((await tool.execute("id", { ...input, externalAction: declaration })).isError, true);
  }
  assert.equal(authorityCalls(), 0);
  assert.equal(nativeCalls, 0);
});

test("actual native browser declared click produces one synthetic HTTP effect and refuses new IDs", { timeout: 30000 }, async () => fixture(async url => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const directory = mkdtempSync(join(tmpdir(), "native-browser-effect-"));
  const prior = Object.fromEntries(["PI_REMOTE_SERVER_URL", "PI_THREAD_ID", "PATH"].map(key => [key, process.env[key]]));
  let session;
  try {
    process.env.PI_REMOTE_SERVER_URL = url;
    process.env.PI_THREAD_ID = "native-fixture-thread";
    const extension = join(directory, "extensions/browser");
    mkdirSync(extension, { recursive: true });
    mkdirSync(join(directory, "node_modules"));
    for (const file of ["index.mjs", "effects.mjs", "package.json"]) copyFileSync(new URL(file, import.meta.url), join(extension, file));
    for (const pkg of ["agent-browser", "pi-agent-browser-native"]) symlinkSync(dirname(require.resolve(`${pkg}/package.json`)), join(directory, "node_modules", pkg));
    const memoryPackage = join(directory, "node_modules/kenan-memory");
    mkdirSync(join(memoryPackage, "dist"), { recursive: true });
    copyFileSync(new URL("../../../kenan-memory/package.json", import.meta.url), join(memoryPackage, "package.json"));
    writeFileSync(join(memoryPackage, "dist/action-http-client.js"), clientSource);
    const settingsManager = SettingsManager.inMemory({ packages: [extension] });
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent"), settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: join(directory, "agent"), resourceLoader, settingsManager, sessionManager: SessionManager.create(directory) }));
    await session.bindExtensions({ mode: "print" });
    const tool = session.agent.state.tools.find(tool => tool.name === "agent_browser");
    assert.ok(tool);
    assert.ok(tool.parameters.properties.externalAction);
    assert.notEqual((await tool.execute("open", { args: ["open", url], sessionMode: "fresh" })).isError, true);
    const missing = await tool.execute("missing", { semanticAction: { action: "click", locator: "text", value: "Send" } });
    assert.equal(missing.isError, true);
    assert.equal(await count(url), 0);
    const input = { semanticAction: { action: "click", locator: "text", value: "Send" }, externalAction: declaration };
    const result = await tool.execute("send-one", input);
    assert.equal(result.details.externalAction.state, "uncertain");
    assert.notEqual(result.isError, true, JSON.stringify(result));
    await tool.execute("settle", { args: ["wait", "--text", "sent"] });
    assert.equal(await count(url), 1);
    await tool.execute("replacement-uuid", input);
    await tool.execute("reworded", { ...input, externalAction: { ...declaration, intentKey: "reworded" } });
    assert.equal(await count(url), 1);
    const script = await tool.execute("script", { script: "await browser({args:['chat','synthetic']});" });
    assert.equal(script.details.scriptSteps[0].ok, false);
    assert.match(script.details.scriptSteps[0].summary, /requires externalAction/);
    assert.equal(await count(url), 1);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
}));
