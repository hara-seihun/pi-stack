import { expect, test } from "bun:test";
import { MeetServer } from "./meet/server";
import type { MeetBrowser } from "./meet/browser";

const request = (path: string, method = "GET", body?: unknown) => new Request(`http://127.0.0.1:18790/v1/meet${path}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

test("external participation has no native room creation or participant signaling", async () => {
  const server = new MeetServer(id => id === "thread");
  try {
    expect((await server.handle(request("", "POST", { requestId: crypto.randomUUID(), sessionId: "thread", name: "Host" })))!.status).toBe(404);
    const host = server.openExternal(crypto.randomUUID(), "thread", "http://localhost/v1/meet", true);
    expect(() => server.openExternal(host.room.id, "another", "http://localhost/v1/meet", true)).toThrow("thread is unavailable");
    expect((await server.handle(request(`/${host.room.id}/signal?participant=${host.participant.id}`, "POST", {
      to: "guest", signal: { description: { type: "offer", sdp: "v=0\r\n" } },
    })))!.status).toBe(404);
    const poll = await (await server.handle(request(`/${host.room.id}/poll?participant=${host.participant.id}`)))!.json();
    expect(poll.participants).toEqual([host.participant]);
    expect(poll.iceServers).toBeUndefined();
    expect(poll.messages).toBeUndefined();
    const camera = await (await server.handle(request(`/${host.room.id}/join`, "POST", { name: "Sara" })))!.json();
    expect((await server.handle(request(`/${host.room.id}/transcript/audio?participant=${camera.participant.id}`, "POST", {})))!.status).toBe(403);
    expect((await server.handle(request(`/${host.room.id}/transcript/audio?participant=${host.participant.id}`, "POST", {})))!.status).toBe(409);
    const local = server.openExternal(crypto.randomUUID(), "thread", "http://localhost/v1/meet", false);
    expect((await server.handle(request(`/${local.room.id}/transcript/audio?participant=${local.participant.id}&speaker=other`, "POST", {})))!.status).toBe(403);
  } finally { await server.close(); }
});

test("external host loss during shared-browser startup disposes the candidate", async () => {
  let ready!: (value: { ok: true; value: MeetBrowser }) => void;
  let closed = 0;
  const browser = { close: async () => { closed++; } } as unknown as MeetBrowser;
  const server = new MeetServer(() => true, () => new Promise(resolve => { ready = resolve; }));
  try {
    const host = server.openExternal(crypto.randomUUID(), "thread", "http://localhost/v1/meet", true);
    const root = `/${host.room.id}`;
    const query = `?participant=${host.participant.id}`;
    const opening = server.handle(request(`${root}/browser${query}`, "POST", { requested: true }));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    server.stopExternal(host.room.id);
    ready({ ok: true, value: browser });
    expect((await opening)!.status).toBe(503);
    expect(closed).toBe(1);
    expect(server.isLive(host.room.id)).toBe(false);
    expect((await server.handle(request(`${root}/poll${query}`)))!.status).toBe(404);
  } finally { await server.close(); }
});
