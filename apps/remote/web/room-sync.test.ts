import { expect, test } from "bun:test";
import { RoomRevisionFeed, RoomResource, RoomResourceError } from "./src/room-sync";
import { ReconcilePublisher } from "../shared/reconcile";

const frame = { cursor: "one", directory: "directory-one", rooms: {} };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("one shared revision connection suspends hidden work, resumes with a cursor, and ignores unchanged frames", async () => {
  let visible = true;
  let visibility!: () => void;
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const requests: { path: string; signal: AbortSignal }[] = [];
  const feed = new RoomRevisionFeed({
    fetch: async (path, signal) => {
      requests.push({ path, signal });
      const body = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; signal.addEventListener("abort", () => controller.close(), { once: true }); } });
      return new Response(body);
    },
    visible: () => visible,
    visibility: listener => { visibility = listener; return () => {}; },
  });
  const events: unknown[] = [];
  const a = feed.subscribe(event => events.push(event));
  const b = feed.subscribe(() => {});
  await flush();
  expect(requests.length).toBe(1);
  sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
  await flush();
  sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
  await flush();
  expect(events.filter((event: any) => event.type === "revisions").length).toBe(1);
  visible = false; visibility();
  expect(requests[0]!.signal.aborted).toBe(true);
  visibility(); await flush();
  expect(requests.length).toBe(1);
  visible = true; visibility(); await flush();
  expect(requests[1]!.path).toBe("/v1/rooms/changes?cursor=one");
  a(); expect(requests[1]!.signal.aborted).toBe(false);
  b(); expect(requests[1]!.signal.aborted).toBe(true);
});

test("selected room bodies reconcile append-only changes and serialize local refreshes", async () => {
  const publisher = new ReconcilePublisher();
  const resource = "/v1/rooms/" + "a".repeat(36);
  let value = { messages: [{ id: "1", text: "x".repeat(10_000) }], live: "" };
  const responses: string[] = [];
  const client = new RoomResource<typeof value>(resource, async path => {
    const url = new URL(path, "http://fixture");
    publisher.publish(resource, value);
    const change = publisher.reconcile(resource, url.searchParams.get("have"));
    if (!change) return new Response(null, { status: 304 });
    responses.push(JSON.stringify(change));
    return Response.json(change);
  });
  expect(await client.read()).toEqual(value);
  expect(await client.read()).toBeNull();
  value = { ...value, live: "a token" };
  await Promise.all([client.read(), client.read()]);
  expect(JSON.parse(responses[1]!).kind).toBe("patch");
  expect(responses[1]!.length).toBeLessThan(400);
  expect(responses.length).toBe(2);
});

test("aborted and revoked room responses cannot seed the body owner", async () => {
  const publisher = new ReconcilePublisher();
  const path = "/v1/rooms/" + "a".repeat(36);
  const controller = new AbortController();
  let denied = false;
  const requests: string[] = [];
  const client = new RoomResource(path, async url => {
    requests.push(url);
    if (denied) return new Response(null, { status: 404 });
    publisher.publish(path, { messages: [] });
    controller.abort();
    return Response.json(publisher.reconcile(path, null));
  });
  expect(await client.read(controller.signal)).toBeNull();
  denied = true;
  await expect(client.read()).rejects.toBeInstanceOf(RoomResourceError);
  expect(requests.every(url => !url.includes("have="))).toBe(true);
});
