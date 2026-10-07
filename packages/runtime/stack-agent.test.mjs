import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

const launcher = fileURLToPath(new URL("./stack-agent.mjs", import.meta.url));
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "stack-agent-launch-"));
  const guard = join(root, "guard.mjs");
  buildSync({ entryPoints: [fileURLToPath(new URL("../orchestrator/src/standalone-agent.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", outfile: guard });
  const token = join(root, "token"); writeFileSync(token, "fixture-token", { mode: 0o600 });
  const active = new Map(); const releases = [], acquires = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.ownerId, "fixture/root");
    let result;
    if (req.url === "/v1/acquire") {
      acquires.push(body);
      if (active.size >= 100) result = { ok: false, error: { code: "unavailable", message: "100 global agents already executing" } };
      else {
        const custody = { agentId: body.agentId, executionId: body.executionId, leaseId: `lease-${body.executionId}` };
        active.set(body.executionId, custody); result = { ok: true, value: custody };
      }
    } else if (req.url === "/v1/release") {
      active.delete(body.executionId); releases.push(body); result = { ok: true, value: null };
    } else throw new Error(`Unexpected capacity operation ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authority: "pi-stack-global-agents-v1", result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, PI_STACK_STANDALONE_AGENT_MODULE: guard, PI_AGENT_CAPACITY_URL: `http://127.0.0.1:${server.address().port}`, PI_AGENT_CAPACITY_OWNER: "fixture/root", PI_AGENT_CAPACITY_TOKEN_FILE: token };
  const record = join(root, "capacity.json");
  function runCommand(command, args, extra = {}, entry = launcher) {
    const child = spawn(process.execPath, [entry, "--record", record, "--agent", "fixture-agent", "--execution", "fixture-execution", "--", command, ...args], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, exited };
  }
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const run = (code, extra = {}) => runCommand(process.execPath, ["-e", code], extra);
  return { root, active, releases, acquires, record, run, runCommand };
}

test("mandatory CLI refuses agent 101, then executes and releases after a real child exit", async t => {
  const f = await fixture(t); for (let i = 0; i < 100; i++) f.active.set(`seed-${i}`, {});
  const marker = join(f.root, "executed");
  const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`;
  const denied = await f.run(program).exited;
  assert.equal(denied.code, 1); assert.match(denied.stderr, /100 global agents/);
  assert.equal(existsSync(marker), false); assert.equal(f.releases.length, 0);
  f.active.clear();
  const accepted = await f.run(program).exited;
  assert.equal(accepted.code, 0, accepted.stderr); assert.equal(readFileSync(marker, "utf8"), "executed");
  assert.equal(f.releases.length, 1); assert.equal(JSON.parse(readFileSync(f.record, "utf8")).state, "released");
});

test("sending cancellation never releases while the native process refuses to settle", async t => {
  const f = await fixture(t);
  const { child, exited } = f.run("process.on('SIGTERM',()=>console.log('CANCEL')); process.stdin.on('data',()=>process.exit(0)); console.log('RUNNING')");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  assert.equal(f.active.size, 1); assert.equal(f.releases.length, 0);
  child.kill("SIGTERM"); await once(child.stdout, "data");
  assert.equal(f.active.size, 1); assert.equal(f.releases.length, 0);
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).state, "held");
  child.stdin.end("settle\n");
  const result = await exited; assert.equal(result.code, 0, result.stderr);
  assert.equal(f.active.size, 0); assert.equal(f.releases.length, 1);
});

test("a child exit with a surviving tool process group retains durable custody", async t => {
  const f = await fixture(t), pidPath = join(f.root, "group-pid");
  const program = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}); child.unref();`;
  t.after(() => { if (existsSync(pidPath)) { try { process.kill(-Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } } });
  const result = await f.run(program).exited;
  assert.equal(result.code, 1); assert.match(result.stderr, /process group .* still alive/);
  assert.equal(f.active.size, 1); assert.equal(f.releases.length, 0);
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).state, "held");
});

test("the exact installed Pi launcher is one sub-operation, not a second acquisition", async t => {
  const f = await fixture(t);
  for (const name of ["stack-agent.mjs", "standalone-agent.mjs", "stack-pi.mjs"]) copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(f.root, name));
  const cli = join(f.root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "cli.js"), "console.log('NATIVE')");
  const result = await f.runCommand(join(f.root, "stack-pi.mjs"), ["PROMPT"], {}, join(f.root, "stack-agent.mjs")).exited;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /NATIVE/);
  assert.equal(f.acquires.length, 1); assert.equal(f.releases.length, 1);
});

test("an inherited managed marker cannot authorize a fresh direct CLI agent", async t => {
  const f = await fixture(t); for (let i = 0; i < 100; i++) f.active.set(`seed-${i}`, {});
  const result = await f.run("console.log('BYPASS')", { PI_CAPACITY_MANAGED: "1", PI_AGENT_CAPACITY_MANAGED: "1" }).exited;
  assert.equal(result.code, 1); assert.equal(result.stdout.includes("BYPASS"), false); assert.equal(f.active.size, 100);
});
