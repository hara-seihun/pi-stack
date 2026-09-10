import { expect, test } from "bun:test";
import type { MeetJoined } from "../server/meet/protocol";
import { MeetRoom } from "./src/meet/room";
import { meetJson, type MeetRequest } from "./src/meet/transport";

const participant = { id: "host", name: "Mixed meeting audio", host: true };
const joined: MeetJoined = {
  participant,
  room: { id: "room", sessionId: "thread", apiUrl: "/v1/meet/room", iceServers: [], participants: [participant],
    browser: null, threads: [], voiceMuted: true, voiceRevision: 0, transcriptFlushRevision: 3 },
};

test("injected room transport preserves bytes and serves polling without person/native globals", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const request: MeetRequest = async (path, init) => {
    calls.push({ path, init });
    if (path.includes("/poll")) return Response.json({ ...joined.room, messages: [] });
    if (path.endsWith("/jpeg")) return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    return Response.json({ saved: true });
  };
  const room = new MeetRoom(joined, "must-not-be-an-injected-header", (snapshot) => {
    expect(snapshot.transcriptFlushRevision).toBe(3);
    room.close(false);
  }, () => {}, () => {}, (message) => { throw new Error(message); }, request);
  const pcm = new Int16Array([123, -456]).buffer;
  await room.json(room.path("/transcript/audio"), { method: "POST", headers: { "content-type": "audio/pcm" }, body: pcm });
  expect(calls[0]!.init.body).toBe(pcm);
  expect(new Headers(calls[0]!.init.headers).has("x-pi-remote-user")).toBe(false);
  expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  const frame = await room.request("/jpeg", {});
  expect(new Uint8Array(await frame.arrayBuffer())).toEqual(jpeg);
  await room.poll();
  expect(calls.at(-1)!.path).toBe("/v1/meet/room/poll?participant=host&after=0");
  expect(calls.some(({ path }) => path.includes("/leave"))).toBe(false);
});

test("relay HTTP failures retain non-JSON response detail", async () => {
  await expect(meetJson(async () => new Response("relay disconnected", { status: 502 }), "/v1/voice"))
    .rejects.toThrow("relay disconnected");
  expect(await meetJson(async () => new Response(null, { status: 204 }), "/stop")).toBeUndefined();
});
