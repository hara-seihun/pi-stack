#!/usr/bin/env node
// A minimal stdio MCP server for the CLI's own tests. It answers initialize,
// tools/list, and tools/call, where "refuse" returns the isError result an
// ordinary server sends when it declines a call, and "accept" succeeds.
import { createInterface } from "node:readline";

const tools = [
  { name: "refuse", description: "Always refuses", inputSchema: { type: "object", properties: {} } },
  { name: "accept", description: "Always succeeds", inputSchema: { type: "object", properties: {} } },
  // A real catalogue prints far more than a pipe buffer holds, which is what
  // makes a reader that stops at the first line reach a write that fails.
  ...Array.from({ length: Number(process.env.STUB_FILLER_TOOLS ?? 0) }, (_unused, index) => ({
    name: `filler${index}`,
    description: "x".repeat(1000),
    inputSchema: { type: "object", properties: {} },
  })),
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") return;
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "stub", version: "1" },
    }
    : request.method === "tools/list"
      ? { tools }
      : request.method === "tools/call"
        ? request.params?.name === "refuse"
          ? { content: [{ type: "text", text: "refused on purpose" }], isError: true }
          : { content: [{ type: "text", text: "done" }] }
        : undefined;
  if (result === undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result });
});
