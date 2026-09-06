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

const { values } = parseArgs({ options: { "worker-release": { type: "string" }, "session-file": { type: "string" } } });
const runtime = realpathSync(process.env.PI_STACK_RUNTIME_DEST ?? "/srv/pi/runtime");
const host = realpathSync(values["worker-release"] ?? runtime);
const sdk = realpathSync(join(host, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const { createAgentSession, SessionManager } = await import(pathToFileURL(sdk).href);
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
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>${title}</title><h1>${title}</h1><button>Probe</button>`);
});
let session;
let accepted = false;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const opened = await createAgentSession({
    cwd: directory, agentDir: join(homedir(), ".pi/agent"), tools: ["agent_browser"],
    sessionManager: SessionManager.open(sessionFile, undefined, directory),
  });
  session = opened.session;
  assert.deepEqual(opened.extensionsResult.errors, [], "configured extensions must load");
  const extensionErrors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error) });
  assert.deepEqual(extensionErrors, [], "configured extensions must initialize");
  assert.equal(process.env.PATH.split(delimiter)[0], bin, "the selected browser must own executable resolution");
  assert.equal(execFileSync("agent-browser", ["--version"], { encoding: "utf8", timeout: 5000 }).trim(), `agent-browser ${browserVersion}`);
  const tools = session.agent.state.tools.filter((tool) => tool.name === "agent_browser");
  assert.equal(tools.length, 1, "exactly one native browser tool must be active");
  const url = `http://127.0.0.1:${server.address().port}/`;
  const result = await tools[0].execute(randomUUID(), {
    script: `
      const opened = await browser({ args: ["open", ${JSON.stringify(url)}] });
      if (!opened.ok) throw new Error(opened.error);
      const snapshot = await browser({ args: ["snapshot", "-i"] });
      if (!snapshot.ok) throw new Error(snapshot.error);
      const title = await browser({ args: ["get", "title"] });
      if (!title.ok) throw new Error(title.error);
      emit({ title: title.data.title, refs: Object.keys(snapshot.data.refs).length });
    `,
    timeoutMs: 20000,
  }, AbortSignal.timeout(25000));
  assert.equal(result.details.resultCategory, "success", JSON.stringify(result));
  assert.equal(result.details.data.title, title);
  assert.ok(result.details.data.refs >= 2);
  assert.equal(result.details.scriptSession.cleanup, "closed", "the probe browser must be closed");
  accepted = true;
  console.log(JSON.stringify({ host: hostname(), sdk, runtime, bin, wrapperVersion, browserVersion, recovered: !!values["session-file"], nativeOpen: true, snapshot: true, cleanup: "closed" }));
} finally {
  session?.dispose();
  await new Promise((resolve) => server.close(resolve));
  if (accepted) rmSync(directory, { recursive: true, force: true });
  else console.error(`Browser proof failed. Session and cleanup state retained at ${sessionFile}`);
}
