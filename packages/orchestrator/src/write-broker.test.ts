import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { attachWriteBroker } from "./write-broker.js";

const servers: Array<{ close(): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

test("UID listener forwards binary PCM and final text without changing the protocol", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(upstream);
  await new Promise<void>(resolve => upstream.once("listening", resolve));
  const endpoint = `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/`;
  process.env.PI_STACK_WRITE_URL = endpoint;
  let started: unknown;
  let audio = 0;
  upstream.on("connection", connection => connection.on("message", (frame, binary) => {
    if (binary) { audio += Array.isArray(frame) ? frame.reduce((size, chunk) => size + chunk.byteLength, 0) : frame.byteLength; connection.send(JSON.stringify({ type: "partial", committed: "hello", tail: "wor" })); return; }
    const data = JSON.parse(frame.toString());
    if (data.type === "start") started = data;
    else if (data.type === "finish") connection.send(JSON.stringify({ type: "final", text: "hello world", raw: "hello world", edits: [], timing: { flushMs: 2 } }));
  }));
  const shutdown = new AbortController();
  let active = 0;
  const broker = createServer();
  servers.push(broker);
  attachWriteBroker(broker, shutdown.signal, () => { active++; return true; }, () => active--);
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${(broker.address() as { port: number }).port}/v1/write/stream`);
  await new Promise<void>(resolve => client.once("open", resolve));
  const partial = new Promise<Record<string, unknown>>(resolve => client.once("message", data => resolve(JSON.parse(data.toString()))));
  client.send(JSON.stringify({ type: "start", dictation: "1", dictionary: { words: ["Kelana"], replacements: [] } }));
  client.send(new Uint8Array([1, 2, 3, 4]));
  expect(await partial).toMatchObject({ type: "partial", committed: "hello", tail: "wor" });
  const final = new Promise<Record<string, unknown>>(resolve => client.once("message", data => resolve(JSON.parse(data.toString()))));
  client.send(JSON.stringify({ type: "finish" }));
  expect(await final).toMatchObject({ type: "final", text: "hello world", timing: { flushMs: 2 } });
  expect(started).toMatchObject({ type: "start", dictionary: { words: ["Kelana"] } });
  expect(audio).toBe(4);
  client.close();
  await new Promise<void>(resolve => client.once("close", resolve));
  expect(active).toBe(0);
  shutdown.abort();
  delete process.env.PI_STACK_WRITE_URL;
});
