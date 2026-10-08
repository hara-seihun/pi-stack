#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { probeBrowser } from "./browser-probe.mjs";
import { probeTabRestoration } from "./browser-tab-restore-probe.mjs";
import { requireStandaloneAgent, settleStandaloneAgent, abortAndSettleStandaloneSession, standaloneRecordPath } from "./standalone-agent.mjs";

const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" }, "worker-release": { type: "string" }, "session-file": { type: "string" } } });
if (values.help) {
  console.log(`pi-agent-browser-doctor [--worker-release PATH] [--session-file PATH]

Check the selected Pi stack browser through normal settings and a disposable
loopback browser. No model request or signed-in profile is used. --worker-release
selects an earlier host SDK; --session-file copies a settled JSONL for recovery
proof without writing its canonical file. Restore a missing or duplicate browser
entrypoint with the host's pi-stack-release command, not pi install npm.`);
  process.exit(0);
}
const runtime = realpathSync(process.env.PI_STACK_RUNTIME_DEST ?? "/srv/pi/runtime");
const host = realpathSync(values["worker-release"] ?? runtime);
const sdk = realpathSync(join(host, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } = await import(pathToFileURL(sdk).href);
const selected = createRequire(join(runtime, "package.json"));
const browserPackage = selected.resolve("agent-browser/package.json");
const bin = realpathSync(join(dirname(dirname(browserPackage)), ".bin"));
const wrapperVersion = JSON.parse(readFileSync(selected.resolve("pi-agent-browser-native/package.json"), "utf8")).version;
const browserVersion = JSON.parse(readFileSync(browserPackage, "utf8")).version;
const directory = mkdtempSync(join(tmpdir(), "pi-browser-smoke-"));
const sessionFile = join(directory, "session.jsonl");
if (values["session-file"]) copyFileSync(values["session-file"], sessionFile);
else writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory })}\n`);
const title = `pi-browser-${randomUUID()}`;
const downloadContent = `browser-download-${randomUUID()}\n`;
const downloadPath = join(directory, "browser-download.txt");
const screenshotPath = join(directory, "browser-screenshot.png");
const frameValue = `frame-fill-${randomUUID()}`;
function controlledDateProbe() {
  const reactSources = Object.fromEntries([
    ["react", "react", "react.production.js"], ["react-dom", "react-dom", "react-dom.production.js"],
    ["react-dom/client", "react-dom", "react-dom-client.production.js"], ["scheduler", "scheduler", "scheduler.production.js"],
  ].map(([id, pkg, file]) => [id, readFileSync(join(dirname(selected.resolve(pkg)), "cjs", file), "utf8")]));
  return `<div id="date-probe"></div><script>
(() => {
  const sources = ${JSON.stringify(reactSources).replaceAll("</script", "<\\/script")}, loaded = {};
  function require(id) { if (!loaded[id]) { const module = loaded[id] = { exports: {} }; new Function('module', 'exports', 'require', sources[id])(module, module.exports, require); } return loaded[id].exports; }
  const React = require('react'), { createRoot } = require('react-dom/client');
  function Probe() {
    const [value, setValue] = React.useState({ date: '2026-10-02', datetime: '2026-10-02T23:00' });
    return React.createElement('section', null,
      React.createElement('label', null, 'Controlled date', React.createElement('input', { id: 'controlled-date', type: 'date', value: value.date, onChange: e => setValue({ ...value, date: e.target.value }) })),
      React.createElement('label', null, 'Controlled datetime', React.createElement('input', { id: 'controlled-datetime', type: 'datetime-local', value: value.datetime, onChange: e => setValue({ ...value, datetime: e.target.value }) })),
      React.createElement('output', { id: 'controlled-state' }, JSON.stringify(value)));
  }
  createRoot(document.getElementById('date-probe')).render(React.createElement(Probe));
})();</script>`;
}
let controlledDates;
const server = createServer((req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, {
      "content-disposition": "attachment; filename=browser-download.txt",
      "content-type": "text/plain",
    });
    res.end(downloadContent);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  if (req.url === "/tab-auth") {
    res.end(`<title>Tab startup probe</title><output id="tab-startup"></output><script>document.querySelector('#tab-startup').textContent = sessionStorage.getItem('fixture-tab-auth') === 'fixture-tab-token' ? 'authorized-at-startup' : 'unauthorized-at-startup';</script>`);
    return;
  }
  if (req.url === "/sensitive") {
    res.end(`<title>Sensitive input probe</title><iframe title="Sensitive input frame" src="http://localhost:${server.address().port}/sensitive-frame"></iframe>`);
    return;
  }
  if (req.url === "/sensitive-frame") {
    res.end(`<title>Sensitive frame</title>
      <label>Card number<input id="cardnumber" autocomplete="cc-number" value="4242 4242 4242 4242"></label>
      <label>Expiration<input id="exp-date" autocomplete="cc-exp" value="12/39"></label>
      <label>Security code<input id="cvc" autocomplete="cc-csc" value="937"></label>
      <label>Password<input id="secret-password" type="password" value="fixture-password-82"></label>
      <label>One-time code<input id="otp" autocomplete="one-time-code" value="681295"></label>
      <label>Cardholder<input id="cardholder" autocomplete="cc-name" value="Public Test Name"></label>
      <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML = '<label>Shadow card<input autocomplete="cc-number" value="4000 0000 0000 0077"></label>';</script>`);
    return;
  }
  if (req.url === "/frame") {
    res.end('<title>Frame probe</title><label>Frame input<input id="frame-input"></label>');
    return;
  }
  res.end(`<title>${title}</title><h1><span>${title.slice(0, 5)}</span><span>${title.slice(5)}</span></h1><button>Probe</button>${controlledDates}<a href="/download" download>Download probe</a><iframe title="Secure payment input frame" src="http://localhost:${server.address().port}/frame"></iframe>`);
});
let session;
let capacity;
let accepted = false;
let browserAttempted = !!values["session-file"];
try {
  const executionId = randomUUID();
  capacity = await requireStandaloneAgent({ recordPath: standaloneRecordPath(), agentId: `browser-doctor:${executionId}`, executionId });
  const agentDir = join(homedir(), ".pi/agent");
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), allowModelNetwork: false });
  const model = modelRuntime.getModel("openai-codex", "gpt-6-luna");
  assert.ok(model, "browser doctor requires its explicit offline catalog model; no inference is dispatched");
  const opened = await createAgentSession({
    cwd: directory, agentDir, resourceLoader, modelRuntime, model, thinkingLevel: "off", tools: ["agent_browser"],
    sessionManager: SessionManager.open(sessionFile, undefined, directory),
  });
  session = opened.session;
  const setupRepair = "restore exactly one browser entrypoint with the host's pi-stack-release command, not pi install npm";
  assert.deepEqual(opened.extensionsResult.errors, [], `configured extensions must load; ${setupRepair}`);
  const browserExtensions = opened.extensionsResult.extensions.filter((extension) => extension.tools.has("agent_browser"));
  assert.equal(browserExtensions.length, 1, setupRepair);
  assert.equal(realpathSync(browserExtensions[0].resolvedPath), join(runtime, "extensions/browser/index.mjs"), "the native browser must load through the selected stack entrypoint");
  const extensionErrors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error) });
  assert.deepEqual(extensionErrors, [], "configured extensions must initialize");
  const expectedFront = process.platform === "linux" && process.env.PI_THREAD_RESOURCE_BOUNDARY
    ? join(runtime, "extensions/browser/bin") : bin;
  assert.equal(process.env.PATH.split(delimiter)[0], expectedFront, "the selected browser must own executable resolution");
  assert.equal(execFileSync("agent-browser", ["--version"], { encoding: "utf8", timeout: 5000 }).trim(), `agent-browser ${browserVersion}`);
  const tools = session.agent.state.tools.filter((tool) => tool.name === "agent_browser");
  assert.equal(tools.length, 1, "exactly one native browser tool must be active");
  controlledDates = controlledDateProbe();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const nativeRoot = dirname(selected.resolve("pi-agent-browser-native/package.json"));
  const { compileAgentBrowserQaPreset } = await import(pathToFileURL(join(nativeRoot, "dist/extensions/agent-browser/lib/input-modes/job.js")).href);
  const visibleTextCheck = compileAgentBrowserQaPreset({ attached: true, expectedText: title }).compiled.steps.find((step) => step.action === "assertText").args;
  browserAttempted = true;
  const phases = [];
  await probeBrowser(tools[0], {
    url, title, visibleTextCheck, frameValue, screenshotPath, downloadPath, downloadContent,
    record: (phase) => {
      phases.push(phase);
      writeFileSync(join(directory, "browser-proof.json"), JSON.stringify(phases, null, 2));
    },
  });
  await probeTabRestoration(tools[0], {
    url, statePath: join(directory, "authorized-tab-state.json"),
    record: phase => { phases.push(phase); writeFileSync(join(directory, "browser-proof.json"), JSON.stringify(phases, null, 2)); },
  });
  accepted = true;
  console.log(JSON.stringify({ host: hostname(), sdk, runtime, bin, wrapperVersion, browserVersion, recovered: !!values["session-file"], phases: phases.map(({ phase, elapsedMs }) => ({ phase, elapsedMs })), nativeOpen: true, snapshot: true, visibleText: true, screenshot: true, download: true, crossOriginFrameFill: true, dynamicCrossOriginFrameFill: true, remoteExistingFrameFill: true, controlledDateFill: true, controlledDatetimeFill: true, controlledFindFill: true, controlledSemanticFill: true, authorizedTabRestoration: true, frameEval: true, sensitiveInputRedaction: true, cleanup: "closed" }));
} finally {
  try {
    if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    if (capacity) {
      if (session) await abortAndSettleStandaloneSession(session, capacity);
      else await settleStandaloneAgent(capacity);
    }
    await new Promise((resolve) => server.close(resolve));
    if (accepted || !browserAttempted) rmSync(directory, { recursive: true, force: true });
    else console.error(`Browser proof failed. Session and cleanup state retained at ${sessionFile}`);
  }
}
