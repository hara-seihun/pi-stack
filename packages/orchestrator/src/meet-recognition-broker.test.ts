import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { attachMeetRecognitionBroker } from "./meet-recognition-broker.js";

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  delete process.env.PI_STACK_MEET_RECOGNITION_URL;
  for (const server of servers.splice(0)) server.close();
});

test("UID listener forwards meeting PCM and final text and releases its reservation", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(upstream);
  await new Promise<void>(resolve => upstream.once("listening", resolve));
  process.env.PI_STACK_MEET_RECOGNITION_URL = `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/`;
  let started: unknown;
  let audio = 0;
  upstream.on("connection", connection => connection.on("message", (frame, binary) => {
    if (binary) {
      audio += Array.isArray(frame) ? frame.reduce((size, chunk) => size + chunk.byteLength, 0) : frame.byteLength;
      connection.send(JSON.stringify({ type: "partial", text: "hello" }));
      return;
    }
    const data = JSON.parse(frame.toString());
    if (data.type === "start") started = data;
    else if (data.type === "finish") connection.send(JSON.stringify({ type: "final", text: "hello world" }));
  }));
  const shutdown = new AbortController();
  let active = 0;
  let released!: () => void;
  const reservationReleased = new Promise<void>(resolve => { released = resolve; });
  const broker = createServer();
  servers.push(broker);
  attachMeetRecognitionBroker(broker, shutdown.signal, () => { active++; return true; }, () => { active--; released(); });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${(broker.address() as { port: number }).port}/v1/meet/recognition`);
  await new Promise<void>(resolve => client.once("open", resolve));
  const partial = new Promise<Record<string, unknown>>(resolve => client.once("message", data => resolve(JSON.parse(data.toString()))));
  client.send(JSON.stringify({ type: "start", turn: "1" }));
  client.send(new Uint8Array([1, 2, 3, 4]));
  expect(await partial).toEqual({ type: "partial", text: "hello" });
  const final = new Promise<Record<string, unknown>>(resolve => client.once("message", data => resolve(JSON.parse(data.toString()))));
  client.send(JSON.stringify({ type: "finish" }));
  expect(await final).toEqual({ type: "final", text: "hello world" });
  expect(started).toEqual({ type: "start", turn: "1" });
  expect(audio).toBe(4);
  client.close();
  await new Promise<void>(resolve => client.once("close", resolve));
  await reservationReleased;
  expect(active).toBe(0);
  shutdown.abort();
});
