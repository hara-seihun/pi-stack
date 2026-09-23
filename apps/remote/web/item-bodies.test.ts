import { expect, test } from "bun:test";
import type { TranscriptItemBody, TranscriptItemHead } from "../server/protocol";
import { ItemBodies } from "./src/features/conversation/item-bodies";
import { ClientCache } from "./src/client-cache";

const call = (seq: number, body?: TranscriptItemBody): TranscriptItemHead => ({
  seq, id: `call-${seq}`, kind: "toolCall", size: 900, callId: `c${seq}`, name: "edit",
  arguments: { path: "/a.ts", editCount: 2 }, argumentsTruncated: true, ...(body ? { body } : {}),
});

const body: TranscriptItemBody = { kind: "toolCall", arguments: { path: "/a.ts", edits: [{ oldText: "a", newText: "b" }] }, result: { content: "done", isError: false } };

test("a head that carries its body renders complete without a request", async () => {
  let requests = 0;
  const bodies = new ItemBodies("thread", async () => { requests++; return body; }, new ClientCache(async () => "item-bodies-test"));
  let changes = 0;
  bodies.subscribe(() => { changes++; });

  bodies.accept([call(0), call(1, body)]);
  expect(bodies.get("call-1")).toEqual(body);
  expect(bodies.get("call-0")).toBeUndefined();
  expect(changes).toBe(1);

  // The step opening asks for what it already has: no request, no loading row.
  bodies.request("call-1", 900);
  expect(bodies.loading("call-1")).toBe(false);
  expect(await bodies.load("call-1")).toEqual(body);
  expect(requests).toBe(0);

  // The same body arriving again on a later update changes nothing.
  bodies.accept([call(1, body)]);
  expect(changes).toBe(1);

  // A head without a body still loads on demand.
  await bodies.load("call-0", 900);
  expect(requests).toBe(1);
  expect(bodies.get("call-0")).toEqual(body);
});
