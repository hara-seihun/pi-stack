import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { takeFlag, takeOption } from "../shared/arguments.mjs";
import { loadConfig, parseJson, schemaToTypeScript } from "./lib.mjs";

test("shared argument parsing consumes options and flags", () => {
  const args = ["call", "--config", "mcp.json", "--connect"];
  assert.equal(takeOption(args, "--config"), "mcp.json");
  assert.equal(takeFlag(args, "--connect"), true);
  assert.equal(takeFlag(args, "--missing"), false);
  assert.deepEqual(args, ["call"]);
  assert.throws(() => takeOption(["--config"], "--config"), /requires a value/);
});

test("config precedence follows global then project order", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cli-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(join(home, ".config", "mcp"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, ".config", "mcp", "mcp.json"), JSON.stringify({ mcpServers: { one: { url: "http://global" }, two: { command: "x" } } }));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { one: { url: "http://project" } } }));
  const loaded = loadConfig(cwd, { home, agentDir });
  assert.equal(loaded.servers.one.url, "http://project");
  assert.equal(loaded.servers.two.command, "x");
  assert.equal(loaded.provenance.one, join(cwd, ".mcp.json"));
});

test("schema renderer preserves required and optional fields", () => {
  const rendered = schemaToTypeScript({
    type: "object",
    required: ["query"],
    properties: { query: { type: "string", description: "Search text" }, limit: { type: "integer" } },
  });
  assert.match(rendered, /"query": string/);
  assert.match(rendered, /"limit"\?: number/);
});

test("tool arguments must be an object", () => {
  assert.deepEqual(parseJson('{"x":1}'), { x: 1 });
  assert.throws(() => parseJson("[]"), /expected an object/);
});

test("a refused tool call exits non-zero while printing the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cli-exit-"));
  const config = join(root, "mcp.json");
  writeFileSync(config, JSON.stringify({
    mcpServers: { stub: { command: process.execPath, args: [join(import.meta.dirname, "stub-server.mjs")] } },
  }));
  const run = (tool) => new Promise((done) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "main"), "--config", config, "call", tool, "{}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => done({ code, out }));
  });

  const refused = await run("stub_refuse");
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).isError, true);
  assert.match(refused.out, /refused on purpose/);

  const accepted = await run("stub_accept");
  assert.equal(accepted.code, 0);
  assert.equal(JSON.parse(accepted.out).isError, undefined);
});

test("a reader that leaves early ends the command quietly", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cli-pipe-"));
  const config = join(root, "mcp.json");
  writeFileSync(config, JSON.stringify({
    mcpServers: { stub: { command: process.execPath, args: [join(import.meta.dirname, "stub-server.mjs")] } },
  }));
  // Exactly what an agent types to inspect one tool of many: read the first
  // line and go. The CLI used to answer that with an unhandled EPIPE trace.
  const shell = spawn("/bin/sh", ["-c", `'${process.execPath}' '${join(import.meta.dirname, "main")}' --config '${config}' list stub | head -1`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, STUB_FILLER_TOOLS: "400" },
  });
  let out = "";
  let err = "";
  shell.stdout.on("data", (chunk) => { out += chunk; });
  shell.stderr.on("data", (chunk) => { err += chunk; });
  const code = await new Promise((done) => shell.on("close", done));
  assert.equal(code, 0);
  assert.equal(err, "");
  assert.match(out, /^\[/);
});
