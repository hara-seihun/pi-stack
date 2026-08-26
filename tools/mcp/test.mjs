import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseJson, schemaToTypeScript } from "./lib.mjs";

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
