import { expect, test } from "bun:test";
import { createStreamClient, EventStreamParser, streamEventFromFrame } from "./src/stream";
import type { StreamEvent } from "../server/protocol";

const frames = (parser: EventStreamParser, chunk: string) => parser.push(chunk);

test("the event-stream parser joins split chunks, drops keep-alive comments and keeps multi-line data", () => {
  const parser = new EventStreamParser();
  expect(frames(parser, ": keep-alive\n\n")).toEqual([]);
  expect(frames(parser, "event: hello\ndata: {\"strea")).toEqual([]);
  expect(frames(parser, "mId\":\"s1\"}\n\n")).toEqual([{ event: "hello", data: "{\"streamId\":\"s1\"}" }]);
  expect(frames(parser, "event: live\r\ndata: one\r\ndata: two\r\n\r\n")).toEqual([{ event: "live", data: "one\ntwo" }]);
  expect(frames(parser, "data: {}\n\n")).toEqual([{ event: "message", data: "{}" }]);
});

test("a frame becomes a typed event, naming the variant from the event line when the payload omits it", () => {
  expect(streamEventFromFrame({ event: "dashboard", data: "{\"dashboard\":null}" })).toMatchObject({ type: "dashboard" });
  expect(streamEventFromFrame({ event: "state", data: "{\"type\":\"state\",\"version\":3}" })).toMatchObject({ type: "state", version: 3 });
  expect(streamEventFromFrame({ event: "state", data: "not json" })).toBeNull();
  expect(streamEventFromFrame({ event: "state", data: "" })).toBeNull();
});

function textStream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
}

function sse(chunks: string[]) {
  return new Response(textStream(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("the client subscribes, hands over typed events and ignores frames for another thread", async () => {
  const sent: Array<{ path: string; body: any }> = [];
  const received: StreamEvent[] = [];
  const client = createStreamClient({
    subscription: { session: "mine", viewing: true },
    listen: false,
    onEvent: event => received.push(event),
    onStatus: () => {},
    fetch: async (path, init) => {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      return sse([
        "event: hello\ndata: {\"epoch\":\"e\",\"streamId\":\"s1\",\"bootstrap\":{\"home\":\"/home/kenan\",\"threadStarts\":[],\"environmentId\":\"local\"}}\n\n",
        "event: transcript\ndata: {\"sessionId\":\"other\",\"generation\":\"g\",\"total\":1,\"reset\":true,\"items\":[]}\n\n",
        "event: transcript\ndata: {\"sessionId\":\"mine\",\"generation\":\"g\",\"total\":1,\"reset\":true,\"items\":[]}\n\n",
      ]);
    },
  });
  client.start();
  await settle();
  client.stop();

  expect(sent[0].path).toBe("/v1/stream");
  expect(sent[0].body).toEqual({ session: "mine", viewing: true });
  expect(received.map(event => event.type)).toEqual(["hello", "transcript"]);
  expect(received[1]).toMatchObject({ sessionId: "mine" });
});

test("a subscription change posts to the stream, and a restarted server (404) brings the whole subscription back", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  let streams = 0;
  const client = createStreamClient({
    subscription: { session: "a" },
    listen: false,
    onEvent: () => {},
    onStatus: () => {},
    fetch: async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      if (path === "/v1/stream") {
        streams += 1;
        return sse([`event: hello\ndata: {"epoch":"e","streamId":"s${streams}","bootstrap":{"home":"/","threadStarts":[],"environmentId":"local"}}\n\n`]);
      }
      return new Response("{}", { status: streams === 1 ? 404 : 204 });
    },
  });
  client.start();
  await settle();
  client.update({ session: "b", viewing: true });
  await settle();
  await settle();
  client.stop();

  expect(calls.map(call => call.path)).toEqual(["/v1/stream", "/v1/stream/s1", "/v1/stream"]);
  expect(calls[1].body).toEqual({ session: "b", viewing: true });
  expect(calls[2].body).toEqual({ session: "b", viewing: true });
  expect(client.subscription()).toMatchObject({ session: "b", viewing: true });
});

test("a failed connection reports offline and retries", async () => {
  const statuses: string[] = [];
  let attempts = 0;
  const client = createStreamClient({
    subscription: {},
    listen: false,
    onEvent: () => {},
    onStatus: status => statuses.push(status.state),
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("no", { status: 500 });
      return sse(["event: hello\ndata: {\"epoch\":\"e\",\"streamId\":\"s\",\"bootstrap\":{\"home\":\"/\",\"threadStarts\":[],\"environmentId\":\"local\"}}\n\n"]);
    },
  });
  client.start();
  await settle();
  expect(statuses).toEqual(["connecting", "offline"]);
  client.reconnect();
  await settle();
  client.stop();
  expect(attempts).toBe(2);
  expect(client.state()).toBe("open");
});

test("remembering a cursor changes the next connection without a request", async () => {
  const bodies: any[] = [];
  const client = createStreamClient({
    subscription: { session: "a" },
    listen: false,
    onEvent: () => {},
    onStatus: () => {},
    fetch: async (path, init) => {
      if (path === "/v1/stream") bodies.push(JSON.parse(String(init.body)));
      return sse(["event: hello\ndata: {\"epoch\":\"e\",\"streamId\":\"s\",\"bootstrap\":{\"home\":\"/\",\"threadStarts\":[],\"environmentId\":\"local\"}}\n\n"]);
    },
  });
  client.start();
  await settle();
  client.remember({ transcript: { generation: "g1", after: 42 } });
  expect(bodies).toHaveLength(1);
  client.reconnect();
  await settle();
  client.stop();
  expect(bodies[1]).toEqual({ session: "a", transcript: { generation: "g1", after: 42 } });
});
