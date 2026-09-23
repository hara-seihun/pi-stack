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
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(sdk).href);
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
  res.end(`<title>${title}</title><h1><span>${title.slice(0, 5)}</span><span>${title.slice(5)}</span></h1><button>Probe</button><a href="/download" download>Download probe</a>`);
});
let session;
let accepted = false;
let browserAttempted = !!values["session-file"];
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const agentDir = join(homedir(), ".pi/agent");
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const opened = await createAgentSession({
    cwd: directory, agentDir, resourceLoader, tools: ["agent_browser"],
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
  assert.equal(process.env.PATH.split(delimiter)[0], bin, "the selected browser must own executable resolution");
  assert.equal(execFileSync("agent-browser", ["--version"], { encoding: "utf8", timeout: 5000 }).trim(), `agent-browser ${browserVersion}`);
  const tools = session.agent.state.tools.filter((tool) => tool.name === "agent_browser");
  assert.equal(tools.length, 1, "exactly one native browser tool must be active");
  const url = `http://127.0.0.1:${server.address().port}/`;
  const nativeRoot = dirname(selected.resolve("pi-agent-browser-native/package.json"));
  const { compileAgentBrowserQaPreset } = await import(pathToFileURL(join(nativeRoot, "dist/extensions/agent-browser/lib/input-modes/job.js")).href);
  const visibleTextCheck = compileAgentBrowserQaPreset({ attached: true, expectedText: title }).compiled.steps.find((step) => step.action === "assertText").args;
  browserAttempted = true;
  const result = await tools[0].execute(randomUUID(), {
    script: `
      const opened = await browser({ args: ["open", ${JSON.stringify(url)}] });
      if (!opened.ok) throw new Error(opened.error);
      const snapshot = await browser({ args: ["snapshot", "-i"] });
      if (!snapshot.ok) throw new Error(snapshot.error);
      const visibleText = await browser({ args: ${JSON.stringify(visibleTextCheck)} });
      if (!visibleText.ok) throw new Error(visibleText.error);
      const title = await browser({ args: ["get", "title"] });
      if (!title.ok) throw new Error(title.error);
      const screenshot = await browser({ args: ["screenshot", ${JSON.stringify(screenshotPath)}] });
      if (!screenshot.ok) throw new Error(screenshot.error);
      const downloadRef = Object.entries(snapshot.data.refs).find(([, ref]) => ref.name === "Download probe")?.[0];
      if (!downloadRef) throw new Error("Download probe ref missing");
      const download = await browser({ args: ["download", "@" + downloadRef, ${JSON.stringify(downloadPath)}] });
      if (!download.ok) throw new Error(download.error);
      emit({
        title: title.data.title,
        refs: Object.keys(snapshot.data.refs).length,
        screenshotVerified: screenshot.details.artifactVerification.verified,
        downloadVerified: download.details.artifactVerification.verified,
      });
    `,
    timeoutMs: 20000,
  }, AbortSignal.timeout(25000));
  assert.equal(result.details.resultCategory, "success", JSON.stringify(result));
  assert.equal(result.details.data.title, title);
  assert.ok(result.details.data.refs >= 3);
  assert.equal(result.details.data.screenshotVerified, true, "the native screenshot artifact must be verified");
  assert.equal(readFileSync(screenshotPath).subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the native screenshot must be a PNG");
  assert.equal(result.details.data.downloadVerified, true, "the native download artifact must be verified");
  assert.equal(readFileSync(downloadPath, "utf8"), downloadContent, "the native download must preserve file bytes");
  assert.equal(result.details.scriptSession.cleanup, "closed", "the probe browser must be closed");
  accepted = true;
  console.log(JSON.stringify({ host: hostname(), sdk, runtime, bin, wrapperVersion, browserVersion, recovered: !!values["session-file"], nativeOpen: true, snapshot: true, visibleText: true, screenshot: true, download: true, cleanup: "closed" }));
} finally {
  try {
    if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session?.dispose();
    await new Promise((resolve) => server.close(resolve));
    if (accepted || !browserAttempted) rmSync(directory, { recursive: true, force: true });
    else console.error(`Browser proof failed. Session and cleanup state retained at ${sessionFile}`);
  }
}
